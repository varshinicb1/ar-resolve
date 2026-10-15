// Operability endpoints (ADR 0090), outside /api and outside rate limiting:
//   GET /healthz  liveness: the process answers. No database access.
//   GET /readyz   readiness: not draining, database writable, every migration applied, key material
//                 loaded (outside synthetic: PHI keyring and session secret). 503 with the failing
//                 checks otherwise. Reveals no configuration values.
//   GET /metrics  Prometheus text format. Requires "Authorization: Bearer <AR_METRICS_TOKEN>" when a
//                 token is configured (always, outside synthetic); open only in synthetic without one.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Db, all, one, pendingMigrations } from '../db/db.ts';
import type { Config } from '../config.ts';
import { phiKeyring } from '../services/phi.ts';
import { safeEqual } from '../services/oidc.ts';
import type { Metrics } from './hardening.ts';

interface OpsCtx { db: Db; cfg: Config; req: IncomingMessage; res: ServerResponse; metrics: Metrics; life: { draining: boolean; inFlight: number } }

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export function readiness(db: Db, cfg: Config, draining: boolean) {
  const checks: { id: string; ok: boolean; detail: string }[] = [];
  checks.push({ id: 'accepting', ok: !draining, detail: draining ? 'shutting down' : 'accepting requests' });
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    checks.push({ id: 'db_writable', ok: true, detail: 'write lock acquired and released' });
  } catch (e) { checks.push({ id: 'db_writable', ok: false, detail: (e as Error).message.slice(0, 120) }); }
  try {
    const pending = pendingMigrations(db);
    checks.push({ id: 'migrations', ok: pending.length === 0, detail: pending.length ? `${pending.length} pending` : 'all applied' });
  } catch (e) { checks.push({ id: 'migrations', ok: false, detail: (e as Error).message.slice(0, 120) }); }
  if (!cfg.synthetic) {
    let keys = false;
    try { keys = phiKeyring().activeId !== null; } catch { keys = false; }
    checks.push({ id: 'phi_keys', ok: keys, detail: keys ? 'active PHI key loaded' : 'no valid active PHI key' });
    checks.push({ id: 'session_secret', ok: cfg.session.secret.length >= 32, detail: 'session secret length check' });
  }
  return { ok: checks.every((c) => c.ok), env: cfg.env, checks };
}

function gauges(db: Db) {
  const safe = <T>(f: () => T, d: T): T => { try { return f(); } catch { return d; } };
  const outbox = safe(() => all<{ state: string; n: number }>(db, 'SELECT state, count(*) n FROM action_outbox GROUP BY state'), []);
  const pending = safe(() => one<{ n: number }>(db, "SELECT count(*) n FROM notification_deliveries WHERE status='pending'")?.n ?? 0, 0);
  const sessions = safe(() => one<{ n: number }>(db, 'SELECT count(*) n FROM web_sessions WHERE revoked_at IS NULL AND expires_at > ?', new Date().toISOString())?.n ?? 0, 0);
  const lastBackup = safe(() => one<{ at: string | null }>(db, "SELECT max(finished_at) at FROM backup_runs WHERE status='completed'")?.at ?? null, null);
  const awaiting = safe(() => one<{ n: number }>(db, "SELECT count(*) n FROM proposed_actions WHERE state='awaiting_review'")?.n ?? 0, 0);
  return [
    { name: 'ar_outbox_items', help: 'Outbox items by state', values: outbox.map((o) => ({ labels: { state: o.state }, value: o.n })) },
    { name: 'ar_actions_awaiting_review', help: 'Proposed actions awaiting human review', values: [{ value: awaiting }] },
    { name: 'ar_notifications_pending', help: 'Notification deliveries pending', values: [{ value: pending }] },
    { name: 'ar_web_sessions_active', help: 'Unexpired, unrevoked browser sessions', values: [{ value: sessions }] },
    { name: 'ar_backup_last_success_timestamp_seconds', help: 'Unix time of the last completed backup (0 if none)', values: [{ value: lastBackup ? Math.floor(Date.parse(lastBackup) / 1000) : 0 }] },
  ];
}

export function opsRoute(pathname: string): ((c: OpsCtx) => Promise<void> | void) | null {
  if (pathname === '/healthz') return ({ res, req }) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: { code: 'method_not_allowed', message: 'GET only' } });
    json(res, 200, { ok: true });
  };
  if (pathname === '/readyz') return ({ db, cfg, res, life }) => { const r = readiness(db, cfg, life.draining); json(res, r.ok ? 200 : 503, r); };
  if (pathname === '/metrics') return ({ db, cfg, req, res, metrics }) => {
    if (cfg.metricsToken) {
      const sent = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!sent || !safeEqual(sent, cfg.metricsToken)) { res.setHeader('www-authenticate', 'Bearer'); return json(res, 401, { error: { code: 'unauthenticated', message: 'Metrics token required' } }); }
    } else if (!cfg.synthetic) return json(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
    res.end(metrics.render(gauges(db)));
  };
  return null;
}
