// Online SQLite backups and restore (ADR 0090).
//
// Backup uses node:sqlite's backup() (the SQLite online backup API; added in Node v22.16.0, source:
// https://github.com/nodejs/node/blob/v22.x/doc/api/sqlite.md retrieved 2026-10-14). It copies a
// consistent snapshot page by page while the application keeps running (WAL mode).
//
// Each backup is checked before it is kept: the copy is opened read-only and must pass
// PRAGMA integrity_check. With encryption on (required outside synthetic) the file is sealed with
// AES-256-GCM under a key derived (HKDF-SHA256, per-file random salt, info "ar-resolve backup v1")
// from the ACTIVE PHI key. The header names the PHI key id and is bound as additional data, so a
// backup can be restored only while that key id is still in AR_PHI_KEYS (see docs/OPERATIONS.md:
// a retired PHI key must be kept in escrow until every backup sealed under it has expired).
//
// File format (.arbk):  "ARBK1\n" + JSON header + "\n" + ciphertext + 16-byte GCM tag
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { type Db, run } from '../db/db.ts';
import { phiKeyring } from '../services/phi.ts';
import { newId } from '../util.ts';

type Env = Record<string, string | undefined>;
const MAGIC = 'ARBK1\n';
const INFO = 'ar-resolve backup v1';
const PREFIX = 'ar-resolve-';

export interface BackupResult { backupId: string; file: string; bytes: number; sha256: string; encryptedWith: string | null; pages: number; integrity: 'ok' }

function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

export function integrityCheck(path: string): string {
  const d = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = d.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check).join('; ');
  } finally { d.close(); }
}

/** Turns a fresh copy into a self-contained file (rollback journal, no -wal/-shm sidecars). */
function detachCopy(path: string): void {
  const d = new DatabaseSync(path);
  try { d.exec('PRAGMA journal_mode = DELETE'); } finally { d.close(); }
}
const rmCopy = (path: string) => { for (const ext of ['', '-wal', '-shm', '-journal']) rmSync(path + ext, { force: true }); };

const deriveKey = (master: Buffer, salt: Buffer) => Buffer.from(hkdfSync('sha256', master, salt, INFO, 32));

async function encryptFile(src: string, dst: string, keyId: string, master: Buffer): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = JSON.stringify({ v: 1, alg: 'aes-256-gcm', kdf: 'hkdf-sha256', info: INFO, kid: keyId, salt: salt.toString('base64'), iv: iv.toString('base64') });
  const prefix = Buffer.from(MAGIC + header + '\n');
  const cipher = createCipheriv('aes-256-gcm', deriveKey(master, salt), iv);
  cipher.setAAD(prefix);
  const out = createWriteStream(dst, { mode: 0o600 });
  const write = async (b: Buffer) => { if (b.length && !out.write(b)) await once(out, 'drain'); };
  try {
    await write(prefix);
    for await (const chunk of createReadStream(src)) await write(cipher.update(chunk as Buffer));
    await write(cipher.final());
    await write(cipher.getAuthTag());
    await new Promise<void>((resolve, reject) => { out.on('error', reject); out.end(() => resolve()); });
  } catch (e) { out.destroy(); rmSync(dst, { force: true }); throw e; }
}

function readHeader(path: string): { header: any; prefixLen: number } | null {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const n = readSync(fd, buf, 0, 1024, 0);
    const s = buf.subarray(0, n).toString('latin1');
    if (!s.startsWith(MAGIC)) return null;
    const end = s.indexOf('\n', MAGIC.length);
    if (end < 0) throw new Error('Backup header is truncated');
    return { header: JSON.parse(s.slice(MAGIC.length, end)), prefixLen: end + 1 };
  } finally { closeSync(fd); }
}

async function decryptFile(src: string, dst: string, env: Env): Promise<string> {
  const h = readHeader(src);
  if (!h) throw new Error('Not an encrypted AR Resolve backup');
  const { header, prefixLen } = h;
  if (header.v !== 1 || header.alg !== 'aes-256-gcm' || header.info !== INFO) throw new Error('Unsupported backup format');
  const ring = phiKeyring(env);
  const master = ring.keys.get(header.kid);
  if (!master) throw new Error(`Backup was sealed with PHI key "${header.kid}", which is not in AR_PHI_KEYS; restore it from key escrow first`);
  const size = statSync(src).size;
  if (size < prefixLen + 16) throw new Error('Backup file is truncated');
  const tag = Buffer.alloc(16);
  const fd = openSync(src, 'r');
  try { readSync(fd, tag, 0, 16, size - 16); } finally { closeSync(fd); }
  const prefix = Buffer.alloc(prefixLen);
  const fd2 = openSync(src, 'r');
  try { readSync(fd2, prefix, 0, prefixLen, 0); } finally { closeSync(fd2); }
  const d = createDecipheriv('aes-256-gcm', deriveKey(master, Buffer.from(header.salt, 'base64')), Buffer.from(header.iv, 'base64'));
  d.setAAD(prefix);
  d.setAuthTag(tag);
  try {
    await pipeline(createReadStream(src, { start: prefixLen, end: size - 17 }), d, createWriteStream(dst, { mode: 0o600 }));
  } catch (e) {
    rmSync(dst, { force: true });
    throw new Error(`Backup failed authentication (tampered, truncated or wrong key): ${(e as Error).message}`);
  }
  return header.kid;
}

