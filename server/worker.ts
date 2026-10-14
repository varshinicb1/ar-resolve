// Standalone outbox worker process. Safe to run alongside the API: claims are
// conditional updates under BEGIN IMMEDIATE, and dispatch leases expire into
// 'uncertain' for read-back reconciliation if this process dies mid-call.
//
// ADR 0090: validated configuration, structured logs, scheduled backups and graceful shutdown
// (SIGTERM stops the loop after the item in progress, then closes the database).
import { openDb } from './db/db.ts';
import { tick } from './services/outbox.ts';
import { recoverCalls, voiceTick } from './services/voice/engine.ts';
import { startupProblems } from './services/governance.ts';
import { deliverDue } from './services/notifications.ts';
import { governanceTick } from './services/governance-worker.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { createLogger, setLogger } from './log.ts';
import { backupLoop, createLoop, installShutdown, seedFor, sessionPurgeLoop } from './runtime.ts';

let cfg: Config;
try { cfg = loadConfig(); } catch (e) {
  if (e instanceof ConfigError) { console.error(e.message); process.exit(78); }
  throw e;
}
const logger = createLogger({ level: cfg.logLevel, base: { service: 'ar-resolve-worker', env: cfg.env } });
setLogger(logger);

const phiProblems = startupProblems();
if (phiProblems.length) { logger.error('startup_refused', { problems: phiProblems }); console.error(`Refusing to start: ${phiProblems.join('; ')}`); process.exit(78); }

const db = openDb(cfg.dbPath);
seedFor(db, cfg);
const once = process.argv.includes('--once');
recoverCalls(db);
const run = async () => {
  const g = governanceTick(db); // ADR 0080: PHI re-encryption batches and retention purge
  const r = { ...tick(db), voice: voiceTick(db).stepped, notifications: (await deliverDue(db)).delivered, rekeyJobs: g.rekeyJobs, retention: g.retentionChanged };
  if (once || Object.values(r).some((n) => n > 0)) logger.info('worker_tick', r);
};
if (once) {
  await run();
  db.close();
} else {
  logger.info('worker_started', { intervalMs: cfg.workerIntervals.outboxMs, backups: cfg.backup.intervalMinutes > 0 && !!cfg.backup.dir });
  const loop = createLoop('worker', cfg.workerIntervals.outboxMs, run, logger);
  loop.step();
  const purge = sessionPurgeLoop(db, logger);
  const stops: (() => unknown)[] = [() => loop.stop(), () => purge.stop()];
  const backups = backupLoop(db, cfg, logger);
  if (backups) stops.push(backups);
  installShutdown({ stops, db, cfg, logger });
}
