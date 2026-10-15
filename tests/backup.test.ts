// ADR 0090: online SQLite backups (node:sqlite backup API), encryption under the PHI keyring,
// restore with integrity verification, tamper and wrong-key refusal, pruning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, one, run } from '../server/db/db.ts';
import { seed } from '../server/services/seed.ts';
import { backupNow, restoreBackup, listBackups, integrityCheck } from '../server/ops/backup.ts';

// Synthetic test keys, never real secrets.
const K1 = Buffer.alloc(32, 1).toString('base64');
const K2 = Buffer.alloc(32, 2).toString('base64');
const RING1 = { AR_PHI_KEYS: `k1:${K1}`, AR_PHI_ACTIVE_KEY_ID: 'k1' };
const MARKER = 'SYNTHETIC-BACKUP-MARKER-0090';

function liveDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ar-bk-'));
  const db = openDb(join(dir, 'live.db'));
  seed(db);
  run(db, 'INSERT INTO tenants VALUES (?,?)', 'tn_marker', MARKER);
  return { dir, db };
}
const count = (path: string, table: string) => { const d = new DatabaseSync(path, { readOnly: true }); try { return (d.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n; } finally { d.close(); } };

test('encrypted online backup while the database is open, restore and verify integrity', async () => {
  const { dir, db } = liveDb();
  const r = await backupNow(db, { dir: join(dir, 'backups'), encrypt: true, keep: 5, env: RING1 });
  assert.equal(r.integrity, 'ok');
  assert.equal(r.encryptedWith, 'k1');
  assert.ok(r.file.endsWith('.arbk'));
  assert.ok(r.pages > 0);
  const raw = readFileSync(r.file);
  assert.ok(raw.subarray(0, 6).toString() === 'ARBK1\n');
  assert.ok(!raw.includes(Buffer.from(MARKER)), 'content is not readable in the backup file');
  assert.ok(!raw.includes(Buffer.from('SQLite format 3')), 'not a plaintext SQLite file');
  // The app keeps writing after the backup: the restore reflects the snapshot.
  run(db, 'INSERT INTO tenants VALUES (?,?)', 'tn_after', 'written after backup');
  const target = join(dir, 'restored.db');
  const out = await restoreBackup(r.file, target, { env: RING1 });
  assert.equal(out.integrity, 'ok');
  assert.equal(integrityCheck(target), 'ok');
  const restored = new DatabaseSync(target, { readOnly: true });
  assert.equal((restored.prepare("SELECT name FROM tenants WHERE tenant_id='tn_marker'").get() as { name: string }).name, MARKER);
  assert.equal(restored.prepare("SELECT 1 FROM tenants WHERE tenant_id='tn_after'").get(), undefined);
  restored.close();
  for (const t of ['users', 'grants', 'rule_versions', 'schema_migrations']) assert.equal(count(target, t), (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n, t);
  assert.equal(one<{ status: string }>(db, 'SELECT status FROM backup_runs WHERE backup_id=?', r.backupId)!.status, 'completed');
  // The restored database opens with the application's migrator and is usable.
  const reopened = openDb(target);
  assert.ok(one(reopened, "SELECT 1 FROM tenants WHERE tenant_id='tn_marker'"));
  reopened.close();
  db.close();
});

test('restore refuses: tampered file, wrong or missing key, existing target without --force; force keeps the old file aside', async () => {
  const { dir, db } = liveDb();
  const r = await backupNow(db, { dir: join(dir, 'b'), encrypt: true, env: RING1 });
  // Wrong key material under the same id.
  await assert.rejects(restoreBackup(r.file, join(dir, 'x1.db'), { env: { AR_PHI_KEYS: `k1:${K2}`, AR_PHI_ACTIVE_KEY_ID: 'k1' } }), /failed authentication/);
  // Key retired and removed from the ring.
  await assert.rejects(restoreBackup(r.file, join(dir, 'x2.db'), { env: { AR_PHI_KEYS: `k2:${K2}`, AR_PHI_ACTIVE_KEY_ID: 'k2' } }), /not in AR_PHI_KEYS/);
  // After rotation the old key stays in the ring: the old backup still restores.
  const rotated = await restoreBackup(r.file, join(dir, 'x3.db'), { env: { AR_PHI_KEYS: `k1:${K1},k2:${K2}`, AR_PHI_ACTIVE_KEY_ID: 'k2' } });
  assert.equal(rotated.encryptedWith, 'k1');
  // Tampering: flip one ciphertext byte; with and without the manifest.
  const bytes = readFileSync(r.file);
  bytes[bytes.length - 100] ^= 0xff;
  const tampered = join(dir, 'b', 'tampered.arbk');
  writeFileSync(tampered, bytes);
  await assert.rejects(restoreBackup(tampered, join(dir, 'x4.db'), { env: RING1 }), /failed authentication/);
  writeFileSync(r.file + '.tmpcopy', bytes);
  writeFileSync(r.file, bytes);
  await assert.rejects(restoreBackup(r.file, join(dir, 'x5.db'), { env: RING1 }), /does not match its manifest/);
  assert.ok(!existsSync(join(dir, 'x4.db')) && !existsSync(join(dir, 'x5.db')), 'nothing is written on failure');
  // Existing target.
  const good = await backupNow(db, { dir: join(dir, 'c'), encrypt: true, env: RING1 });
  const target = join(dir, 'x3.db');
  await assert.rejects(restoreBackup(good.file, target, { env: RING1 }), /pass --force/);
  const forced = await restoreBackup(good.file, target, { env: RING1, force: true });
  assert.ok(forced.movedAside && existsSync(forced.movedAside));
  db.close();
});

test('unencrypted backups (synthetic only) and pruning to the configured count', async () => {
  const { dir, db } = liveDb();
  const bdir = join(dir, 'plain');
  const files: string[] = [];
  for (let i = 0; i < 4; i++) files.push((await backupNow(db, { dir: bdir, encrypt: false, keep: 2 })).file);
  const kept = listBackups(bdir);
  assert.equal(kept.length, 2);
  assert.ok(readdirSync(bdir).filter((f) => f.endsWith('.json')).length === 2, 'manifests pruned with their backups');
  assert.deepEqual(readdirSync(bdir).filter((f) => !f.startsWith('ar-resolve-')), [], 'no staging files or -wal/-shm sidecars left behind');
  assert.equal(readFileSync(files[3]).subarray(0, 15).toString(), 'SQLite format 3');
  const out = await restoreBackup(files[3], join(dir, 'p.db'));
  assert.equal(out.encryptedWith, null);
  // Encryption on without a key fails and records the failure.
  await assert.rejects(backupNow(db, { dir: bdir, encrypt: true, env: {} }), /no active PHI key/);
  assert.ok(one(db, "SELECT 1 FROM backup_runs WHERE status='failed'"));
  db.close();
});

test('a non-AR-Resolve SQLite file is refused at restore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-bk-'));
  const other = join(dir, 'ar-resolve-other.db');
  const d = new DatabaseSync(other);
  d.exec('CREATE TABLE t (x)');
  d.close();
  await assert.rejects(restoreBackup(other, join(dir, 'y.db')), /no such table: schema_migrations/);
  const empty = join(dir, 'ar-resolve-empty.db');
  const e = new DatabaseSync(empty);
  e.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  e.close();
  await assert.rejects(restoreBackup(empty, join(dir, 'z.db')), /no applied migrations/);
  assert.ok(!existsSync(join(dir, 'z.db')));
});
