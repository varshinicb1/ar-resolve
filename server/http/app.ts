import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Db, all, one } from '../db/db.ts';
import { AppError, invalid, notFound } from '../util.ts';
import { authenticate, createSession, listScopes, requirePerm, resolveScope, type Scope } from '../services/auth.ts';
import { correctFact, importInventory, investigate, listAccounts, simulateCall } from '../services/workflow.ts';
import { reviewAction } from '../services/review.ts';
import { accountView, auditExport } from '../services/views.ts';
import { buildSimConfirmation, handlePayerWebhook, tick } from '../services/outbox.ts';
import { listControls, setPause } from '../services/controls.ts';
import { setFault } from '../connectors/executors.ts';
import { cohort } from '../connectors/synthetic-source.ts';
import { loadRule } from '../services/rules.ts';
import { verifyChainIncremental } from '../services/audit.ts';
import { outcomeLabel } from '../../shared/rules/registry.ts';
import { MODULES } from './modules.ts';
import { authenticateKey, keyScope, keyScopes, KEY_PREFIX, recordKeyRequest } from '../services/access.ts';
import { type Config, deploymentEnv, loadConfig } from '../config.ts';
import { authenticateCookie } from '../services/web-sessions.ts';
import { log as sharedLog, errorFields, type Logger } from '../log.ts';
import { clientIp, cors, credentialKey, Metrics, RateLimiter, requestIdFor, securityHeaders } from './hardening.ts';
import { opsRoute } from './ops-endpoints.ts';

// Deployment kind from AR_ENV (ADR 0090): synthetic (default) | staging | production.
export const ENVIRONMENT = deploymentEnv();

export interface Ctx { req: IncomingMessage; params: Record<string, string>; query: URLSearchParams; raw: string; body: any }
export type Handler = (ctx: Ctx) => unknown;
/** A non-JSON response (e.g. TwiML for a telephony provider webhook, ADR 0070). */
export class RawResponse { contentType: string; text: string; constructor(contentType: string, text: string) { this.contentType = contentType; this.text = text; } }
/** A response with its own status and headers (redirects, Set-Cookie), ADR 0090. */
export class HttpResponse { status: number; headers: Record<string, string | string[]>; body: unknown; constructor(status: number, headers: Record<string, string | string[]>, body: unknown = null) { this.status = status; this.headers = headers; this.body = body; } }

/** Per-server runtime state used by /readyz and graceful shutdown (server/runtime.ts). */
export interface Lifecycle { draining: boolean; inFlight: number }
const LIFECYCLES = new WeakMap<Server, Lifecycle>();
export const lifecycleOf = (s: Server): Lifecycle | undefined => LIFECYCLES.get(s);
const PRINCIPALS = new WeakMap<IncomingMessage, string>();

// Feature modules register their routes through this surface (see server/http/modules.ts).
export interface ModuleApi {
  db: Db;
  route: (method: string, path: string, handler: Handler) => void;
  scoped: (ctx: Ctx) => Scope;
  header: (ctx: Ctx, k: string) => string | undefined;
  /** Deployment configuration (ADR 0090). */
  config: Config;
  logger: Logger;
}

// The supervisor operations page lists the most recent outbox rows and work items, not all of them (ADR 0095).
const OPS_PAGE_ROWS = 500;

// An oversized body is refused with a 413 the client can read (ADR 0095): stop buffering,
// keep draining what is still in flight (bounded) so the response is not lost to a reset
// or EPIPE. Destroying the socket at once made every client see ECONNRESET instead of the 413.
const MAX_DRAIN = 128 * 1024 * 1024;
function refuseBody(req: IncomingMessage, MAX_BODY: number): AppError {
  let drained = 0;
  req.removeAllListeners('data');
  req.on('data', (c: Buffer) => { drained += c.length; if (drained > MAX_DRAIN) req.socket.destroy(); });
  const timer = setTimeout(() => req.socket.destroy(), 10_000); // a sender that never finishes
  timer.unref();
  req.on('end', () => clearTimeout(timer)); // drained: the keep-alive socket stays usable
  req.resume();
  return new AppError(413, 'too_large', `Request body too large (limit ${MAX_BODY} bytes); split the upload into smaller parts`);
}

