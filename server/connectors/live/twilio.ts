// Twilio Programmable Voice: gated connector for outbound payer calls (ADR 0100). This extends the
// existing telephony layer (server/connectors/telephony/twilio.ts, server/connectors/live-voice.ts) and
// does not duplicate it: production call placement stays with LiveTelephonyAdapter, which the approved
// voice workflow would drive and which remains refused until a Conversation Relay socket server exists.
//
// What is real here: sandbox mode uses Twilio TEST credentials, which Twilio documents as never placing
// or charging calls, so the adapter can exercise authentication, the Calls request shape and error
// handling end to end.
//
// Sources (retrieved 2026-10-14):
//   TW-T1 https://www.twilio.com/docs/iam/test-credentials
//         Calls are supported with test credentials: POST /2010-04-01/Accounts/{TestAccountSid}/Calls. Magic From
//         +15005550006 is valid; magic To +15005550001 invalid (21217), +15005550002 not routable (21214),
//         +15005550003 no international permission (21215), +15005550004 blocked (21216); other To numbers are
//         validated normally (the page's example uses To +14108675310, Url http://demo.twilio.com/docs/voice.xml).
//         "Twilio doesn't charge your account, update the state of your account, or connect to real phone
//         numbers"; the Url is not requested and no status callbacks fire. Other resources return 403.
//   TW-T2 https://www.twilio.com/docs/usage/requests-to-twilio
//         HTTP Basic auth with Account SID / Auth Token; POST bodies application/x-www-form-urlencoded.
//   S-TW2 (ADR 0070) https://www.twilio.com/docs/voice/api/call-resource: To, From, Url | Twiml.
import type { Db } from '../../db/db.ts';
import type { Scope } from '../../services/auth.ts';
import { type AdapterResult, type ConnectorAdapter, type ConnectorRequest, registerAdapter } from '../framework.ts';
import { twilio as twilioStub } from '../live-adapters.ts';
import { baseUrl, modeOf, readVar } from './config.ts';
import { httpRequest, HttpFailure } from './http.ts';
import { providerGate } from './gate.ts';

export const TWILIO_TEST_SOURCES = [
  { title: 'Twilio test credentials (TW-T1)', url: 'https://www.twilio.com/docs/iam/test-credentials', retrievedAt: '2026-10-14' },
  { title: 'Twilio requests to the API (TW-T2)', url: 'https://www.twilio.com/docs/usage/requests-to-twilio', retrievedAt: '2026-10-14' },
];

export const MAGIC_FROM = '+15005550006';
/** Documented test destinations and the error code Twilio documents for each (null = accepted). */
export const TEST_DESTINATIONS: Record<string, number | null> = { '+14108675310': null, '+15005550001': 21217, '+15005550002': 21214, '+15005550003': 21215, '+15005550004': 21216 };
export const DEMO_TWIML_URL = 'http://demo.twilio.com/docs/voice.xml';

/** One Calls request with TEST credentials. Never retried (it is a create, even if Twilio does not place it). */
export async function testCall(to: string, timeoutMs: number): Promise<AdapterResult> {
  const started = Date.now();
  if (!(to in TEST_DESTINATIONS)) return { outcome: 'rejected', error: 'Sandbox calls may only target Twilio-documented test numbers' };
  const sid = readVar('AR_TWILIO_TEST_ACCOUNT_SID');
  const tokenValue = readVar('AR_TWILIO_TEST_AUTH_TOKEN');
  if (!sid || !tokenValue) return { outcome: 'error', error: 'Twilio test credentials are not configured' };
  if (!/^AC[0-9a-zA-Z]{8,64}$/.test(sid)) return { outcome: 'rejected', error: 'AR_TWILIO_TEST_ACCOUNT_SID must start with AC' };
  const b = baseUrl('twilio', 'api');
  if (!b.url) return { outcome: 'error', error: b.error ?? 'No base URL' };
  try {
    const r = await httpRequest({ method: 'POST', url: `${b.url}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, idempotentRead: false, timeoutMs,
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${tokenValue}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ To: to, From: MAGIC_FROM, Url: DEMO_TWIML_URL }).toString() });
    const j = (r.json ?? {}) as { sid?: unknown; status?: unknown; code?: unknown; message?: unknown };
    const code = typeof j.code === 'number' ? j.code : null;
    const normalized = { httpStatus: r.status, sid: typeof j.sid === 'string' ? j.sid : null, status: typeof j.status === 'string' ? j.status : null, code, placed: false };
    if (r.status >= 200 && r.status < 300 && typeof j.sid === 'string') return { outcome: 'success', latencyMs: r.latencyMs, normalized, externalRefs: { callSid: j.sid } };
    // The HTTP status for these errors is not stated on TW-T1; any 4xx carrying a Twilio error code is a rejection.
    if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403 && code !== null) return { outcome: 'rejected', latencyMs: r.latencyMs, normalized, error: `Twilio error ${code}${typeof j.message === 'string' ? `: ${j.message.slice(0, 160)}` : ''}` };
    return { outcome: 'error', latencyMs: r.latencyMs, normalized, error: `HTTP ${r.status}` };
  } catch (err) {
    if (err instanceof HttpFailure) return { outcome: err.kind === 'timeout' ? 'timeout' : 'error', error: err.message, latencyMs: Date.now() - started };
    return { outcome: 'error', error: (err as Error).message.slice(0, 300), latencyMs: Date.now() - started };
  }
}

export const twilioAdapter: ConnectorAdapter = {
  descriptor: {
    ...twilioStub.descriptor,
    displayName: 'Twilio (voice: test-credential calls; live calls via the approved voice workflow)',
    configFields: [{ key: 'AR_TWILIO_MODE', label: 'off | sandbox | production (environment)' }, { key: 'AR_TWILIO_TEST_ACCOUNT_SID', label: 'Test Account SID' },
      { key: 'AR_TWILIO_TEST_AUTH_TOKEN', label: 'Test Auth Token', secret: true }, ...twilioStub.descriptor.configFields],
    notes: [...twilioStub.descriptor.notes,
      'Sandbox uses Twilio test credentials: requests are validated but no call is placed or charged, and no callbacks fire (TW-T1).',
      'Production calls are placed only by the approved voice workflow through LiveTelephonyAdapter; that path stays refused until the Conversation Relay socket server exists (ADR 0100, blocked).'],
    sources: [...twilioStub.descriptor.sources, ...TWILIO_TEST_SOURCES],
  },
  gate: (db: Db, scope: Scope) => providerGate(db, scope, 'twilio').reasons,
  execute() { throw new Error('twilio performs network I/O; use the async path'); },
  async executeAsync(_ctx, req: ConnectorRequest): Promise<AdapterResult> {
    if (req.actionClass !== 'call') return { outcome: 'rejected', error: `Unsupported action class ${req.actionClass}` };
    if (modeOf('twilio') !== 'sandbox') return { outcome: 'rejected', error: 'Production calls are placed only through the approved voice workflow (LiveTelephonyAdapter), which is not wired yet.' };
    return testCall(String(req.payload.to ?? ''), Math.max(1000, req.timeBudgetMs - 250));
  },
};
registerAdapter(twilioAdapter);
