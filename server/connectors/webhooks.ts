// Generic signed-webhook framework for any connector (docs/07 "Signed webhook ingestion"):
// HMAC-SHA256 over `${timestamp}.${rawBody}`, timestamp window, provider account → tenant/client
// resolved on the server (payload tenant fields are ignored), event-id dedupe, persist before
// acknowledging, and monotonic, out-of-order tolerant state application.
// The existing simulated-payer receipt webhook (services/outbox.ts) keeps its own handler.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Db, one, run, tx } from '../db/db.ts';
import { AppError, canonicalJson, invalid, now, nowIso, sha256 } from '../util.ts';
import { audit } from '../services/audit.ts';
import type { Scope } from '../services/auth.ts';
import { ENVIRONMENT_FOR_GATE, newRequest, recordEvent } from './framework.ts';
import { categoryRank } from './x12/x277.ts';

export const TOLERANCE_MS = 5 * 60_000;

interface Endpoint { provider: string; provider_account: string; tenant_id: string; client_id: string; connector_id: string; secret_env: string; active: number }
export interface WebhookContext { provider: string; providerAccount: string; tenantId: string; clientId: string; connectorId: string; eventId: string; occurredAt: string | null }
export interface WebhookProvider {
  id: string;
  headers: { signature: string; timestamp: string; account: string };
  apply(db: Db, ctx: WebhookContext, payload: Record<string, unknown>): { status: 'applied' | 'ignored_out_of_order'; detail: string };
}

const PROVIDERS = new Map<string, WebhookProvider>();
export function registerWebhookProvider(p: WebhookProvider) { PROVIDERS.set(p.id, p); }

export function secretFor(e: { provider: string; provider_account: string; secret_env: string }): string {
  const v = process.env[e.secret_env];
  if (v) return v;
  if (ENVIRONMENT_FOR_GATE !== 'synthetic') throw new AppError(503, 'secret_unavailable', 'Webhook secret is not configured');
  return `synthetic-dev-only-${e.provider}-${e.provider_account}`;
}

export function signBody(secret: string, timestamp: string, raw: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
}

const reject = () => new AppError(401, 'webhook_unauthenticated', 'Webhook could not be authenticated');

export function receiveWebhook(db: Db, providerId: string, raw: string, header: (k: string) => string | undefined) {
  const p = PROVIDERS.get(providerId);
  if (!p) throw new AppError(404, 'not_found', 'Route not found');
  const account = header(p.headers.account);
  const signature = header(p.headers.signature);
  const timestamp = header(p.headers.timestamp);
  if (!account || !signature || !timestamp) throw reject();
  const ep = one<Endpoint>(db, 'SELECT * FROM webhook_endpoints WHERE provider=? AND provider_account=? AND active=1', providerId, account);
  // Unknown account and bad signature are indistinguishable to the caller.
  const secret = ep ? secretFor(ep) : 'unknown-account-placeholder-secret';
  const expected = Buffer.from(signBody(secret, timestamp, raw), 'hex');
  const given = Buffer.from(/^[0-9a-f]{64}$/i.test(signature) ? signature : '', 'hex');
  if (!ep || given.length !== expected.length || !timingSafeEqual(given, expected)) throw reject();
  const age = Math.abs(now().getTime() - Date.parse(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_MS) throw new AppError(401, 'stale_webhook', 'Webhook timestamp outside tolerance');
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw); } catch { throw invalid('Webhook body must be JSON'); }
  const eventId = typeof payload.eventId === 'string' ? payload.eventId : '';
  if (!/^[\w\-:.]{6,100}$/.test(eventId)) throw invalid('eventId is required');
  const occurredAt = typeof payload.occurredAt === 'string' && !Number.isNaN(Date.parse(payload.occurredAt)) ? new Date(payload.occurredAt).toISOString() : null;
  const ctx: WebhookContext = { provider: providerId, providerAccount: account, tenantId: ep.tenant_id, clientId: ep.client_id, connectorId: ep.connector_id, eventId, occurredAt };

  // 1. Persist (and dedupe) before acknowledging.
  const persisted = tx(db, () => {
    if (one(db, 'SELECT 1 FROM webhook_events WHERE provider=? AND event_id=?', providerId, eventId)) return false;
    run(db, 'INSERT INTO webhook_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', providerId, eventId, account, ep.tenant_id, ep.client_id, sha256(raw), raw, occurredAt, nowIso(), 'received', null, null);
    return true;
  });
  if (!persisted) return { accepted: true, duplicate: true, eventId };

  // 2. Apply. A failure leaves the event persisted as 'failed' for reprocessing; the sender still gets an ack.
  try {
    const r = tx(db, () => {
      const out = p.apply(db, ctx, payload);
      run(db, 'UPDATE webhook_events SET status=?, detail=?, processed_at=? WHERE provider=? AND event_id=?', out.status, out.detail, nowIso(), providerId, eventId);
      const sysScope = { userId: `webhook:${providerId}`, displayName: providerId, tenantId: ep.tenant_id, clientId: ep.client_id, roles: [] } as Scope;
      recordEvent(db, sysScope, ep.connector_id, newRequest(sysScope, 'webhook_ingest', {}), { outcome: 'success', externalRefs: { eventId, providerAccount: account },
        evidenceLocator: { webhookEvent: eventId }, sourceTime: occurredAt, receivedTime: nowIso(), rawSha256: sha256(raw), normalized: { status: out.status, detail: out.detail }, latencyMs: 0, error: null });
      audit(db, { tenantId: ep.tenant_id, clientId: ep.client_id, actorId: `webhook:${providerId}`, objectType: 'webhook_event', objectId: eventId, eventType: 'webhook_received',
        details: { provider: providerId, providerAccount: account, status: out.status, rawSha256: sha256(raw) } });
      return out;
    });
    return { accepted: true, duplicate: false, eventId, status: r.status, detail: r.detail };
  } catch (err) {
    run(db, `UPDATE webhook_events SET status='failed', detail=?, processed_at=? WHERE provider=? AND event_id=?`, (err as Error).message.slice(0, 500), nowIso(), providerId, eventId);
    return { accepted: true, duplicate: false, eventId, status: 'failed', detail: 'Persisted; processing failed and will need review' };
  }
}

