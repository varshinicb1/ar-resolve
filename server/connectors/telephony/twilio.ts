// Ported from clinic-receptionist src/twilio.ts and src/dialer.ts (same owner): Twilio request
// signature validation, TwiML builders and the REST request shapes for an outbound call.
//
// Adapted for AR Resolve: node:crypto HMAC instead of WebCrypto, pure functions with no Worker
// Request/Response objects, an outbound payer call (the agent calls the payer; the origin answers
// patients), and no speech vendor choices (those are a procurement decision, docs/07 checklist).
// Nothing here performs network I/O; live-voice.ts decides whether a request may be sent.
//
// Sources read 2026-10-12 (every behaviour below comes from these pages):
//   S-TW1 https://www.twilio.com/docs/usage/security
//         X-Twilio-Signature = Base64(HMAC-SHA1(AuthToken, URL + POST params sorted by name with
//         Unix-style case-sensitive ordering, each name and value appended with no delimiter)).
//         Worked example: token 12345 -> "L/OH5YylLD5NRKLltdqwSvS0BnU=". JSON bodies are not
//         parameters (bodySHA256 query parameter instead). Voice over HTTPS drops credentials and
//         the port from the signed URL. WSS handshakes may need a trailing "/".
//   S-TW2 https://www.twilio.com/docs/voice/api/call-resource
//         POST /2010-04-01/Accounts/{AccountSid}/Calls.json with To, From, Url | Twiml,
//         StatusCallback, StatusCallbackEvent (initiated, ringing, answered, completed; one parameter
//         per value), StatusCallbackMethod (default POST), Timeout (default 60, max 600), Record.
//         Status callbacks carry CallSid, AccountSid, CallStatus (queued, initiated, ringing,
//         in-progress, completed, busy, failed, no-answer, canceled), CallDuration (terminal),
//         Timestamp, CallbackSource (call-progress-events), SequenceNumber (from 0; events may
//         arrive out of order).
//   S-TW3 https://www.twilio.com/docs/voice/tutorials/how-to-modify-calls-in-progress
//         End an in-progress call: update the Call resource with Status=completed.
//   S-TW4 https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
//         <Connect action="..."><ConversationRelay url="wss://..." welcomeGreeting="..."/></Connect>;
//         url is required and must be wss://; optional language, interruptible (none|dtmf|speech|any),
//         dtmfDetection; <Parameter name value/> children reach the socket as customParameters;
//         on end Twilio requests the action URL with SessionId, SessionStatus, SessionDuration,
//         HandoffData. The page calls Conversation Relay a "HIPAA Eligible Service when configured
//         properly" and says a signed BAA is needed for HIPAA-regulated use.
// SID shapes are checked only as "AC..." / "CA..." prefixes plus alphanumerics; the exact length was
// not confirmed from the pages above, so it is not enforced.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TWILIO_SOURCES = [
  { id: 'S-TW1', title: 'Twilio webhook security', url: 'https://www.twilio.com/docs/usage/security', retrievedAt: '2026-10-12' },
  { id: 'S-TW2', title: 'Twilio Call resource', url: 'https://www.twilio.com/docs/voice/api/call-resource', retrievedAt: '2026-10-12' },
  { id: 'S-TW3', title: 'Modify calls in progress', url: 'https://www.twilio.com/docs/voice/tutorials/how-to-modify-calls-in-progress', retrievedAt: '2026-10-12' },
  { id: 'S-TW4', title: 'TwiML <ConversationRelay>', url: 'https://www.twilio.com/docs/voice/twiml/connect/conversationrelay', retrievedAt: '2026-10-12' },
];