/** Takes an online backup into dir, verifies it, optionally encrypts it, records it and prunes old ones. */
export async function backupNow(db: Db, o: { dir: string; encrypt: boolean; keep?: number; env?: Env }): Promise<BackupResult> {
  const env = o.env ?? process.env;
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const backupId = newId('bak');
  const startedAt = new Date().toISOString();
  run(db, "INSERT INTO backup_runs (backup_id, started_at, status) VALUES (?,?,'running')", backupId, startedAt);
  const stamp = startedAt.replace(/[-:]/g, '').replace('.', '');
  const tmp = join(o.dir, `.tmp-${backupId}.db`);
  try {
    let keyId: string | null = null;
    let master: Buffer | null = null;
    if (o.encrypt) {
      const ring = phiKeyring(env);
      if (!ring.activeId) throw new Error('Backup encryption is on but no active PHI key is configured');
      keyId = ring.activeId;
      master = ring.keys.get(keyId)!;
    }
    const pages = await sqliteBackup(db, tmp);
    detachCopy(tmp);
    const integrity = integrityCheck(tmp);
    if (integrity !== 'ok') throw new Error(`Backup copy failed integrity_check: ${integrity.slice(0, 200)}`);
    const plainSha = await fileSha256(tmp);
    const file = join(o.dir, `${PREFIX}${stamp}-${backupId.slice(4, 10)}.${o.encrypt ? 'arbk' : 'db'}`);
    if (o.encrypt) { await encryptFile(tmp, file, keyId!, master!); rmCopy(tmp); }
    else renameSync(tmp, file);
    const sha = await fileSha256(file);
    const bytes = statSync(file).size;
    writeFileSync(file + '.json', JSON.stringify({ backupId, createdAt: startedAt, file: basename(file), bytes, sha256: sha, databaseSha256: plainSha, encryptedWith: keyId, pages, integrity }, null, 2) + '\n', { mode: 0o600 });
    run(db, "UPDATE backup_runs SET finished_at=?, file_name=?, bytes=?, sha256=?, encrypted_with=?, pages=?, status='completed' WHERE backup_id=?",
      new Date().toISOString(), basename(file), bytes, sha, keyId, pages, backupId);
    if (o.keep) pruneBackups(o.dir, o.keep);
    return { backupId, file, bytes, sha256: sha, encryptedWith: keyId, pages, integrity: 'ok' };
  } catch (e) {
    rmCopy(tmp);
    run(db, "UPDATE backup_runs SET finished_at=?, status='failed', error=? WHERE backup_id=?", new Date().toISOString(), String((e as Error).message).slice(0, 300), backupId);
    throw e;
  }
}

export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  // Oldest first: by modification time, then name (several backups can share a millisecond).
  return readdirSync(dir).filter((f) => f.startsWith(PREFIX) && /\.(db|arbk)$/.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t || a.f.localeCompare(b.f)).map((x) => x.f);
}

export function pruneBackups(dir: string, keep: number): string[] {
  const files = listBackups(dir);
  const drop = files.slice(0, Math.max(0, files.length - keep));
  for (const f of drop) { rmSync(join(dir, f), { force: true }); rmSync(join(dir, f + '.json'), { force: true }); }
  return drop;
}

/**
 * Restores a backup to targetPath. The application and worker must be stopped. The backup is
 * decrypted (if sealed) to a temporary file next to the target, its manifest digest checked when a
 * manifest exists, integrity_check must pass and schema_migrations must be present; only then is
 * an existing database moved aside (never deleted) and the restored file moved into place.
 */
export async function restoreBackup(file: string, targetPath: string, o: { force?: boolean; env?: Env } = {}) {
  const env = o.env ?? process.env;
  if (!existsSync(file)) throw new Error(`No such backup: ${file}`);
  const manifestPath = file + '.json';
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const sha = await fileSha256(file);
    if (m.sha256 !== sha) throw new Error('Backup file does not match its manifest digest');
  }
  if (existsSync(targetPath) && !o.force) throw new Error(`${targetPath} exists; stop the application and pass --force to replace it (the old file is kept aside)`);
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.restore-${randomBytes(4).toString('hex')}`;
  let keyId: string | null = null;
  try {
    if (readHeader(file)) keyId = await decryptFile(file, tmp, env);
    else { await pipeline(createReadStream(file), createWriteStream(tmp, { mode: 0o600 })); }
    const integrity = integrityCheck(tmp);
    if (integrity !== 'ok') throw new Error(`Restored copy failed integrity_check: ${integrity.slice(0, 200)}`);
    const d = new DatabaseSync(tmp, { readOnly: true });
    let migrations = 0;
    try { migrations = (d.prepare('SELECT count(*) n FROM schema_migrations').get() as { n: number }).n; } finally { d.close(); }
    if (!migrations) throw new Error('Restored copy has no applied migrations; not an AR Resolve database');
    let movedAside: string | null = null;
    if (existsSync(targetPath)) {
      movedAside = `${targetPath}.pre-restore-${new Date().toISOString().replace(/[-:.]/g, '')}`;
      renameSync(targetPath, movedAside);
    }
    for (const ext of ['-wal', '-shm']) rmSync(targetPath + ext, { force: true });
    renameSync(tmp, targetPath);
    for (const ext of ['-wal', '-shm']) rmSync(tmp + ext, { force: true });
    return { restored: targetPath, from: file, encryptedWith: keyId, integrity: 'ok' as const, migrations, movedAside };
  } catch (e) {
    rmCopy(tmp);
    throw e;
  }
}

/** Scheduled backups for the worker process. Returns a stop function that awaits a running backup. */
export function startBackupSchedule(db: Db, o: { dir: string; encrypt: boolean; keep: number; intervalMinutes: number; onResult: (r: BackupResult | Error) => void }) {
  let current: Promise<unknown> | null = null;
  const t = setInterval(() => {
    if (current) return;
    current = backupNow(db, o).then(o.onResult, (e) => o.onResult(e as Error)).finally(() => { current = null; });
  }, o.intervalMinutes * 60_000);
  t.unref?.();
  return async () => { clearInterval(t); if (current) await current; };
}
