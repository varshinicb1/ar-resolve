// Notification sends through real vendors (ADR 0100): Slack incoming webhooks and Postmark email.
// They plug into the existing notification outbox (server/services/notifications.ts, ADR 0070):
// queueing, idempotency per (channel, event), retries with backoff and the opaque-ids-only payload
// rule are unchanged. What changes is that a send may now leave the building when the gate opens:
//   - provider mode (AR_SLACK_MODE / AR_POSTMARK_MODE) is sandbox or production, credentials present;
//   - a connector authorization is recorded for this tenant/client (slack_notify / postmark_email);
//   - production also needs the deployment flag liveSendsAllowed() (non-synthetic + AR_NOTIFY_LIVE=on)
//     and the connector live gate for this scope.
// Sandbox sends are allowed in a synthetic environment: Postmark's test token validates without
// delivering; Slack has no test mode, so sandbox posts the synthetic, opaque-id message to the
// owner's test channel.
//
// Sources (retrieved 2026-10-14):
//   SL1 https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
//       POST the webhook URL (https://hooks.slack.com/services/T.../B.../...) with Content-type application/json
//       and a JSON body with `text`. "Your webhook URL contains a secret." Success body and error codes are not
//       stated on the page, so success is any 2xx.
//   PM1 https://postmarkapp.com/developer/api/overview
//       Base https://api.postmarkapp.com; header X-Postmark-Server-Token; the value POSTMARK_API_TEST "validates
//       your request without delivering the email"; errors are JSON {ErrorCode, Message}; 422 invalid, 429 rate, 500.
//   PM2 https://postmarkapp.com/developer/user-guide/send-email-with-api
//       POST https://api.postmarkapp.com/email with From, To, Subject, TextBody, MessageStream (defaults to the
//       outbound transactional stream); success {To, SubmittedAt, MessageID, ErrorCode: 0, Message: "OK"}; a
//       confirmed sender signature is required (422 otherwise).
//   PM3 https://postmarkapp.com/support/article/1041-is-postmark-hipaa-compliant
//       "We also cannot sign any Business Associate Agreements around HIPAA." Postmark therefore never receives
//       account details: the channel's `includeDetails` is refused for it below.
import type { Db } from '../../db/db.ts';
import type { Scope } from '../../services/auth.ts';
import { registerAdapter } from '../framework.ts';
import { LiveExecutionDisabled } from '../executors.ts';
import { NOTIFY_CONNECTORS, liveSendsAllowed, subjectOf, summaryText, type ArEvent, type SendResult, type SendContext } from '../../services/notifications.ts';
import { safePublicHttpsUrl } from '../safe-url.ts';
import { baseUrl, modeOf, readVar, type ProviderId } from './config.ts';
import { httpRequest, HttpFailure } from './http.ts';
import { providerGate } from './gate.ts';

export const NOTIFY_SOURCES = {
  slack: [{ title: 'Slack: sending messages using incoming webhooks (SL1)', url: 'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks', retrievedAt: '2026-10-14' }],
  postmark: [
    { title: 'Postmark API overview, test mode (PM1)', url: 'https://postmarkapp.com/developer/api/overview', retrievedAt: '2026-10-14' },
    { title: 'Postmark send email with API (PM2)', url: 'https://postmarkapp.com/developer/user-guide/send-email-with-api', retrievedAt: '2026-10-14' },
    { title: 'Postmark: is Postmark HIPAA compliant? (PM3: no BAA)', url: 'https://postmarkapp.com/support/article/1041-is-postmark-hipaa-compliant', retrievedAt: '2026-10-14' },
  ],
};

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// Framework descriptors so authorizations, revocations and the gate use the same machinery as payer
// connectors. They have no invoke() capabilities: sends go through the notification outbox.
for (const [id, p, name, vendor] of [['slack_notify', 'slack', 'Slack notifications (incoming webhooks)', 'Slack'], ['postmark_email', 'postmark', 'Email notifications (Postmark)', 'Postmark']] as const) {
  registerAdapter({
    descriptor: {
      id, displayName: name, vendor, kind: 'notification', defaultMode: 'disabled_live', liveCapable: true, capabilities: [], transactions: ['Staff notifications (opaque ids only)'],
      configFields: [], phi: false, requiresBaa: false,
      notes: p === 'postmark' ? ['Postmark states it cannot sign a BAA (PM3): channels never include account details, whatever the channel setting.', 'Sandbox uses the documented POSTMARK_API_TEST token: validated, never delivered.']
        : ['Slack has no test mode: sandbox posts the synthetic message to the webhook you configure (use a test channel).', 'Messages carry opaque ids and event codes only (ADR 0070).'],
      sources: NOTIFY_SOURCES[p],
      // Vendors are declared on the notification layer (NOTIFY_CONNECTORS), which applies the BAA rule to details.
      vendors: [],
    } as never,
    execute() { throw new LiveExecutionDisabled('Notification connectors send through the notification outbox, not invoke().'); },
  });
}