function readBody(req: IncomingMessage, MAX_BODY: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { reject(refuseBody(req, MAX_BODY)); return; }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { chunks.length = 0; reject(refuseBody(req, MAX_BODY)); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Malformed percent-encoding in a path parameter is the client's error, not a 500 (ADR 0095).
function decodeParam(v: string): string {
  try { return decodeURIComponent(v); } catch { throw invalid('Malformed URL encoding in the request path'); }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

export function createApp(db: Db, opts: { staticDir?: string; config?: Config; logger?: Logger; metrics?: Metrics } = {}): Server {
  const cfg = opts.config ?? loadConfig();
  const logger = opts.logger ?? sharedLog();
  const metrics = opts.metrics ?? new Metrics();
  const routes: { method: string; path: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, path, pattern, keys, handler });
  };
  // Simulator and development-identity routes exist only in the synthetic environment (ADR 0090).
  const simRoute = (method: string, path: string, handler: Handler) => { if (cfg.synthetic) route(method, path, handler); };

  const ident = (ctx: Ctx) => {
    const token = (ctx.req.headers.authorization ?? '').replace(/^Bearer /, '') || undefined;
    let id;
    if (token?.startsWith(KEY_PREFIX)) id = authenticateKey(db, token); // named API keys, ADR 0080
    else if (token && !cfg.devLogin) throw new AppError(401, 'unauthenticated', 'Development tokens are not accepted in this environment');
    else if (token) id = authenticate(db, token);
    else id = authenticateCookie(db, cfg, ctx.req); // SSO browser session + CSRF, ADR 0090
    PRINCIPALS.set(ctx.req, id.userId);
    return id;
  };
  const scoped = (ctx: Ctx): Scope => {
    const id = ident(ctx);
    if (!id.apiKey) return resolveScope(db, id, header(ctx, 'x-tenant'), header(ctx, 'x-client'));
    const s = keyScope(db, id, header(ctx, 'x-tenant') ?? '', header(ctx, 'x-client') ?? '');
    recordKeyRequest(db, s, ctx.req.method ?? '', new URL(ctx.req.url ?? '/', 'http://localhost').pathname);
    return s;
  };
  const header = (ctx: Ctx, k: string) => { const v = ctx.req.headers[k]; return Array.isArray(v) ? v[0] : v; };

  // ---- public / development identity
  route('GET', '/api/health', () => ({ ok: true, environment: ENVIRONMENT, liveActions: 'disabled' }));
  simRoute('GET', '/api/dev/users', () => cohort().users.map((u) => ({ userId: u.userId, displayName: u.displayName })));
  simRoute('POST', '/api/dev/login', (ctx) => {
    if (ENVIRONMENT !== 'synthetic') throw notFound('Route');
    return { token: createSession(db, String(ctx.body?.userId ?? '')) };
  });
  route('GET', '/api/me', (ctx) => {
    const id = ident(ctx);
    return { userId: id.userId, displayName: id.displayName, scopes: id.apiKey ? keyScopes(db, id.userId) : listScopes(db, id.userId), environment: ENVIRONMENT, liveActions: 'disabled' };
  });

  // ---- queue and accounts
  route('GET', '/api/accounts', (ctx) => listAccounts(db, scoped(ctx), {
    view: ctx.query.get('view') ?? 'all', q: ctx.query.get('q') ?? undefined, page: Number(ctx.query.get('page') ?? 1), pageSize: Number(ctx.query.get('pageSize') ?? 25),
  }));
  route('GET', '/api/accounts/:id', (ctx) => accountView(db, scoped(ctx), ctx.params.id));
  route('POST', '/api/accounts/:id/investigate', (ctx) => investigate(db, scoped(ctx), ctx.params.id));
  simRoute('POST', '/api/accounts/:id/calls/simulate', (ctx) => simulateCall(db, scoped(ctx), ctx.params.id));
  route('POST', '/api/accounts/:id/facts/:key/correct', (ctx) => correctFact(db, scoped(ctx), ctx.params.id, ctx.params.key, ctx.body ?? {}));
  route('GET', '/api/accounts/:id/audit-export', (ctx) => auditExport(db, scoped(ctx), ctx.params.id));

  // ---- reviews
  route('GET', '/api/reviews', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'view');
    return all<{ action_id: string; account_id: string; kind: string; created_at: string; expires_at: string; external_id: string; balance_cents: number }>(db,
      `SELECT p.action_id, p.account_id, p.kind, p.created_at, p.expires_at, a.external_id, a.balance_cents FROM proposed_actions p
       JOIN accounts a ON a.tenant_id=p.tenant_id AND a.client_id=p.client_id AND a.account_id=p.account_id
       WHERE p.tenant_id=? AND p.client_id=? AND p.state='awaiting_review' ORDER BY p.created_at`, s.tenantId, s.clientId)
      .map((r) => ({ actionId: r.action_id, accountId: r.account_id, externalId: r.external_id, kind: r.kind, label: outcomeLabel(r.kind), balanceCents: r.balance_cents, createdAt: r.created_at, expiresAt: r.expires_at }));
  });
  route('POST', '/api/actions/:id/review', (ctx) => reviewAction(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));

  // ---- import
  route('GET', '/api/imports/samples', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'import');
    const clean = cohort().inventories[s.clientId] ?? 'external_id,payer_id,provider_id,patient_token,service_date,claim_reference,claim_type,balance_cents,scenario\n';
    const lines = clean.trim().split('\n');
    const ambiguous = [lines[0], lines[1] ?? '', lines[1] ?? '', 'SYN-9001,demo-payer,PRV-SYN-01,PT-AAAA,2026-02-30,SYN-C9001,professional,1000,deductible',
      'SYN-9002,demo-payer,PRV-SYN-01,PT-BBBB,2026-03-01,SYN-C9002,professional,12.50,deductible', 'SYN-9003,,PRV-SYN-01,PT-CCCC,2026-03-02,SYN-C9003,professional,5000,deductible'].join('\n') + '\n';
    return { clean: { name: `${s.clientId}-inventory.csv`, csv: clean }, ambiguous: { name: `${s.clientId}-ambiguous.csv`, csv: ambiguous } };
  });
  route('POST', '/api/imports/preview', (ctx) => importInventory(db, scoped(ctx), { sourceName: String(ctx.body?.sourceName ?? 'upload.csv'), csv: String(ctx.body?.csv ?? ''), commit: false }));
  route('POST', '/api/imports', (ctx) => importInventory(db, scoped(ctx), { sourceName: String(ctx.body?.sourceName ?? 'upload.csv'), csv: String(ctx.body?.csv ?? ''), commit: true }));
  route('GET', '/api/imports', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'view');
    return all(db, 'SELECT batch_id, source_name, source_sha256, accepted, rejected, duplicates, created_by, created_at FROM import_batches WHERE tenant_id=? AND client_id=? ORDER BY created_at DESC', s.tenantId, s.clientId);
  });

  // ---- rules
  route('GET', '/api/rules/:id', (ctx) => {
    scoped(ctx);
    const r = loadRule(db, ctx.params.id, 1);
    return { definition: r.definition, sha256: r.sha256, state: r.state };
  });

  // ---- operations (supervisor)
  route('GET', '/api/ops/outbox', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'operate');
    return {
      outbox: all(db, `SELECT o.action_id, o.idempotency_key, o.connector, o.state, o.attempts, o.external_reference, o.last_error, o.updated_at, p.kind, p.account_id, a.external_id
        FROM action_outbox o JOIN proposed_actions p USING (tenant_id, client_id, action_id) JOIN accounts a ON a.tenant_id=p.tenant_id AND a.client_id=p.client_id AND a.account_id=p.account_id
        WHERE o.tenant_id=? AND o.client_id=? ORDER BY o.updated_at DESC LIMIT ${OPS_PAGE_ROWS}`, s.tenantId, s.clientId),
      controls: listControls(db, s.tenantId, s.clientId),
      workItems: all(db, `SELECT work_item_id, account_id, kind, summary, state, created_at FROM work_items WHERE tenant_id=? AND client_id=? ORDER BY created_at DESC LIMIT ${OPS_PAGE_ROWS}`, s.tenantId, s.clientId),
      faults: all(db, 'SELECT fault, remaining FROM sim_faults'),
      auditChain: verifyChainIncremental(db, s.tenantId), // ADR 0095: full re-walk at most every 10 min
      limits: { rows: OPS_PAGE_ROWS, note: 'Most recent rows only (ADR 0095)' },
    };
  });
  route('POST', '/api/ops/worker/tick', (ctx) => { requirePerm(scoped(ctx), 'operate'); return tick(db); });
  route('POST', '/api/ops/pause', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'operate');
    const reason = String(ctx.body?.reason ?? '').trim();
    if (!reason) throw invalid('A reason is required');
    setPause(db, s, `client:${s.tenantId}/${s.clientId}`, !!ctx.body?.paused, reason, s.userId);
    return listControls(db, s.tenantId, s.clientId);
  });
  simRoute('POST', '/api/ops/faults', (ctx) => {
    requirePerm(scoped(ctx), 'operate');
    const fault = ctx.body?.fault;
    if (fault !== 'timeout_after_success' && fault !== 'timeout_before_send') throw invalid('Unknown fault');
    setFault(db, fault, Math.max(0, Math.min(5, Number(ctx.body?.remaining ?? 1))));
    return all(db, 'SELECT fault, remaining FROM sim_faults');
  });
  simRoute('POST', '/api/ops/sim-confirm/:actionId', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'operate');
    const o = one<{ external_reference: string | null; connector: string }>(db, 'SELECT external_reference, connector FROM action_outbox WHERE tenant_id=? AND client_id=? AND action_id=?', s.tenantId, s.clientId, ctx.params.actionId);
    if (!o || !o.external_reference || o.connector !== 'sim_payer') throw invalid('No simulated payer request to confirm for this action');
    const w = buildSimConfirmation(o.external_reference, ctx.body?.eventId);
    const first = handlePayerWebhook(db, w.body, w.signature, w.timestamp);
    const replay = ctx.body?.sendDuplicate ? handlePayerWebhook(db, w.body, w.signature, w.timestamp) : null;
    return { first, replay };
  });

  // ---- signed webhook from the simulated payer (no session; signature authenticates)
  simRoute('POST', '/api/webhooks/sim-payer', (ctx) => handlePayerWebhook(db, ctx.raw, header(ctx, 'x-signature'), header(ctx, 'x-timestamp')));

  for (const register of MODULES) register({ db, route, scoped, header, config: cfg, logger });

  const staticDir = opts.staticDir;
  const life: Lifecycle = { draining: false, inFlight: 0 };
  const ipLimiter = new RateLimiter(cfg.rateLimit.ipPerMinute);
  const keyLimiter = new RateLimiter(cfg.rateLimit.keyPerMinute);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const requestId = requestIdFor(req);
    const started = process.hrtime.bigint();
    let routeLabel = url.pathname.startsWith('/api/') ? 'unmatched' : 'static';
    life.inFlight++;
    res.on('close', () => {
      life.inFlight--;
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      metrics.observeRequest({ method: req.method ?? '', route: routeLabel, status: String(res.statusCode) }, seconds);
      if (!routeLabel.startsWith('ops:')) logger.info('http_request', { requestId, method: req.method, route: routeLabel, status: res.statusCode, durationMs: Math.round(seconds * 1000), principal: PRINCIPALS.get(req) ?? null });
    });
    securityHeaders(cfg, res, requestId);
    const fail = (status: number, code: string, message: string, details: unknown = null, extra: Record<string, string> = {}) => {
      if (res.headersSent) return;
      for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
      send(res, status, { error: { code, message, details, requestId } });
    };
    try {
      const ops = opsRoute(url.pathname);
      if (ops) { routeLabel = `ops:${url.pathname}`; return await ops({ db, cfg, req, res, metrics, life }); }
      const c = cors(cfg, req, res);
      if (c === 'refused') return fail(403, 'origin_refused', 'Request origin is not allowed');
      if (c === 'preflight-ok') { res.writeHead(204); res.end(); return; }
      const credKey = credentialKey(req, cfg.session.cookieName);
      const wait = ipLimiter.take('ip:' + clientIp(req, cfg.trustProxyHops)) || (credKey ? keyLimiter.take(credKey) : 0);
      if (wait) { metrics.inc('ar_http_rate_limited_total', 'Requests refused by the rate limiter'); return fail(429, 'rate_limited', 'Too many requests; slow down', null, { 'retry-after': String(wait) }); }
      if (!url.pathname.startsWith('/api/')) {
        if (staticDir && serveStatic(staticDir, url.pathname, res)) return;
        return fail(404, 'not_found', 'Not found');
      }
      const match = routes.map((r) => ({ r, m: req.method === r.method ? url.pathname.match(r.pattern) : null })).find((x) => x.m);
      if (!match) throw notFound('Route');
      routeLabel = match.r.path;
      const raw = req.method === 'POST' || req.method === 'PUT' ? await readBody(req, cfg.http.bodyLimitBytes) : '';
      let body: unknown = null;
      const form = /^application\/x-www-form-urlencoded/i.test(String(req.headers['content-type'] ?? ''));
      if (raw && form) body = Object.fromEntries(new URLSearchParams(raw));
      else if (raw) { try { body = JSON.parse(raw); } catch { throw invalid('Body must be JSON'); } }
      const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeParam(match.m![i + 1])]));
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError(503, 'timeout', 'The request took too long; it may still complete. Check its state before retrying.')), cfg.http.handlerTimeoutMs); });
      const out = await Promise.race([Promise.resolve().then(() => match.r.handler({ req, params, query: url.searchParams, raw, body })), timeout]).finally(() => clearTimeout(timer));
      if (res.headersSent) return;
      if (out instanceof RawResponse) { res.writeHead(200, { 'content-type': out.contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(out.text); return; }
      if (out instanceof HttpResponse) {
        for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
        if (out.body === null) { res.writeHead(out.status, { 'cache-control': 'no-store' }); res.end(); return; }
        return send(res, out.status, out.body);
      }
      send(res, 200, out ?? { ok: true });
    } catch (err) {
      if (err instanceof AppError) return fail(err.status, err.code, err.message, err.details ?? null);
      logger.error('http_unhandled_error', { requestId, route: routeLabel, ...errorFields(err, cfg.synthetic) });
      fail(500, 'internal', 'Internal error');
    }
  });
  server.requestTimeout = cfg.http.requestTimeoutMs;
  server.headersTimeout = Math.min(cfg.http.requestTimeoutMs, 20_000);
  server.keepAliveTimeout = 5_000;
  LIFECYCLES.set(server, life);
  return server;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };

function serveStatic(dir: string, pathname: string, res: ServerResponse): boolean {
  const safe = normalize(pathname).replace(/^([/\\])+/, '');
  let file = join(dir, safe);
  if (!file.startsWith(dir)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
  if (!existsSync(file)) return false;
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
  res.end(readFileSync(file));
  return true;
}

export const DEFAULT_STATIC = fileURLToPath(new URL('../../web/dist', import.meta.url));
