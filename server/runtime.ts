// Process runtime shared by main.ts (API) and worker.ts (worker), ADR 0090: seeding by environment,
// worker loops that can be drained, and graceful shutdown.
import type { Server } from 'node:http';
import type { Db } from './db/db.ts';
import type { Config } from './config.ts';
import type { Logger } from './log.ts';
import { errorFields } from './log.ts';
import { seed } from './services/seed.ts';
import { seedRules } from './services/rules.ts';
import { seedOperations } from './services/ops-seed.ts';
import { tx } from './db/db.ts';
import { lifecycleOf } from './http/app.ts';
import { backupNow, startBackupSchedule, type BackupResult } from './ops/backup.ts';
import { purgeExpiredSessions } from './services/web-sessions.ts';

/**
 * Synthetic: the full demo seed (tenants, clients, development users, grants, rules, calendars).
 * Staging / production: reference data only (rule definitions, which load as drafts and never run
 * as a baseline there, plus reference calendars and the attribution rule). No users, no grants:
 * operators create those with scripts/admin.ts.
 */
export function seedFor(db: Db, cfg: Config): void {
  if (cfg.synthetic) return seed(db);
  tx(db, () => { seedRules(db); seedOperations(db); });
}

/** An interval loop whose stop() waits for the iteration in progress (sync or async) to finish. */
export function createLoop(name: string, intervalMs: number, fn: () => unknown, logger: Logger) {
  let current: Promise<unknown> | null = null;
  let stopped = false;
  const step = () => {
    if (current || stopped) return;
    current = Promise.resolve().then(fn).catch((e) => logger.error('worker_loop_error', { loop: name, ...errorFields(e, false) })).finally(() => { current = null; });
  };
  const t = setInterval(step, intervalMs);
  return {
    step,
    async stop() { stopped = true; clearInterval(t); if (current) await current; },
  };
}

export function backupLoop(db: Db, cfg: Config, logger: Logger): (() => Promise<void>) | null {
  if (!cfg.backup.dir || cfg.backup.intervalMinutes <= 0) return null;
  return startBackupSchedule(db, { dir: cfg.backup.dir, encrypt: cfg.backup.encrypt, keep: cfg.backup.keep, intervalMinutes: cfg.backup.intervalMinutes,
    onResult: (r: BackupResult | Error) => r instanceof Error ? logger.error('backup_failed', errorFields(r, false)) : logger.info('backup_completed', { file: r.file, bytes: r.bytes, encryptedWith: r.encryptedWith }) });
}

export const sessionPurgeLoop = (db: Db, logger: Logger) => createLoop('session-purge', 3600_000, () => { const n = purgeExpiredSessions(db); if (n) logger.info('sessions_purged', { count: n }); }, logger);

/**
 * SIGTERM / SIGINT: mark not-ready, stop accepting connections, wait for in-flight requests (up to
 * the grace period), stop the worker loops (each finishes its current item), close the database.
 * A second signal exits immediately.
 */
export function installShutdown(o: { server?: Server; stops: (() => unknown)[]; db: Db; cfg: Config; logger: Logger; exit?: (code: number) => void }) {
  const exit = o.exit ?? ((c: number) => process.exit(c));
  let shutting = false;
  const shutdown = async (signal: string) => {
    if (shutting) { o.logger.warn('shutdown_forced', { signal }); return exit(1); }
    shutting = true;
    o.logger.info('shutdown_started', { signal, graceMs: o.cfg.shutdownGraceMs });
    const life = o.server ? lifecycleOf(o.server) : undefined;
    if (life) life.draining = true;
    if (o.server) {
      const closed = new Promise<void>((r) => o.server!.close(() => r()));
      o.server.closeIdleConnections?.();
      const deadline = Date.now() + o.cfg.shutdownGraceMs;
      while (life && life.inFlight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      if (life && life.inFlight > 0) o.logger.warn('shutdown_requests_abandoned', { inFlight: life.inFlight });
      o.server.closeAllConnections?.();
      await closed;
    }
    for (const stop of o.stops) { try { await stop(); } catch (e) { o.logger.error('shutdown_stop_failed', errorFields(e, false)); } }
    try { if (o.db.isOpen) o.db.close(); } catch (e) { o.logger.error('shutdown_db_close_failed', errorFields(e, false)); }
    o.logger.info('shutdown_complete', {});
    exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  return shutdown;
}

export { backupNow };
