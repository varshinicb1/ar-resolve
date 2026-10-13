// PHI key rotation (ADR 0080): keyring status, a resumable re-encryption job and key retirement.
//
// The keyring itself is deployment configuration (phi.ts: AR_PHI_KEYS + AR_PHI_ACTIVE_KEY_ID);
// keys never enter the database. This module rewrites sealed values to the active key:
//   - one job per tenant/client at a time (phi_rekey_jobs), advanced in batches by the worker or on
//     demand; each column is walked by rowid with the cursor saved after every batch, so a crash or
//     restart resumes where it stopped and never re-encrypts a value twice in one pass;
//   - every rewrite opens the old value, seals it under the active key, checks the new value opens
//     to the same plaintext (proposal payloads: to the recorded payload hash) and only then writes it,
//     through a permit for immutable tables (sealed-store.ts);
//   - each batch and the completion are audited with counts per column (no content);
//   - retirement of a key is refused while any sealed value in any scope still names it, and the
//     active key can never be retired.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { AppError, canonicalJson, conflict, hashJson, invalid, newId, notFound, nowIso } from '../util.ts';
import { audit } from './audit.ts';
import { requirePerm, type Scope } from './auth.ts';
import { open, phiKeyring, seal, sealedKeyId, type Keyring } from './phi.ts';
import { SEALED_COLUMNS, keyUsage, openPayload, payloadKeyIds, rewrite, sealPayload, type SealedColumn } from './sealed-store.ts';

export const REKEY_VERSION = 'phi-rekey.v1';
export const DEFAULT_BATCH = 200;

interface JobRow { tenant_id: string; client_id: string; job_id: string; target_key_id: string; state: string; batch_size: number; batches: number; rewritten: number; counts: string;
  last_error: string | null; started_by: string; started_at: string; updated_at: string; finished_at: string | null }
interface Progress { cursors: Record<string, number>; rewritten: Record<string, number>; skipped: Record<string, number> }

const jobView = (r: JobRow) => ({ jobId: r.job_id, targetKeyId: r.target_key_id, state: r.state, batchSize: r.batch_size, batches: r.batches, rewritten: r.rewritten,
  progress: JSON.parse(r.counts) as Progress, lastError: r.last_error, startedBy: r.started_by, startedAt: r.started_at, updatedAt: r.updated_at, finishedAt: r.finished_at });

function ringOrThrow(): Keyring {
  let ring: Keyring;
  try { ring = phiKeyring(); } catch (e) { throw new AppError(409, 'keyring_invalid', (e as Error).message); }
  if (!ring.activeId) throw new AppError(409, 'no_active_key', 'No PHI key is configured; there is nothing to re-encrypt to (set AR_PHI_KEYS and AR_PHI_ACTIVE_KEY_ID)');
  return ring;
}

/** Key ids per sealed column for one scope (or the whole deployment), plus the configured ring. */
export function keyStatus(db: Db, scope: Scope) {
  requirePerm(scope, 'manage_phi_keys');
  let ring: { activeId: string | null; keyIds: string[]; error: string | null };
  try { const r = phiKeyring(); ring = { activeId: r.activeId, keyIds: [...r.keys.keys()].sort(), error: null }; } catch (e) { ring = { activeId: null, keyIds: [], error: (e as Error).message }; }
  const usage = SEALED_COLUMNS.map((c) => ({ column: c.id, byKey: keyUsage(db, c, scope) }));
  const totals: Record<string, number> = {};
  for (const u of usage) for (const [k, n] of Object.entries(u.byKey)) totals[k] = (totals[k] ?? 0) + n;
  return {
    version: REKEY_VERSION, ring, usage, totals,
    retired: all<{ key_id: string; retired_by: string; retired_at: string; reason: string }>(db, 'SELECT key_id, retired_by, retired_at, reason FROM phi_key_retirements ORDER BY retired_at DESC'),
    jobs: all<JobRow>(db, 'SELECT * FROM phi_rekey_jobs WHERE tenant_id=? AND client_id=? ORDER BY started_at DESC LIMIT 10', scope.tenantId, scope.clientId).map(jobView),
    note: 'Keys live only in deployment configuration (AR_PHI_KEYS). Counts are sealed values in this client; retirement checks every client.',
  };
}