/** Gate for one delivery. Throws LiveExecutionDisabled with every reason (recorded as a refused delivery). */
function assertNotifyGate(ctx: SendContext, p: ProviderId) {
  const scope = { tenantId: ctx.tenantId, clientId: ctx.clientId, userId: 'system:notify', roles: [] } as unknown as Scope;
  const g = providerGate(ctx.db as Db, scope, p);
  const reasons = [...g.reasons];
  if (g.mode === 'production' && !liveSendsAllowed()) reasons.push('Production sends need a non-synthetic environment and AR_NOTIFY_LIVE=on.');
  if (reasons.length) throw new LiveExecutionDisabled(`${p} notifications are disabled: ${reasons.join(' ')}`);
  return g.mode;
}

async function send(url: string, headers: Record<string, string>, body: string): Promise<SendResult & { json?: unknown }> {
  try {
    // A notification is a write: never retried here; the outbox retries with backoff (ADR 0070).
    const r = await httpRequest({ method: 'POST', url, headers, body, idempotentRead: false, timeoutMs: 5_000 });
    return r.status >= 200 && r.status < 300 ? { ok: true, status: r.status, json: r.json } : { ok: false, status: r.status, error: `HTTP ${r.status}`, json: r.json };
  } catch (err) {
    return { ok: false, error: err instanceof HttpFailure ? err.message : (err as Error).message.slice(0, 200) };
  }
}

export async function slackPost(url: string, text: string): Promise<SendResult> {
  const safe = safePublicHttpsUrl(url);
  if (!safe || new URL(safe).hostname !== 'hooks.slack.com') return { ok: false, error: 'Not a https://hooks.slack.com/ webhook URL' };
  const r = await send(safe, { 'content-type': 'application/json' }, JSON.stringify({ text }));
  return { ok: r.ok, status: r.status, error: r.error };
}

export async function postmarkSend(o: { to: string[]; subject: string; text: string }): Promise<SendResult & { messageId?: string; errorCode?: number }> {
  const mode = modeOf('postmark');
  const b = baseUrl('postmark', 'api');
  if (!b.url) return { ok: false, error: b.error ?? 'No base URL' };
  const from = readVar('AR_POSTMARK_FROM');
  const token = mode === 'sandbox' ? 'POSTMARK_API_TEST' : readVar('AR_POSTMARK_SERVER_TOKEN');
  if (!from || !token) return { ok: false, error: 'Postmark sender or token is not configured' };
  const stream = readVar('AR_POSTMARK_MESSAGE_STREAM');
  const body: Record<string, string> = { From: from, To: o.to.join(','), Subject: o.subject.slice(0, 200), TextBody: o.text.slice(0, 4000) };
  if (stream) body.MessageStream = stream;
  const r = await send(`${b.url}/email`, { accept: 'application/json', 'content-type': 'application/json', 'x-postmark-server-token': token }, JSON.stringify(body));
  const j = (r.json ?? {}) as { ErrorCode?: unknown; MessageID?: unknown; Message?: unknown };
  const errorCode = typeof j.ErrorCode === 'number' ? j.ErrorCode : undefined;
  if (r.ok && errorCode === 0) return { ok: true, status: r.status, messageId: typeof j.MessageID === 'string' ? j.MessageID : undefined, errorCode };
  return { ok: false, status: r.status, errorCode, error: `Postmark ${r.status ?? ''} ErrorCode ${errorCode ?? '?'}${typeof j.Message === 'string' ? `: ${j.Message.slice(0, 160)}` : ''}` };
}

// Slack: same id and settings as the ADR 0070 connector, now with the gate in front of the send.
const previousSlack = NOTIFY_CONNECTORS.require('slack');
NOTIFY_CONNECTORS.register({
  ...previousSlack,
  label: 'Slack channel (incoming webhook)',
  async send(ctx, c, _body, text) {
    assertNotifyGate(ctx, 'slack');
    return slackPost(c.url, text);
  },
});

NOTIFY_CONNECTORS.register({
  id: 'postmark', label: 'Email (sent through Postmark; opaque ids only, Postmark signs no BAA)', vendors: ['postmark'], live: true,
  fields: [{ key: 'to', label: 'Up to 5 addresses, comma separated' }],
  validate: (c) => { const to = (c.to ?? '').split(',').map((s) => s.trim()).filter(Boolean); return to.length && to.length <= 5 && to.every((a) => EMAIL.test(a)) ? null : 'to must be 1-5 email addresses'; },
  async send(ctx, c, body, text) {
    assertNotifyGate(ctx, 'postmark');
    // PM3: no BAA is possible, so details never go to Postmark even if a channel asked for them.
    const { details, ...opaque } = body as unknown as ArEvent;
    const safeText = details ? summaryText(opaque as ArEvent) : text;
    return postmarkSend({ to: c.to.split(',').map((s) => s.trim()).filter(Boolean), subject: subjectOf(body), text: safeText });
  },
});
