// Ported from clinic-receptionist src/integrations.ts (same owner): notification destinations
// (Slack, Teams, email via Resend, staff SMS, signed outbound webhooks) as Connectors in a
// Registry, per-destination settings with validate + send, event filters, an outbox with retries
// and backoff, and the PHI rule that messages carry opaque ids only.
//
//   an audited state change (audit.ts)            e.g. action_proposed, followup_overdue
//     -> an AR event (AUDIT_EVENT_MAP)             review.needed, followup.overdue, ...
//     -> every enabled channel of that tenant/client whose events and filter match
//     -> a notification_deliveries row in the SAME transaction (idempotent per channel + event)
//     -> deliverDue() sends: simulated sink here; real destinations are refused (LiveExecutionDisabled)
//     -> failures retried with backoff, then marked failed
//
// Adapted for AR Resolve: events come from the hash-chained audit log instead of call tool events;
// channels are scoped by tenant/client; the payload is sealed at rest with AR_PHI_KEY when set;
// real sends stay disabled in this build, and a clearly labelled simulated sink receives messages
// for tests and the UI. Message bodies carry internal opaque ids (account_..., act_...), event
// codes and counts. Account numbers, claim references and patient tokens are never included unless
// a channel asks for details AND either the environment is synthetic or every vendor behind the
// channel has a BAA in force in the vendor register (governance.ts).
import { createHmac, randomBytes } from 'node:crypto';
import { type Db, all, one, run, tx } from '../db/db.ts';
import { AppError, invalid, newId, notFound, now, nowIso } from '../util.ts';
import { audit, type AuditInput } from './audit.ts';
import { requirePerm, type Scope } from './auth.ts';
import { open, seal } from './phi.ts';
import { Registry, type DataProcessor, type Pluggable } from '../core/registry.ts';
import { LiveExecutionDisabled } from '../connectors/executors.ts';
import { ENVIRONMENT_FOR_GATE } from '../connectors/framework.ts';
import { safePublicHttpsUrl } from '../connectors/safe-url.ts';
import { phiModeOn, signedVendors } from './governance.ts';

export const NOTIFY_VERSION = 'notify.v1';

export const EVENT_TYPES = [
  'review.needed', 'followup.due', 'followup.overdue', 'receipt.uncertain', 'verbal_request.unreconciled',
  'outcome.reconciled', 'account.reopened', 'connector.circuit_open', 'integration.test',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Audit event -> notification event, with the detail keys that may be copied (codes, numbers, booleans only). */
export const AUDIT_EVENT_MAP: Record<string, { type: EventType; keep: string[] }> = {
  action_proposed: { type: 'review.needed', keep: ['kind'] },
  writeback_proposed: { type: 'review.needed', keep: ['edited'] },
  followup_due: { type: 'followup.due', keep: ['basis', 'daysLate'] },
  followup_overdue: { type: 'followup.overdue', keep: [] },
  dispatch_uncertain: { type: 'receipt.uncertain', keep: ['reason'] },
  verbal_request_recorded: { type: 'verbal_request.unreconciled', keep: ['referenceConfirmed'] },
  outcome_reconciled: { type: 'outcome.reconciled', keep: ['entryType', 'attribution', 'matchStatus'] },
  account_reopened: { type: 'account.reopened', keep: ['cause'] },
  connector_circuit_opened: { type: 'connector.circuit_open', keep: ['failures'] },
};

const LABEL: Record<EventType, string> = {
  'review.needed': 'Review needed',
  'followup.due': 'Follow-up due',
  'followup.overdue': 'Follow-up overdue',
  'receipt.uncertain': 'Receipt uncertain',
  'verbal_request.unreconciled': 'Verbal payer request not reconciled',
  'outcome.reconciled': 'Outcome reconciled',
  'account.reopened': 'Account reopened',
  'connector.circuit_open': 'Connector circuit open',
  'integration.test': 'Test notification',
};

export interface ArEvent {
  id: string; type: EventType; occurredAt: string; tenantId: string; clientId: string;
  accountId: string | null; objectType: string; objectId: string; data: Record<string, string | number | boolean>;
  /** Present only when the channel may receive it (see header). */
  details?: { externalId: string; scenario: string; payerId: string };
}

/** Automation conditions; every condition given must hold, none given means always. */
export interface EventFilter { scenarios?: string[]; payerIds?: string[]; actionKinds?: string[] }

export interface SendResult { ok: boolean; status?: number; error?: string; refused?: boolean }

export interface SendContext { db: Db; tenantId: string; clientId: string; deliveryId: string; channelId: string; attemptsBefore: number }

export interface NotifyConnector extends Pluggable, DataProcessor {
  readonly fields: { key: string; label: string; secret?: boolean; optional?: boolean }[];
  /** Sends to an outside service (refused in this build). */
  readonly live: boolean;
  validate(config: Record<string, string>): string | null;
  send(ctx: SendContext, config: Record<string, string>, body: Record<string, unknown>, text: string): Promise<SendResult>;
}

const TIMEOUT_MS = 5_000;
/** Minutes to wait before attempts 2..5; after the 5th failure the delivery is marked failed. */
export const BACKOFF_MIN = [1, 5, 30, 120];
export const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;

/** Live sends are disabled in this build. The flag is read at call time and the environment must be non-synthetic too. */
export function liveSendsAllowed(settings: Record<string, string | undefined> = process.env): boolean {
  return ENVIRONMENT_FOR_GATE !== 'synthetic' && settings.AR_NOTIFY_LIVE === 'on';
}

async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<SendResult> {
  if (!liveSendsAllowed()) throw new LiveExecutionDisabled('Outbound notifications are disabled in this environment.');
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'send failed' };
  }
}