export function startRekey(db: Db, scope: Scope, body: { batchSize?: unknown } = {}) {
  requirePerm(scope, 'manage_phi_keys');
  const ring = ringOrThrow();
  const batch = body.batchSize === undefined ? DEFAULT_BATCH : Number(body.batchSize);
  if (!Number.isInteger(batch) || batch < 1 || batch > 5000) throw invalid('batchSize must be 1-5000');
  return tx(db, () => {
    const running = one<JobRow>(db, "SELECT * FROM phi_rekey_jobs WHERE tenant_id=? AND client_id=? AND state='running'", scope.tenantId, scope.clientId);
    if (running) return { ...jobView(running), resumed: true };
    const jobId = newId('rekey');
    const progress: Progress = { cursors: {}, rewritten: {}, skipped: {} };
    run(db, 'INSERT INTO phi_rekey_jobs (tenant_id, client_id, job_id, target_key_id, state, batch_size, counts, started_by, started_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      scope.tenantId, scope.clientId, jobId, ring.activeId, 'running', batch, canonicalJson(progress), scope.userId, nowIso(), nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'phi_rekey_job', objectId: jobId, eventType: 'phi_rekey_started', details: { targetKeyId: ring.activeId, batchSize: batch } });
    return { ...jobView(one<JobRow>(db, 'SELECT * FROM phi_rekey_jobs WHERE tenant_id=? AND client_id=? AND job_id=?', scope.tenantId, scope.clientId, jobId)!), resumed: false };
  });
}

/** Re-encrypt one stored value to the active key; returns the new value or null if already current. */
function resealValue(col: SealedColumn, stored: string, ring: Keyring, payloadSha256?: string): string | null {
  const active = ring.activeId!;
  if (col.json) {
    const ids = payloadKeyIds(stored);
    if (!ids.length || ids.every((k) => k === active)) return null;
    const plain = openPayload(stored, ring);
    if (payloadSha256 && hashJson(plain) !== payloadSha256) throw new Error('payload does not match its recorded hash; refusing to re-encrypt');
    const next = sealPayload(plain, ring);
    if (hashJson(openPayload(next, ring)) !== hashJson(plain)) throw new Error('re-encrypted payload does not open to the same plaintext');
    return next;
  }
  if (sealedKeyId(stored) === active) return null;
  const plain = open(stored, ring);
  const next = seal(plain, ring);
  if (open(next, ring) !== plain) throw new Error('re-encrypted value does not open to the same plaintext');
  return next;
}

/** One batch of one job. Returns the job after the batch. Safe to call repeatedly; resumes from saved cursors. */
export function rekeyBatch(db: Db, tenantId: string, clientId: string, jobId: string) {
  const job = one<JobRow>(db, 'SELECT * FROM phi_rekey_jobs WHERE tenant_id=? AND client_id=? AND job_id=?', tenantId, clientId, jobId);
  if (!job) throw notFound('Re-encryption job');
  if (job.state !== 'running') return jobView(job);
  let ring: Keyring;
  try { ring = ringOrThrow(); } catch (e) { return failJob(db, job, (e as Error).message); }
  if (ring.activeId !== job.target_key_id) return failJob(db, job, `The active key changed from ${job.target_key_id} to ${ring.activeId}; start a new job`);
  const progress = JSON.parse(job.counts) as Progress;
  let budget = job.batch_size;
  const batchCounts: Record<string, number> = {};
  try {
    tx(db, () => {
      for (const col of SEALED_COLUMNS) {
        if (budget <= 0) break;
        const cursor = progress.cursors[col.id] ?? 0;
        if (cursor < 0) continue; // column finished
        const extra = col.id === 'proposed_actions.payload' ? ', payload_sha256' : '';
        const like = col.json ? '%"enc:v%' : 'enc:v%';
        const want = budget;
        const rows = all<Record<string, any>>(db, `SELECT rowid AS _rowid, ${col.key.join(', ')}, ${col.column} AS _v${extra} FROM ${col.table}
          WHERE tenant_id=? AND client_id=? AND rowid > ? AND ${col.column} LIKE ? ORDER BY rowid LIMIT ?`, tenantId, clientId, cursor, like, want);
        for (const r of rows) {
          const next = resealValue(col, r._v, ring, r.payload_sha256);
          if (next !== null) {
            if (rewrite(db, col, r, r._v, next, 'reseal')) { progress.rewritten[col.id] = (progress.rewritten[col.id] ?? 0) + 1; batchCounts[col.id] = (batchCounts[col.id] ?? 0) + 1; }
            else progress.skipped[col.id] = (progress.skipped[col.id] ?? 0) + 1;
          }
          progress.cursors[col.id] = r._rowid;
          budget--;
        }
        if (rows.length < want) progress.cursors[col.id] = -1; // fewer rows than asked: column done
      }
      const done = SEALED_COLUMNS.every((c) => progress.cursors[c.id] === -1);
      const rewritten = Object.values(batchCounts).reduce((a, b) => a + b, 0);
      run(db, `UPDATE phi_rekey_jobs SET batches=batches+1, rewritten=rewritten+?, counts=?, updated_at=?, state=?, finished_at=? WHERE tenant_id=? AND client_id=? AND job_id=? AND state='running'`,
        rewritten, canonicalJson(progress), nowIso(), done ? 'completed' : 'running', done ? nowIso() : null, tenantId, clientId, jobId);
      audit(db, { tenantId, clientId, actorId: 'system:phi-rekey', objectType: 'phi_rekey_job', objectId: jobId, eventType: done ? 'phi_rekey_completed' : 'phi_rekey_batch',
        details: { targetKeyId: job.target_key_id, batch: job.batches + 1, rewritten: batchCounts, totalRewritten: job.rewritten + rewritten } });
    });
  } catch (e) {
    return failJob(db, job, (e as Error).message);
  }
  return jobView(one<JobRow>(db, 'SELECT * FROM phi_rekey_jobs WHERE tenant_id=? AND client_id=? AND job_id=?', tenantId, clientId, jobId)!);
}

function failJob(db: Db, job: JobRow, message: string) {
  tx(db, () => {
    run(db, "UPDATE phi_rekey_jobs SET state='failed', last_error=?, updated_at=?, finished_at=? WHERE tenant_id=? AND client_id=? AND job_id=?", message.slice(0, 500), nowIso(), nowIso(), job.tenant_id, job.client_id, job.job_id);
    audit(db, { tenantId: job.tenant_id, clientId: job.client_id, actorId: 'system:phi-rekey', objectType: 'phi_rekey_job', objectId: job.job_id, eventType: 'phi_rekey_failed', details: { error: message.slice(0, 200) } });
  });
  return jobView(one<JobRow>(db, 'SELECT * FROM phi_rekey_jobs WHERE tenant_id=? AND client_id=? AND job_id=?', job.tenant_id, job.client_id, job.job_id)!);
}

/** Run batches now (route and tests); the worker does the same one batch per tick. */
export function runRekey(db: Db, scope: Scope, jobId: string, maxBatches = 50) {
  requirePerm(scope, 'manage_phi_keys');
  let j = rekeyBatch(db, scope.tenantId, scope.clientId, jobId);
  for (let i = 1; i < maxBatches && j.state === 'running'; i++) j = rekeyBatch(db, scope.tenantId, scope.clientId, jobId);
  return j;
}

export function rekeyTick(db: Db): number {
  let n = 0;
  for (const j of all<JobRow>(db, "SELECT * FROM phi_rekey_jobs WHERE state='running' ORDER BY updated_at LIMIT 5")) { rekeyBatch(db, j.tenant_id, j.client_id, j.job_id); n++; }
  return n;
}

/** Deployment-wide count of sealed values that still name a key, per column. */
export function deploymentUsage(db: Db, keyId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of SEALED_COLUMNS) { const n = keyUsage(db, c)[keyId] ?? 0; if (n) out[c.id] = n; }
  return out;
}

