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
import { verifyChain } from '../services/audit.ts';
import { OUTCOME_LABELS } from '../../shared/rules/ded01.ts';
import { MODULES } from './modules.ts';

export const ENVIRONMENT = 'synthetic' as const;

export interface Ctx { req: IncomingMessage; params: Record<string, string>; query: URLSearchParams; raw: string; body: any }
export type Handler = (ctx: Ctx) => unknown;

// Feature modules register their routes through this surface (see server/http/modules.ts).
export interface ModuleApi {
  db: Db;
  route: (method: string, path: string, handler: Handler) => void;
  scoped: (ctx: Ctx) => Scope;
  header: (ctx: Ctx, k: string) => string | undefined;
}

const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new AppError(413, 'too_large', 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

export function createApp(db: Db, opts: { staticDir?: string } = {}): Server {
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, pattern, keys, handler });
  };

  const ident = (ctx: Ctx) => authenticate(db, (ctx.req.headers.authorization ?? '').replace(/^Bearer /, '') || undefined);
  const scoped = (ctx: Ctx): Scope => resolveScope(db, ident(ctx), header(ctx, 'x-tenant'), header(ctx, 'x-client'));
  const header = (ctx: Ctx, k: string) => { const v = ctx.req.headers[k]; return Array.isArray(v) ? v[0] : v; };

  // ---- public / development identity
  route('GET', '/api/health', () => ({ ok: true, environment: ENVIRONMENT, liveActions: 'disabled' }));
  route('GET', '/api/dev/users', () => cohort().users.map((u) => ({ userId: u.userId, displayName: u.displayName })));
  route('POST', '/api/dev/login', (ctx) => {
    if (ENVIRONMENT !== 'synthetic') throw notFound('Route');
    return { token: createSession(db, String(ctx.body?.userId ?? '')) };
  });
  route('GET', '/api/me', (ctx) => {
    const id = ident(ctx);
    return { ...id, scopes: listScopes(db, id.userId), environment: ENVIRONMENT, liveActions: 'disabled' };
  });

  // ---- queue and accounts
  route('GET', '/api/accounts', (ctx) => listAccounts(db, scoped(ctx), {
    view: ctx.query.get('view') ?? 'all', q: ctx.query.get('q') ?? undefined, page: Number(ctx.query.get('page') ?? 1), pageSize: Number(ctx.query.get('pageSize') ?? 25),
  }));
  route('GET', '/api/accounts/:id', (ctx) => accountView(db, scoped(ctx), ctx.params.id));
  route('POST', '/api/accounts/:id/investigate', (ctx) => investigate(db, scoped(ctx), ctx.params.id));
  route('POST', '/api/accounts/:id/calls/simulate', (ctx) => simulateCall(db, scoped(ctx), ctx.params.id));
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
      .map((r) => ({ actionId: r.action_id, accountId: r.account_id, externalId: r.external_id, kind: r.kind, label: OUTCOME_LABELS[r.kind as keyof typeof OUTCOME_LABELS], balanceCents: r.balance_cents, createdAt: r.created_at, expiresAt: r.expires_at }));
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
        WHERE o.tenant_id=? AND o.client_id=? ORDER BY o.updated_at DESC`, s.tenantId, s.clientId),
      controls: listControls(db, s.tenantId, s.clientId),
      workItems: all(db, 'SELECT work_item_id, account_id, kind, summary, state, created_at FROM work_items WHERE tenant_id=? AND client_id=? ORDER BY created_at DESC', s.tenantId, s.clientId),
      faults: all(db, 'SELECT fault, remaining FROM sim_faults'),
      auditChain: verifyChain(db, s.tenantId),
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
  route('POST', '/api/ops/faults', (ctx) => {
    requirePerm(scoped(ctx), 'operate');
    const fault = ctx.body?.fault;
    if (fault !== 'timeout_after_success' && fault !== 'timeout_before_send') throw invalid('Unknown fault');
    setFault(db, fault, Math.max(0, Math.min(5, Number(ctx.body?.remaining ?? 1))));
    return all(db, 'SELECT fault, remaining FROM sim_faults');
  });
  route('POST', '/api/ops/sim-confirm/:actionId', (ctx) => {
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
  route('POST', '/api/webhooks/sim-payer', (ctx) => handlePayerWebhook(db, ctx.raw, header(ctx, 'x-signature'), header(ctx, 'x-timestamp')));

  for (const register of MODULES) register({ db, route, scoped, header });

  const staticDir = opts.staticDir;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (staticDir && serveStatic(staticDir, url.pathname, res)) return;
        return send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
      }
      const match = routes.map((r) => ({ r, m: req.method === r.method ? url.pathname.match(r.pattern) : null })).find((x) => x.m);
      if (!match) throw notFound('Route');
      const raw = req.method === 'POST' ? await readBody(req) : '';
      let body: unknown = null;
      if (raw) { try { body = JSON.parse(raw); } catch { throw invalid('Body must be JSON'); } }
      const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m![i + 1])]));
      const out = await match.r.handler({ req, params, query: url.searchParams, raw, body });
      send(res, 200, out ?? { ok: true });
    } catch (err) {
      if (err instanceof AppError) return send(res, err.status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      console.error('[api]', (err as Error).stack);
      send(res, 500, { error: { code: 'internal', message: 'Internal error' } });
    }
  });
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