/** HMAC-SHA256 over "<unix seconds>.<raw body>", hex (same scheme as the origin and ADR 0030's inbound webhooks). */
export function signBody(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

const hostIs = (url: string, ok: (h: string) => boolean) => { const safe = safePublicHttpsUrl(url ?? ''); return !!safe && ok(new URL(safe).hostname.toLowerCase()); };
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export const NOTIFY_CONNECTORS = new Registry<NotifyConnector>('notification connector');

NOTIFY_CONNECTORS.register({
  id: 'sim_sink', label: 'Simulated sink (synthetic; messages are stored here and shown on the Integrations page)', vendors: [], live: false,
  fields: [{ key: 'failFirst', label: 'Simulated failures before success (0-5, for retry tests)', optional: true }],
  validate: (c) => (c.failFirst === undefined || c.failFirst === '' || /^[0-5]$/.test(c.failFirst) ? null : 'failFirst must be 0-5'),
  async send(ctx, c, body, text) {
    if (ctx.attemptsBefore < Number(c.failFirst || 0)) return { ok: false, status: 503, error: 'Simulated sink failure (fault injection)' };
    run(ctx.db, 'INSERT INTO notification_sink VALUES (?,?,?,?,?,?,?,?)', ctx.tenantId, ctx.clientId, newId('msg'), ctx.deliveryId, ctx.channelId, seal(text), seal(JSON.stringify(body)), nowIso());
    return { ok: true, status: 202 };
  },
});

NOTIFY_CONNECTORS.register({
  id: 'webhook', label: 'Signed webhook (your server, Zapier, Make, n8n)', vendors: [], live: true,
  fields: [{ key: 'url', label: 'Public https:// URL' }, { key: 'vendor', label: 'Who runs that URL (vendor id, for BAA checks)', optional: true },
    { key: 'secret', label: 'Signing secret (generated if left empty)', secret: true, optional: true }],
  validate: (c) => (!safePublicHttpsUrl(c.url ?? '') ? 'url must be a public https:// address' : c.vendor && !/^[a-z0-9][a-z0-9_-]{1,40}$/.test(c.vendor) ? 'vendor must be a vendor id' : null),
  async send(_ctx, c, body) {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(now().getTime() / 1000));
    const headers: Record<string, string> = { 'x-ar-event': String(body.type), 'x-ar-delivery': String(body.deliveryId ?? '') };
    if (c.secret) headers['x-ar-signature'] = `t=${ts},v1=${signBody(c.secret, ts, raw)}`;
    return post(c.url, raw, headers);
  },
});