/** Compute X-Twilio-Signature for a URL and (for form POSTs) its parameters (S-TW1). */
export function twilioSignature(authToken: string, url: string, params: [string, string][] = []): string {
  // Unix-style case-sensitive sort by name, then value; appended with no delimiters.
  const sorted = [...params].sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const data = url + sorted.map(([k, v]) => k + v).join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type TwilioAuth = { ok: true; params: [string, string][] } | { ok: false; status: number; reason: 'not_configured' | 'missing_signature' | 'bad_signature' };

/**
 * Verify a Twilio webhook. Fails CLOSED: with no auth token configured every request is refused
 * (503), never accepted. `urls` lists the URL forms Twilio may have signed (see signedUrlForms).
 */
export function verifyTwilio(authToken: string | undefined | null, urls: string[], signature: string | undefined, formBody: string | null): TwilioAuth {
  if (!authToken) return { ok: false, status: 503, reason: 'not_configured' };
  if (!signature) return { ok: false, status: 401, reason: 'missing_signature' };
  const params: [string, string][] = formBody ? [...new URLSearchParams(formBody).entries()] : [];
  for (const url of urls) if (safeEqual(signature, twilioSignature(authToken, url, params))) return { ok: true, params };
  return { ok: false, status: 403, reason: 'bad_signature' };
}

/**
 * URL forms a request may have been signed with. Voice over HTTPS drops credentials and the port
 * (S-TW1); a WSS handshake may be signed with a trailing "/" (S-TW1). Every form is keyed by the
 * same secret, so accepting any of them does not weaken the check.
 */
export function signedUrlForms(url: string, opts: { websocket?: boolean } = {}): string[] {
  const u = new URL(url);
  u.username = '';
  u.password = '';
  const forms = new Set<string>([u.toString()]);
  if (u.protocol === 'https:' && u.port) { const p = new URL(u.toString()); p.port = ''; forms.add(p.toString()); }
  if (opts.websocket) for (const f of [...forms]) forms.add(f.endsWith('/') ? f.slice(0, -1) : `${f}/`);
  return [...forms];
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function twimlDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

export interface RelayTwimlConfig {
  /** wss:// URL of the agent's Conversation Relay socket. Required, must be wss (S-TW4). */
  relayUrl: string;
  /** https:// URL Twilio requests when the relay session ends (S-TW4 <Connect action>). */
  actionUrl: string;
  /** Spoken first. For a payer call this is the automation disclosure from the client call policy. */
  welcomeGreeting: string;
  language?: string;
  /** Payer reps should not interrupt read-backs by accident; default "speech" (S-TW4 values). */
  interruptible?: 'none' | 'dtmf' | 'speech' | 'any';
  /** IVR navigation needs DTMF events on the socket (S-TW4). */
  dtmfDetection?: boolean;
  /** Opaque ids only (call id, scope token). Never patient data: parameters are logged by the provider. */
  parameters?: Record<string, string>;
}

const OPAQUE_PARAM = /^[\w.:-]{1,120}$/;

/** TwiML that hands an answered outbound payer call to Conversation Relay (S-TW4). */
export function relayTwiml(cfg: RelayTwimlConfig): string {
  if (!/^wss:\/\//.test(cfg.relayUrl)) throw new Error('relayUrl must be a wss:// URL');
  if (!/^https:\/\//.test(cfg.actionUrl)) throw new Error('actionUrl must be an https:// URL');
  for (const [k, v] of Object.entries(cfg.parameters ?? {})) if (!OPAQUE_PARAM.test(k) || !OPAQUE_PARAM.test(v)) throw new Error(`Relay parameter ${k} must be an opaque id`);
  const attrs: [string, string][] = [
    ['url', cfg.relayUrl],
    ['welcomeGreeting', cfg.welcomeGreeting],
    ['language', cfg.language ?? 'en-US'],
    ['interruptible', cfg.interruptible ?? 'speech'],
    ['dtmfDetection', cfg.dtmfDetection === false ? 'false' : 'true'],
  ];
  const params = Object.entries(cfg.parameters ?? {}).map(([k, v]) => `<Parameter name="${xmlEscape(k)}" value="${xmlEscape(v)}"/>`).join('');
  return twimlDocument(`<Connect action="${xmlEscape(cfg.actionUrl)}"><ConversationRelay ${attrs.map(([k, v]) => `${k}="${xmlEscape(v)}"`).join(' ')}>${params}</ConversationRelay></Connect>`);
}

/**
 * TwiML for the <Connect action> request when a relay session ends. A hand-off dials the client's
 * specialist line (configuration, E.164); anything else hangs up. HandoffData is untrusted input
 * from our own socket and is only read for a reason code.
 */
export function relayDoneTwiml(params: [string, string][], specialistLine: string | null): string {
  const p = new Map(params);
  let reason = '';
  try { reason = String((JSON.parse(p.get('HandoffData') ?? '{}') as { reason?: unknown }).reason ?? ''); } catch { reason = ''; }
  if (reason === 'handoff_to_human' && specialistLine && /^\+[1-9]\d{7,14}$/.test(specialistLine)) return twimlDocument(`<Dial>${xmlEscape(specialistLine)}</Dial>`);
  return twimlDocument('<Hangup/>');
}

export interface TwilioAccount { accountSid: string; authToken: string; apiBase?: string }

export interface HttpRequestShape { method: 'POST' | 'GET'; url: string; headers: Record<string, string>; body: string | null }

const E164 = /^\+[1-9]\d{7,14}$/;
const STATUS_EVENTS = ['initiated', 'ringing', 'answered', 'completed'] as const;

function apiRoot(a: TwilioAccount): string {
  if (!/^AC[0-9a-zA-Z]{8,64}$/.test(a.accountSid)) throw new Error('accountSid must start with AC');
  return `${(a.apiBase ?? 'https://api.twilio.com').replace(/\/$/, '')}/2010-04-01/Accounts/${encodeURIComponent(a.accountSid)}`;
}

function basicAuth(a: TwilioAccount): string {
  return `Basic ${Buffer.from(`${a.accountSid}:${a.authToken}`).toString('base64')}`;
}

/** Create Call request (S-TW2). Inline TwiML keeps the agent's first words out of a fetch round trip. */
export function createCallRequest(a: TwilioAccount, o: { to: string; from: string; twiml: string; statusCallback: string; timeoutSeconds?: number; record?: boolean }): HttpRequestShape {
  if (!E164.test(o.to) || !E164.test(o.from)) throw new Error('to and from must be E.164 numbers');
  if (!/^https:\/\//.test(o.statusCallback)) throw new Error('statusCallback must be an https:// URL');
  if (o.twiml.length > 4000) throw new Error('Inline TwiML is limited to 4000 characters');
  const timeout = Math.max(1, Math.min(600, Math.round(o.timeoutSeconds ?? 60)));
  const body = new URLSearchParams({ To: o.to, From: o.from, Twiml: o.twiml, StatusCallback: o.statusCallback, StatusCallbackMethod: 'POST', Timeout: String(timeout), Record: o.record ? 'true' : 'false' });
  for (const e of STATUS_EVENTS) body.append('StatusCallbackEvent', e);
  return { method: 'POST', url: `${apiRoot(a)}/Calls.json`, headers: { authorization: basicAuth(a), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() };
}

/** End an in-progress call (S-TW3: Status=completed). */
export function endCallRequest(a: TwilioAccount, callSid: string): HttpRequestShape {
  if (!/^CA[0-9a-zA-Z]{8,64}$/.test(callSid)) throw new Error('callSid must start with CA');
  return { method: 'POST', url: `${apiRoot(a)}/Calls/${callSid}.json`, headers: { authorization: basicAuth(a), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ Status: 'completed' }).toString() };
}

/** Redirect a live call to new TwiML (S-TW3), used for a warm transfer to the specialist line. */
export function redirectCallRequest(a: TwilioAccount, callSid: string, twiml: string): HttpRequestShape {
  if (!/^CA[0-9a-zA-Z]{8,64}$/.test(callSid)) throw new Error('callSid must start with CA');
  return { method: 'POST', url: `${apiRoot(a)}/Calls/${callSid}.json`, headers: { authorization: basicAuth(a), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ Twiml: twiml }).toString() };
}

export function fetchCallRequest(a: TwilioAccount, callSid: string): HttpRequestShape {
  if (!/^CA[0-9a-zA-Z]{8,64}$/.test(callSid)) throw new Error('callSid must start with CA');
  return { method: 'GET', url: `${apiRoot(a)}/Calls/${callSid}.json`, headers: { authorization: basicAuth(a), accept: 'application/json' }, body: null };
}

export const CALL_STATUSES = ['queued', 'initiated', 'ringing', 'in-progress', 'completed', 'busy', 'failed', 'no-answer', 'canceled'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];
export const TERMINAL_CALL_STATUSES: CallStatus[] = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];

export interface TwilioStatusEvent { callSid: string; accountSid: string; status: CallStatus; sequenceNumber: number | null; timestamp: string | null; durationSeconds: number | null; dedupeKey: string; terminal: boolean }

/** Parse a status callback's form parameters (S-TW2). Returns null when a required field is missing or unknown. */
export function parseStatusCallback(params: [string, string][]): TwilioStatusEvent | null {
  const p = new Map(params);
  const callSid = p.get('CallSid') ?? '';
  const accountSid = p.get('AccountSid') ?? '';
  const status = (p.get('CallStatus') ?? '') as CallStatus;
  if (!/^CA[0-9a-zA-Z]{8,64}$/.test(callSid) || !/^AC[0-9a-zA-Z]{8,64}$/.test(accountSid) || !CALL_STATUSES.includes(status)) return null;
  const seqRaw = p.get('SequenceNumber');
  const sequenceNumber = seqRaw !== undefined && /^\d+$/.test(seqRaw) ? Number(seqRaw) : null;
  const dur = p.get('CallDuration');
  // Events may arrive out of order (S-TW2): the dedupe key is the call, its sequence number and status.
  return { callSid, accountSid, status, sequenceNumber, timestamp: p.get('Timestamp') ?? null, durationSeconds: dur && /^\d+$/.test(dur) ? Number(dur) : null,
    dedupeKey: `${callSid}:${sequenceNumber ?? 'na'}:${status}`, terminal: TERMINAL_CALL_STATUSES.includes(status) };
}
