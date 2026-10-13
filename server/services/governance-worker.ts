// Background jobs for ADR 0080: PHI re-encryption batches (every tick while a job runs) and the
// retention purge (at most once per AR_RETENTION_INTERVAL_MS, default one hour). Both are
// idempotent and resumable, so the embedded worker and the standalone worker may both run them.
import type { Db } from '../db/db.ts';
import { rekeyTick } from './phi-keys.ts';
import { retentionTick } from './retention.ts';

export function governanceTick(db: Db): { rekeyJobs: number; retentionChanged: number } {
  let rekeyJobs = 0;
  let retentionChanged = 0;
  try { rekeyJobs = rekeyTick(db); } catch (e) { console.error('[governance] rekey', (e as Error).message); }
  try { retentionChanged = retentionTick(db).changed; } catch (e) { console.error('[governance] retention', (e as Error).message); }
  return { rekeyJobs, retentionChanged };
}

export function startGovernanceWorker(db: Db, intervalMs = 5000): () => void {
  const t = setInterval(() => governanceTick(db), intervalMs);
  return () => clearInterval(t);
}