NOTIFY_CONNECTORS.register({
  id: 'slack', label: 'Slack channel (incoming webhook)', vendors: ['slack'], live: true,
  fields: [{ key: 'url', label: 'Slack incoming-webhook URL (https://hooks.slack.com/...)', secret: true }],
  validate: (c) => (hostIs(c.url, (h) => h === 'hooks.slack.com') ? null : 'url must be a https://hooks.slack.com/ webhook'),
  send: (_ctx, c, _body, text) => post(c.url, JSON.stringify({ text })),
});

NOTIFY_CONNECTORS.register({
  id: 'teams', label: 'Microsoft Teams channel (Workflows webhook)', vendors: ['microsoft'], live: true,
  fields: [{ key: 'url', label: 'Teams Workflows webhook URL', secret: true }],
  validate: (c) => (hostIs(c.url, (h) => h.endsWith('.webhook.office.com') || h.endsWith('.logic.azure.com') || h.endsWith('.powerplatform.com')) ? null : 'url must be a Teams / Power Automate webhook'),
  send: (_ctx, c, _body, text) => post(c.url, JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive',
    content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text, wrap: true }] } }] })),
});

NOTIFY_CONNECTORS.register({
  id: 'email', label: 'Email (sent through Resend)', vendors: ['resend'], live: true,
  available: (s) => !!s.AR_RESEND_API_KEY && !!s.AR_EMAIL_FROM,
  fields: [{ key: 'to', label: 'Up to 5 addresses, comma separated' }],
  validate: (c) => { const to = (c.to ?? '').split(',').map((s) => s.trim()).filter(Boolean); return to.length && to.length <= 5 && to.every((a) => EMAIL.test(a)) ? null : 'to must be 1-5 email addresses'; },
  send: (_ctx, c, body, text) => post('https://api.resend.com/emails', JSON.stringify({ from: process.env.AR_EMAIL_FROM, to: c.to.split(',').map((s) => s.trim()).filter(Boolean), subject: subjectOf(body), text }),
    { authorization: `Bearer ${process.env.AR_RESEND_API_KEY ?? ''}` }),
});

NOTIFY_CONNECTORS.register({
  id: 'staff_sms', label: 'Text message to a staff phone (Twilio)', vendors: ['twilio'], live: true,
  available: (s) => !!s.AR_TWILIO_ACCOUNT_SID && !!s.AR_TWILIO_AUTH_TOKEN,
  fields: [{ key: 'to', label: 'Staff mobile number, +1...' }, { key: 'from', label: 'Send from (a Twilio number)' }],
  validate: (c) => (/^\+[1-9]\d{7,14}$/.test(c.to ?? '') && /^\+[1-9]\d{7,14}$/.test(c.from ?? '') ? null : 'to and from must be +E.164 numbers'),
  async send(_ctx, c, _body, text) {
    if (!liveSendsAllowed()) throw new LiveExecutionDisabled('Outbound notifications are disabled in this environment.');
    const sid = process.env.AR_TWILIO_ACCOUNT_SID ?? '';
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${sid}:${process.env.AR_TWILIO_AUTH_TOKEN ?? ''}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: c.to, From: c.from, Body: text.slice(0, 600) }), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: `HTTP ${r.status}` };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'send failed' }; }
  },
});

// ---------------------------------------------------------------- events and PHI rules

export function subjectOf(body: Record<string, unknown>): string {
  return `AR Resolve: ${LABEL[body.type as EventType] ?? 'notification'}`;
}