// ---------------------------------------------------------------- simulated clearinghouse status events

registerWebhookProvider({
  id: 'sim_clearinghouse',
  headers: { signature: 'x-simch-signature', timestamp: 'x-simch-timestamp', account: 'x-simch-account' },
  apply(db, ctx, payload) {
    const ref = String(payload.claimReference ?? '');
    const category = String(payload.statusCategory ?? '');
    if (!/^[\w-]{3,40}$/.test(ref) || !/^[A-Z][A-Z0-9]$/.test(category)) throw invalid('claimReference and statusCategory are required');
    const occurred = ctx.occurredAt ?? nowIso();
    const correction = payload.correction === true;
    const cur = one<{ state: string; rank: number; occurred_at: string }>(db, 'SELECT state, rank, occurred_at FROM webhook_object_state WHERE tenant_id=? AND client_id=? AND provider=? AND object_ref=?',
      ctx.tenantId, ctx.clientId, ctx.provider, ref);
    const rank = categoryRank(category);
    if (cur && !correction && (occurred < cur.occurred_at || rank < cur.rank)) {
      return { status: 'ignored_out_of_order', detail: `Kept ${cur.state} (${cur.occurred_at}); older or lower-ranked ${category} (${occurred}) ignored` };
    }
    run(db, `INSERT INTO webhook_object_state VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (tenant_id, client_id, provider, object_ref) DO UPDATE SET
      state=excluded.state, rank=excluded.rank, occurred_at=excluded.occurred_at, event_id=excluded.event_id, updated_at=excluded.updated_at`,
    ctx.tenantId, ctx.clientId, ctx.provider, ref, category, rank, occurred, ctx.eventId, nowIso());
    const acct = one<{ account_id: string }>(db, 'SELECT account_id FROM accounts WHERE tenant_id=? AND client_id=? AND claim_reference=?', ctx.tenantId, ctx.clientId, ref);
    if (acct) audit(db, { tenantId: ctx.tenantId, clientId: ctx.clientId, actorId: `webhook:${ctx.provider}`, objectType: 'account', objectId: acct.account_id, accountId: acct.account_id,
      eventType: 'claim_status_notification', details: { category, eventId: ctx.eventId, correction, note: 'Status notification only; facts change only through ingested 277 evidence.' } });
    return { status: 'applied', detail: `${ref} → ${category}${correction ? ' (correction)' : ''}` };
  },
});

export function buildSimWebhook(db: Db, providerAccount: string, payload: Record<string, unknown>, at = nowIso()) {
  const ep = one<Endpoint>(db, 'SELECT * FROM webhook_endpoints WHERE provider=? AND provider_account=?', 'sim_clearinghouse', providerAccount);
  if (!ep) throw invalid('Unknown provider account');
  const raw = canonicalJson(payload);
  return { raw, headers: { 'x-simch-account': providerAccount, 'x-simch-timestamp': at, 'x-simch-signature': signBody(secretFor(ep), at, raw) } };
}

export function endpointAccountFor(db: Db, scope: Scope, provider: string): string | null {
  return one<{ provider_account: string }>(db, 'SELECT provider_account FROM webhook_endpoints WHERE provider=? AND tenant_id=? AND client_id=?', provider, scope.tenantId, scope.clientId)?.provider_account ?? null;
}

export function objectStates(db: Db, scope: Scope) {
  return db.prepare('SELECT provider, object_ref, state, occurred_at, event_id, updated_at FROM webhook_object_state WHERE tenant_id=? AND client_id=? ORDER BY updated_at DESC LIMIT 50').all(scope.tenantId, scope.clientId);
}
