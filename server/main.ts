import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db/db.ts';
import { seed } from './services/seed.ts';
import { createApp, DEFAULT_STATIC } from './http/app.ts';
import { startWorker } from './services/outbox.ts';
import { startVoiceWorker } from './services/voice/engine.ts';
import { startupProblems } from './services/governance.ts';
import { startNotificationWorker } from './services/notifications.ts';
import { startGovernanceWorker } from './services/governance-worker.ts';

// PHI gate (ADR 0070): AR_PHI_MODE=on refuses to start unless the deployment-level safeguards exist.
const phiProblems = startupProblems();
if (phiProblems.length) {
  console.error(`Refusing to start: ${phiProblems.join('; ')}`);
  process.exit(78);
}

const dbPath = process.env.AR_DB ?? 'data/ar-resolve.db';
const port = Number(process.env.PORT ?? 8080);
const embeddedWorker = process.env.AR_WORKER !== 'off';

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
seed(db);
const server = createApp(db, { staticDir: DEFAULT_STATIC });
server.listen(port, () => {
  console.log(`AR Resolve (SYNTHETIC environment, live actions disabled) on http://localhost:${port}`);
  console.log(`database: ${dbPath}; embedded outbox worker: ${embeddedWorker ? 'on' : 'off'}`);
});
if (embeddedWorker) startWorker(db, Number(process.env.AR_WORKER_INTERVAL_MS ?? 1500));
if (embeddedWorker) startVoiceWorker(db);
if (embeddedWorker) startNotificationWorker(db, Number(process.env.AR_NOTIFY_INTERVAL_MS ?? 5000));
if (embeddedWorker) startGovernanceWorker(db, Number(process.env.AR_GOVERNANCE_INTERVAL_MS ?? 5000)); // ADR 0080