/** One readable line for chat, email and SMS destinations. Opaque ids unless details are allowed. */
export function summaryText(e: ArEvent): string {
  const d = e.data;
  const acct = e.details ? `account ${e.details.externalId} (${e.accountId})` : e.accountId ? `account ${e.accountId}` : '';
  const facts = Object.entries(d).map(([k, v]) => `${k}=${v}`).join(', ');
  const what = e.type === 'integration.test' ? 'This destination is connected. Real notifications will look like this.'
    : e.type === 'connector.circuit_open' ? `connector ${e.objectId} stopped after repeated failures`
      : `${acct}${e.objectType === 'action' ? `, action ${e.objectId}` : ''}`;
  return `${LABEL[e.type]} (${e.clientId}): ${what}${facts ? ` [${facts}]` : ''}. Open AR Resolve for details.`;
}

export function matches(events: string[], filter: EventFilter | null, e: ArEvent, ctx: { scenario: string | null; payerId: string | null; actionKind: string | null }): boolean {
  if (!(events.includes(e.type) || (events.includes('*') && e.type !== 'integration.test'))) return false;
  if (!filter) return true;
  if (filter.scenarios?.length && !filter.scenarios.includes(ctx.scenario ?? '')) return false;
  if (filter.payerIds?.length && !filter.payerIds.includes(ctx.payerId ?? '')) return false;
  if (filter.actionKinds?.length && !filter.actionKinds.includes(ctx.actionKind ?? '')) return false;
  return true;
}

/**
 * May this channel receive account details (external account number, scenario, payer)? Only when
 * it asks for them AND either the environment is synthetic or every vendor behind it has a BAA in
 * force. Pure, exported for tests.
 */
export function detailsAllowed(o: { includeDetails: boolean; synthetic: boolean; phiMode: boolean; vendors: string[]; signed: Set<string> }): boolean {
  if (!o.includeDetails) return false;
  if (o.synthetic && !o.phiMode) return true;
  return o.vendors.length > 0 && o.vendors.every((v) => o.signed.has(v));
}

const CODE = /^[\w.-]{1,60}$/;
function keepData(details: Record<string, unknown> | undefined, keep: string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const k of keep) {
    const v = details?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && CODE.test(v)) out[k] = v;
  }
  return out;
}

interface ChannelRow { tenant_id: string; client_id: string; channel_id: string; kind: string; name: string; config: string; events: string; filter: string | null; include_details: number; enabled: number;
  created_by: string; created_at: string; updated_by: string; updated_at: string }

const configOf = (r: ChannelRow) => JSON.parse(open(r.config)) as Record<string, string>;
const vendorsOf = (c: NotifyConnector, cfg: Record<string, string>) => [...c.vendors, ...(cfg.vendor ? [cfg.vendor.toLowerCase()] : [])];

/**
 * Called by audit() in the same transaction. Queues one delivery per matching channel. Never throws:
 * a notification problem must not undo the state change it describes.
 */
export function notifyFromAudit(db: Db, e: AuditInput, auditEventId: string): number {
  const m = AUDIT_EVENT_MAP[e.eventType];
  if (!m) return 0;
  try {
    const channels = all<ChannelRow>(db, 'SELECT * FROM notification_channels WHERE tenant_id=? AND client_id=? AND enabled=1', e.tenantId, e.clientId);
    if (!channels.length) return 0;
    const acct = e.accountId ? one<{ external_id: string; scenario: string; payer_id: string }>(db, 'SELECT external_id, scenario, payer_id FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', e.tenantId, e.clientId, e.accountId) : undefined;
    const data = keepData(e.details, m.keep);
    const ev: ArEvent = { id: auditEventId, type: m.type, occurredAt: nowIso(), tenantId: e.tenantId, clientId: e.clientId, accountId: e.accountId ?? null, objectType: e.objectType, objectId: e.objectId, data };
    const kind = typeof e.details?.kind === 'string' ? e.details.kind : null;
    let queued = 0;
    for (const ch of channels) {
      if (!matches(JSON.parse(ch.events), ch.filter ? JSON.parse(ch.filter) : null, ev, { scenario: acct?.scenario ?? null, payerId: acct?.payer_id ?? null, actionKind: kind })) continue;
      const withDetails = ch.include_details && acct ? { ...ev, details: { externalId: acct.external_id, scenario: acct.scenario, payerId: acct.payer_id } } : ev;
      queued += queue(db, ch, withDetails);
    }
    return queued;
  } catch (err) {
    console.error('[notifications] queue failed', (err as Error).message);
    return 0;
  }
}

