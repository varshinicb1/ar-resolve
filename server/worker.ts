// Standalone outbox worker process. Safe to run alongside the API: claims are
// conditional updates under BEGIN IMMEDIATE, and dispatch leases expire into
// 'uncertain' for read-back reconciliation if this process dies mid-call.
import { openDb } from './db/db.ts';
import { seed } from './services/seed.ts';
import { tick } from './services/outbox.ts';
import { recoverCalls, voiceTick } from './services/voice/engine.ts';

const db = openDb(process.env.AR_DB ?? 'data/ar-resolve.db');
seed(db);
const once = process.argv.includes('--once');
recoverCalls(db);
const run = () => {
  const r = { ...tick(db), voice: voiceTick(db).stepped };
  if (once || Object.values(r).some((n) => n > 0)) console.log(new Date().toISOString(), JSON.stringify(r));
};
run();
if (!once) setInterval(run, Number(process.env.AR_WORKER_INTERVAL_MS ?? 1500));
