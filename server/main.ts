import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db/db.ts';
import { createApp, DEFAULT_STATIC } from './http/app.ts';
import { startWorker } from './services/outbox.ts';
import { startVoiceWorker } from './services/voice/engine.ts';
import { startupProblems } from './services/governance.ts';
import { deliverDue } from './services/notifications.ts';
import { startGovernanceWorker } from './services/governance-worker.ts';
import { ConfigError, describeConfig, loadConfig, type Config } from './config.ts';
import { createLogger, setLogger } from './log.ts';
import { backupLoop, createLoop, installShutdown, seedFor, sessionPurgeLoop } from './runtime.ts';

// ADR 0090: validated configuration first. Staging and production refuse to start on any problem.
let cfg: Config;
try { cfg = loadConfig(); } catch (e) {
  if (e instanceof ConfigError) { console.error(e.message); process.exit(78); }
  throw e;
}
const logger = createLogger({ level: cfg.logLevel, base: { service: 'ar-resolve-api', env: cfg.env } });
setLogger(logger);

// PHI gate (ADR 0070): AR_PHI_MODE=on refuses to start unless the deployment-level safeguards exist.
const phiProblems = startupProblems();
if (phiProblems.length) {
  logger.error('startup_refused', { problems: phiProblems });
  console.error(`Refusing to start: ${phiProblems.join('; ')}`);
  process.exit(78);
}

mkdirSync(dirname(cfg.dbPath), { recursive: true });
const db = openDb(cfg.dbPath);
seedFor(db, cfg);
const server = createApp(db, { staticDir: DEFAULT_STATIC, config: cfg, logger });
server.listen(cfg.port, () => {
  logger.info('startup', { message: `AR Resolve (${cfg.env.toUpperCase()} environment) listening on port ${cfg.port}`, config: describeConfig(cfg) });
});

const stops: (() => unknown)[] = [];
if (cfg.embeddedWorker) {
  stops.push(startWorker(db, cfg.workerIntervals.outboxMs));
  stops.push(startVoiceWorker(db));
  const notify = createLoop('notifications', cfg.workerIntervals.notifyMs, () => deliverDue(db), logger);
  stops.push(() => notify.stop());
  stops.push(startGovernanceWorker(db, cfg.workerIntervals.governanceMs)); // ADR 0080
  const purge = sessionPurgeLoop(db, logger);
  stops.push(() => purge.stop());
  const backups = backupLoop(db, cfg, logger);
  if (backups) stops.push(backups);
}
installShutdown({ server, stops, db, cfg, logger });