function queue(db: Db, ch: ChannelRow, ev: ArEvent): number {
  return run(db, `INSERT INTO notification_deliveries VALUES (?,?,?,?,?,?,?,'pending',0,?,NULL,?,NULL) ON CONFLICT (tenant_id, client_id, channel_id, event_id) DO NOTHING`,
    ch.tenant_id, ch.client_id, newId('dlv'), ch.channel_id, ev.id, ev.type, seal(JSON.stringify(ev)), nowIso(), nowIso());
}

/** Next state after an attempt: delivered, retry later, or give up. Pure, for tests. */
export function afterAttempt(ok: boolean, attemptsBefore: number, at = now()): { status: 'delivered' | 'pending' | 'failed'; attempts: number; next: string | null } {
  const attempts = attemptsBefore + 1;
  if (ok) return { status: 'delivered', attempts, next: null };
  if (attempts >= MAX_ATTEMPTS) return { status: 'failed', attempts, next: null };
  return { status: 'pending', attempts, next: new Date(at.getTime() + BACKOFF_MIN[attempts - 1] * 60_000).toISOString() };
}

interface DeliveryRow { tenant_id: string; client_id: string; delivery_id: string; channel_id: string; event_id: string; event_type: string; payload: string; status: string; attempts: number;
  next_attempt_at: string | null; last_error: string | null; created_at: string; delivered_at: string | null }

/** Send due deliveries (worker tick, or a test/UI trigger for one scope). */
export async function deliverDue(db: Db, only?: { tenantId: string; clientId: string }, limit = 100): Promise<{ delivered: number; retrying: number; failed: number; refused: number }> {
  const rep = { delivered: 0, retrying: 0, failed: 0, refused: 0 };
  const rows = all<DeliveryRow>(db, `SELECT * FROM notification_deliveries WHERE status='pending' AND next_attempt_at <= ? ${only ? 'AND tenant_id=? AND client_id=?' : ''} ORDER BY next_attempt_at LIMIT ?`,
    ...(only ? [nowIso(), only.tenantId, only.clientId, limit] : [nowIso(), limit]));
  for (const d of rows) {
    const ch = one<ChannelRow>(db, 'SELECT * FROM notification_channels WHERE tenant_id=? AND client_id=? AND channel_id=?', d.tenant_id, d.client_id, d.channel_id);
    const c = ch ? NOTIFY_CONNECTORS.get(ch.kind) : undefined;
    if (!ch || !c || !ch.enabled) { finishDelivery(db, d, { status: 'refused', attempts: d.attempts, next: null }, 'Channel disabled or removed'); rep.refused++; continue; }
    const cfg = configOf(ch);
    const ev = JSON.parse(open(d.payload)) as ArEvent;
    // Re-check the details rule at send time: the BAA register or PHI mode may have changed.
    const synthetic = ENVIRONMENT_FOR_GATE === 'synthetic';
    if (ev.details && !detailsAllowed({ includeDetails: !!ch.include_details, synthetic, phiMode: phiModeOn(), vendors: vendorsOf(c, cfg), signed: signedVendors(db, { tenantId: d.tenant_id, clientId: d.client_id }) })) delete ev.details;
    const body = { ...ev, deliveryId: d.delivery_id, schema: NOTIFY_VERSION, simulated: !c.live };
    let r: SendResult;
    try {
      r = await c.send({ db, tenantId: d.tenant_id, clientId: d.client_id, deliveryId: d.delivery_id, channelId: d.channel_id, attemptsBefore: d.attempts }, cfg, body, summaryText(ev));
    } catch (err) {
      if (err instanceof LiveExecutionDisabled) r = { ok: false, refused: true, error: `LiveExecutionDisabled: ${err.message}` };
      else r = { ok: false, error: (err as Error).message.slice(0, 200) };
    }
    if (r.refused) { finishDelivery(db, d, { status: 'refused', attempts: d.attempts + 1, next: null }, r.error ?? 'refused'); rep.refused++; continue; }
    const next = afterAttempt(r.ok, d.attempts);
    finishDelivery(db, d, next, r.ok ? null : r.error ?? 'failed');
    if (next.status === 'delivered') rep.delivered++; else if (next.status === 'failed') rep.failed++; else rep.retrying++;
  }
  return rep;
}

