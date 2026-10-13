// Standalone outbox worker process. Safe to run alongside the API: claims are
// conditional updates under BEGIN IMMEDIATE, and dispatch leases expire into
// 'uncertain' for read-back reconciliation if this process dies mid-call.
import { openDb } from './db/db.ts';
import { seed } from './services/seed.ts';
import { tick } from './services/outbox.ts';
import { recoverCalls, voiceTick } from './services/voice/engine.ts';
import { startupProblems } from './services/governance.ts';
import { deliverDue } from './services/notifications.ts';
import { governanceTick } from './services/governance-worker.ts';

const phiProblems = startupProblems();
if (phiProblems.length) { console.error(`Refusing to start: ${phiProblems.join('; ')}`); process.exit(78); }

const db = openDb(process.env.AR_DB ?? 'data/ar-resolve.db');
seed(db);
const once = process.argv.includes('--once');
recoverCalls(db);
const run = async () => {
  const g = governanceTick(db); // ADR 0080: PHI re-encryption batches and retention purge
  const r = { ...tick(db), voice: voiceTick(db).stepped, notifications: (await deliverDue(db)).delivered, rekeyJobs: g.rekeyJobs, retention: g.retentionChanged };
  if (once || Object.values(r).some((n) => n > 0)) console.log(new Date().toISOString(), JSON.stringify(r));
};
run();
if (!once) setInterval(run, Number(process.env.AR_WORKER_INTERVAL_MS ?? 1500));