export function retireKey(db: Db, scope: Scope, keyId: string, body: { reason?: unknown }) {
  requirePerm(scope, 'manage_phi_keys');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 10) throw invalid('A reason of at least 10 characters is required');
  let activeId: string | null = null;
  try { activeId = phiKeyring().activeId; } catch { /* an invalid ring cannot vouch for anything; the usage check still runs */ }
  if (keyId === activeId) throw conflict('key_active', 'The active key cannot be retired; activate another key and re-encrypt first');
  // The refusal is audited outside the transaction (a throw inside it would roll the audit back).
  const refused = tx(db, () => {
    if (one(db, 'SELECT 1 FROM phi_key_retirements WHERE key_id=?', keyId)) throw conflict('already_retired', 'This key is already retired');
    const usage = deploymentUsage(db, keyId);
    const total = Object.values(usage).reduce((a, b) => a + b, 0);
    if (total > 0) {
      audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'phi_key', objectId: keyId, eventType: 'phi_key_retire_refused', details: { remaining: total, usage } });
      return { total, usage };
    }
    run(db, 'INSERT INTO phi_key_retirements VALUES (?,?,?,?,?)', keyId, scope.userId, nowIso(), reason, canonicalJson({ checkedColumns: SEALED_COLUMNS.map((c) => c.id), remaining: 0 }));
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'phi_key', objectId: keyId, eventType: 'phi_key_retired',
      details: { reason, deploymentWide: true, next: 'Remove the key from AR_PHI_KEYS in deployment configuration' } });
    return null;
  });
  if (refused) throw new AppError(409, 'key_in_use', `${refused.total} sealed value(s) across the deployment still use key ${keyId}; run re-encryption in every client first`, { usage: refused.usage });
  return { keyId, retired: true, next: 'Remove the key from AR_PHI_KEYS in deployment configuration.' };
}