function finishDelivery(db: Db, d: DeliveryRow, n: { status: string; attempts: number; next: string | null }, error: string | null) {
  tx(db, () => {
    run(db, 'UPDATE notification_deliveries SET status=?, attempts=?, next_attempt_at=?, last_error=?, delivered_at=? WHERE tenant_id=? AND client_id=? AND delivery_id=?',
      n.status, n.attempts, n.next, error ? error.slice(0, 300) : null, n.status === 'delivered' ? nowIso() : null, d.tenant_id, d.client_id, d.delivery_id);
    if (n.status === 'failed' || n.status === 'refused') audit(db, { tenantId: d.tenant_id, clientId: d.client_id, actorId: 'system:notifications', objectType: 'notification_channel', objectId: d.channel_id,
      eventType: n.status === 'failed' ? 'notification_failed' : 'notification_refused', details: { deliveryId: d.delivery_id, eventType: d.event_type, attempts: n.attempts } });
  });
}

export function startNotificationWorker(db: Db, intervalMs = 5000): () => void {
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    deliverDue(db).catch((err) => console.error('[notifications]', (err as Error).message)).finally(() => { busy = false; });
  }, intervalMs);
  t.unref?.();
  return () => clearInterval(t);
}

// ---------------------------------------------------------------- admin

function cleanFilter(f: unknown): EventFilter | null {
  if (f === undefined || f === null) return null;
  if (typeof f !== 'object' || Array.isArray(f)) throw invalid('filter must be an object');
  const out: EventFilter = {};
  for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
    if (!['scenarios', 'payerIds', 'actionKinds'].includes(k)) throw invalid(`Unknown filter key: ${k}`);
    if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === 'string' && CODE.test(x))) throw invalid(`filter.${k} must be a list of codes`);
    (out as Record<string, string[]>)[k] = v as string[];
  }
  return Object.keys(out).length ? out : null;
}

function cleanEvents(v: unknown): string[] {
  const events = [...new Set((Array.isArray(v) ? v : []).map(String))];
  if (!events.length || !events.every((e) => e === '*' || (EVENT_TYPES as readonly string[]).includes(e))) throw invalid(`events must be "*" or from: ${EVENT_TYPES.join(', ')}`);
  return events;
}

/** Check and store a new channel. Returns the id, plus the webhook signing secret once. */
export function createChannel(db: Db, scope: Scope, body: Record<string, unknown>) {
  requirePerm(scope, 'integration_admin');
  const c = NOTIFY_CONNECTORS.get(String(body.kind ?? ''));
  if (!c) throw invalid(`kind must be one of: ${NOTIFY_CONNECTORS.ids().join(', ')}`);
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries((body.config ?? {}) as Record<string, unknown>)) {
    if (!c.fields.some((f) => f.key === k)) throw invalid(`Unknown setting for ${c.id}: ${k}`);
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') config[k] = String(v).trim().slice(0, 500);
  }
  const bad = c.validate(config);
  if (bad) throw invalid(bad);
  const events = cleanEvents(body.events);
  const filter = cleanFilter(body.filter);
  const name = String(body.name ?? c.label ?? c.id).trim().slice(0, 80) || c.id;
  let secret: string | undefined;
  if (c.id === 'webhook' && !config.secret) { secret = randomBytes(24).toString('hex'); config.secret = secret; }
  return tx(db, () => {
    const id = newId('nch');
    run(db, 'INSERT INTO notification_channels VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?)', scope.tenantId, scope.clientId, id, c.id, name, seal(JSON.stringify(config)), JSON.stringify(events),
      filter ? JSON.stringify(filter) : null, body.includeDetails === true ? 1 : 0, scope.userId, nowIso(), scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'notification_channel', objectId: id, eventType: 'notification_channel_created',
      details: { kind: c.id, events, filter, includeDetails: body.includeDetails === true, live: c.live } });
    return { channelId: id, ...(secret ? { secret } : {}) };
  });
}

export function updateChannel(db: Db, scope: Scope, channelId: string, body: Record<string, unknown>) {
  requirePerm(scope, 'integration_admin');
  return tx(db, () => {
    const ch = one<ChannelRow>(db, 'SELECT * FROM notification_channels WHERE tenant_id=? AND client_id=? AND channel_id=?', scope.tenantId, scope.clientId, channelId);
    if (!ch) throw notFound('Notification channel');
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : !!ch.enabled;
    const events = body.events === undefined ? JSON.parse(ch.events) as string[] : cleanEvents(body.events);
    const filter = body.filter === undefined ? (ch.filter ? JSON.parse(ch.filter) : null) : cleanFilter(body.filter);
    const includeDetails = typeof body.includeDetails === 'boolean' ? body.includeDetails : !!ch.include_details;
    run(db, 'UPDATE notification_channels SET enabled=?, events=?, filter=?, include_details=?, updated_by=?, updated_at=? WHERE tenant_id=? AND client_id=? AND channel_id=?',
      enabled ? 1 : 0, JSON.stringify(events), filter ? JSON.stringify(filter) : null, includeDetails ? 1 : 0, scope.userId, nowIso(), scope.tenantId, scope.clientId, channelId);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'notification_channel', objectId: channelId, eventType: 'notification_channel_changed',
      details: { before: { enabled: !!ch.enabled, events: JSON.parse(ch.events), includeDetails: !!ch.include_details }, after: { enabled, events, filter, includeDetails } } });
    return listChannels(db, scope).find((c) => c.channelId === channelId)!;
  });
}

/** Channels for the settings page: destination host only, never secrets. */
export function listChannels(db: Db, scope: Scope) {
  requirePerm(scope, 'integration_admin');
  return all<ChannelRow & { failed: number; pending: number; last_delivered: string | null }>(db,
    `SELECT c.*, (SELECT COUNT(*) FROM notification_deliveries d WHERE d.tenant_id=c.tenant_id AND d.client_id=c.client_id AND d.channel_id=c.channel_id AND d.status IN ('failed','refused')) failed,
            (SELECT COUNT(*) FROM notification_deliveries d WHERE d.tenant_id=c.tenant_id AND d.client_id=c.client_id AND d.channel_id=c.channel_id AND d.status='pending') pending,
            (SELECT MAX(delivered_at) FROM notification_deliveries d WHERE d.tenant_id=c.tenant_id AND d.client_id=c.client_id AND d.channel_id=c.channel_id) last_delivered
     FROM notification_channels c WHERE c.tenant_id=? AND c.client_id=? ORDER BY c.created_at DESC, c.rowid DESC`, scope.tenantId, scope.clientId).map((r) => {
    const cfg = configOf(r);
    const conn = NOTIFY_CONNECTORS.get(r.kind);
    const dest = cfg.url ? new URL(cfg.url).hostname : cfg.to ? (r.kind === 'staff_sms' ? `…${cfg.to.slice(-4)}` : cfg.to) : r.kind === 'sim_sink' ? 'simulated sink' : '';
    return { channelId: r.channel_id, kind: r.kind, name: r.name, destination: dest, events: JSON.parse(r.events) as string[], filter: r.filter ? JSON.parse(r.filter) : null,
      includeDetails: !!r.include_details, enabled: !!r.enabled, live: conn?.live ?? false, vendors: conn ? vendorsOf(conn, cfg) : [], failed: r.failed, pending: r.pending, lastDelivered: r.last_delivered, createdAt: r.created_at };
  });
}

/** Vendors and details flag per connector kind for enabled channels (read by the PHI readiness view). */
export function enabledChannelVendors(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>): Map<string, { extraVendors: string[]; details: boolean }> {
  const out = new Map<string, { extraVendors: string[]; details: boolean }>();
  for (const r of all<ChannelRow>(db, 'SELECT * FROM notification_channels WHERE tenant_id=? AND client_id=? AND enabled=1', scope.tenantId, scope.clientId)) {
    const cfg = configOf(r);
    const prev = out.get(r.kind) ?? { extraVendors: [], details: false };
    out.set(r.kind, { extraVendors: [...prev.extraVendors, ...(cfg.vendor ? [cfg.vendor.toLowerCase()] : [])], details: prev.details || !!r.include_details });
  }
  return out;
}

export function listDeliveries(db: Db, scope: Scope, channelId?: string | null) {
  requirePerm(scope, 'integration_admin');
  return all<DeliveryRow>(db, `SELECT * FROM notification_deliveries WHERE tenant_id=? AND client_id=? ${channelId ? 'AND channel_id=?' : ''} ORDER BY created_at DESC, rowid DESC LIMIT 100`,
    ...(channelId ? [scope.tenantId, scope.clientId, channelId] : [scope.tenantId, scope.clientId]))
    .map((d) => ({ deliveryId: d.delivery_id, channelId: d.channel_id, eventId: d.event_id, eventType: d.event_type, status: d.status, attempts: d.attempts, nextAttemptAt: d.next_attempt_at,
      lastError: d.last_error, createdAt: d.created_at, deliveredAt: d.delivered_at }));
}

/** Messages the simulated sink received for this scope (what a destination would have shown). */
export function sinkMessages(db: Db, scope: Scope) {
  requirePerm(scope, 'integration_admin');
  return all<{ message_id: string; delivery_id: string; channel_id: string; text: string; body: string; received_at: string }>(db,
    'SELECT message_id, delivery_id, channel_id, text, body, received_at FROM notification_sink WHERE tenant_id=? AND client_id=? ORDER BY received_at DESC, rowid DESC LIMIT 100', scope.tenantId, scope.clientId)
    .map((m) => ({ messageId: m.message_id, deliveryId: m.delivery_id, channelId: m.channel_id, text: open(m.text), body: JSON.parse(open(m.body)), receivedAt: m.received_at }));
}

/** Queue a test event to one channel and deliver it now. */
export async function testChannel(db: Db, scope: Scope, channelId: string) {
  requirePerm(scope, 'integration_admin');
  const ch = one<ChannelRow>(db, 'SELECT * FROM notification_channels WHERE tenant_id=? AND client_id=? AND channel_id=?', scope.tenantId, scope.clientId, channelId);
  if (!ch) throw notFound('Notification channel');
  if (!ch.enabled) throw new AppError(409, 'channel_disabled', 'The channel is disabled');
  const ev: ArEvent = { id: newId('tst'), type: 'integration.test', occurredAt: nowIso(), tenantId: scope.tenantId, clientId: scope.clientId, accountId: null, objectType: 'notification_channel', objectId: channelId, data: {} };
  tx(db, () => queue(db, ch, ev));
  await deliverDue(db, scope);
  return listDeliveries(db, scope, channelId)[0];
}

export function catalog() {
  return {
    connectors: NOTIFY_CONNECTORS.list().map((c) => ({ id: c.id, label: c.label, fields: c.fields, vendors: c.vendors, live: c.live, ready: !c.available || c.available(process.env) })),
    events: EVENT_TYPES.filter((e) => e !== 'integration.test').map((e) => ({ id: e, label: LABEL[e] })),
    liveSends: liveSendsAllowed() ? 'enabled' : 'disabled',
  };
}
