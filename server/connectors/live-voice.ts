// Telephony adapter boundary for payer calls (docs/07 adapter contract: call
// adapters expose start, cancel, transfer and retrieve structured result; signed
// status callbacks per "Signed webhook ingestion").
//
// The live adapter is a complete Twilio implementation (ADR 0070), ported from
// clinic-receptionist src/dialer.ts, src/twilio.ts and src/relay.ts (same owner): outbound call
// creation with Conversation Relay TwiML, hang-up, warm transfer by redirect, call retrieval and
// X-Twilio-Signature verification of status callbacks (server/connectors/telephony/twilio.ts).
// It is REFUSED here: every method first asks its gate, and the gate is closed while the
// environment is synthetic, AR_PHI_MODE is off, credentials are absent, or the PHI gate and the
// connector live gate (customer authorization, onboarding, BAA register) are not satisfied.
// No call is ever placed from this repository. Phase 0 calls use sim-voice.ts only.
import { LiveExecutionDisabled } from './executors.ts';
import { ENVIRONMENT_FOR_GATE } from './framework.ts';
import {
  createCallRequest, endCallRequest, fetchCallRequest, parseStatusCallback, redirectCallRequest, relayTwiml, signedUrlForms, twimlDocument, verifyTwilio,
  type HttpRequestShape, type TwilioAccount,
} from './telephony/twilio.ts';

export interface StartCallRequest {
  requestId: string;              // internal call id
  tenantId: string;
  clientId: string;
  accountRevision: number;
  idempotencyKey: string;
  destination: string;            // allowlisted destination id, resolved server-side
  timeBudgetSeconds: number;
  recording: { enabled: boolean; consentMode: 'all_party' | 'one_party' };
}

export interface StartCallResult { providerCallId: string; status: 'queued' }
export interface CancelResult { status: 'cancel_requested' | 'already_ended' }
export interface TransferResult { status: 'transfer_requested' | 'not_connected' }
export interface CallResult {
  providerCallId: string;
  status: 'in_progress' | 'ended' | 'unknown';
  endedBy: 'payer' | 'agent' | 'provider' | null;
  endReason: string | null;
  recordingAvailable: boolean;
}
export interface StatusCallback { eventId: string; providerCallId: string; type: 'call.ended' | 'call.status'; at: string; reason?: string }
export type CallbackVerification = { ok: true; event: StatusCallback } | { ok: false; reason: 'bad_signature' | 'stale_timestamp' | 'malformed' | 'not_configured' };

export interface VoiceAdapter {
  name: string;
  live: boolean;
  startCall(req: StartCallRequest): StartCallResult;
  cancelCall(providerCallId: string, reason: string): CancelResult;
  transferCall(providerCallId: string, target: { kind: 'human_queue'; queue: string }): TransferResult;
  retrieveResult(providerCallId: string): CallResult;
  verifyStatusCallback(rawBody: string, signature: string | undefined, timestamp: string | undefined): CallbackVerification;
}

/** Network calls are asynchronous; the step engine must run them outside its step transaction. */
export interface AsyncVoiceAdapter {
  startCallAsync(req: StartCallRequest & { to: string; welcomeGreeting: string }): Promise<StartCallResult>;
  cancelCallAsync(providerCallId: string): Promise<CancelResult>;
  transferCallAsync(providerCallId: string): Promise<TransferResult>;
  retrieveResultAsync(providerCallId: string): Promise<CallResult>;
}

// Configuration the live adapter reads. Secrets are referenced, never stored here: the auth token
// is read from the environment variable named by authTokenRef at call time.
export interface LiveTelephonyConfig {
  provider: 'twilio';             // adapter implementation; no provider contract exists
  contract: null;                 // no signed agreement
  baaSigned: false;               // the vendor register (governance) is the source of truth
  hipaaEligibleServicesConfirmed: false;
  mediaRegion: null;
  credentialsCustodian: null;
  accountSid: string | null;      // AR_TWILIO_ACCOUNT_SID
  authTokenRef: string;           // name of the environment variable holding the auth token
  callerId: string | null;        // AR_TWILIO_CALLER_ID (E.164)
  publicBaseUrl: string | null;   // AR_PUBLIC_BASE_URL (https), for status callbacks and the relay action
  relayUrl: string | null;        // AR_TWILIO_RELAY_URL (wss), the agent socket
  specialistLine: string | null;  // AR_SPECIALIST_LINE (E.164), warm-transfer target
  destinations: Record<string, string>; // allowlisted destination id -> E.164, from configuration
  authorizationRecordId: null;    // customer authorization for live calls (connector_authorizations)
}

export function liveTelephonyConfig(env: Record<string, string | undefined> = process.env): LiveTelephonyConfig {
  let destinations: Record<string, string> = {};
  try { destinations = env.AR_TWILIO_DESTINATIONS ? JSON.parse(env.AR_TWILIO_DESTINATIONS) : {}; } catch { destinations = {}; }
  return {
    provider: 'twilio', contract: null, baaSigned: false, hipaaEligibleServicesConfirmed: false, mediaRegion: null, credentialsCustodian: null,
    accountSid: env.AR_TWILIO_ACCOUNT_SID ?? null, authTokenRef: 'AR_TWILIO_AUTH_TOKEN', callerId: env.AR_TWILIO_CALLER_ID ?? null,
    publicBaseUrl: env.AR_PUBLIC_BASE_URL ?? null, relayUrl: env.AR_TWILIO_RELAY_URL ?? null, specialistLine: env.AR_SPECIALIST_LINE ?? null,
    destinations, authorizationRecordId: null,
  };
}

export const LIVE_TELEPHONY_CONFIG: LiveTelephonyConfig = liveTelephonyConfig({});

/** Deployment-level reasons live telephony is refused. Tenant-level reasons come from the connector live gate. */
export function deploymentTelephonyReasons(cfg: LiveTelephonyConfig, env: Record<string, string | undefined> = process.env, environment: string = ENVIRONMENT_FOR_GATE): string[] {
  const reasons: string[] = [];
  if (environment === 'synthetic') reasons.push('This environment is synthetic; live telephony cannot run here (docs/08).');
  if ((env.AR_PHI_MODE ?? '').toLowerCase() !== 'on') reasons.push('AR_PHI_MODE is off (PHI gate, ADR 0070).');
  if (!cfg.accountSid || !env[cfg.authTokenRef]) reasons.push('No Twilio credentials are configured.');
  if (!cfg.callerId || !cfg.publicBaseUrl || !cfg.relayUrl) reasons.push('Caller ID, public base URL or relay socket URL is not configured.');
  reasons.push('No customer authorization for live calls is recorded for this deployment (connector_authorizations), and no provider contract or BAA exists.');
  return reasons;
}

export type Transport = (req: HttpRequestShape) => Promise<{ status: number; json: Record<string, unknown> }>;

const fetchTransport: Transport = async (req) => {
  const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body ?? undefined, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};

const IN_PROGRESS = ['queued', 'initiated', 'ringing', 'in-progress'];

export class LiveTelephonyAdapter implements VoiceAdapter, AsyncVoiceAdapter {
  name = 'live_telephony';
  live = true;
  config: LiveTelephonyConfig;
  private gate: (req?: StartCallRequest) => string[];
  private transport: Transport;
  private env: Record<string, string | undefined>;

  constructor(o: { config?: LiveTelephonyConfig; gate?: (req?: StartCallRequest) => string[]; transport?: Transport; env?: Record<string, string | undefined> } = {}) {
    this.env = o.env ?? process.env;
    this.config = o.config ?? liveTelephonyConfig(this.env);
    this.gate = o.gate ?? (() => deploymentTelephonyReasons(this.config, this.env));
    this.transport = o.transport ?? fetchTransport;
  }

  /** Throws LiveExecutionDisabled with every reason when the gate is closed. */
  private check(req?: StartCallRequest): void {
    const reasons = this.gate(req);
    if (reasons.length) throw new LiveExecutionDisabled(`Live telephony is disabled: ${reasons.join(' ')}`);
  }

  private account(): TwilioAccount {
    const token = this.env[this.config.authTokenRef];
    if (!this.config.accountSid || !token) throw new LiveExecutionDisabled('No Twilio credentials are configured.');
    return { accountSid: this.config.accountSid, authToken: token };
  }

  private sync(): never { throw new Error('The live telephony adapter is asynchronous; the orchestrator must call the *Async methods outside its step transaction.'); }

  // VoiceAdapter (synchronous) surface: refused while the gate is closed.
  startCall(req?: StartCallRequest): StartCallResult { this.check(req); return this.sync(); }
  cancelCall(): CancelResult { this.check(); return this.sync(); }
  transferCall(): TransferResult { this.check(); return this.sync(); }
  retrieveResult(): CallResult { this.check(); return this.sync(); }

  verifyStatusCallback(rawBody?: string, signature?: string): CallbackVerification {
    this.check();
    const url = `${(this.config.publicBaseUrl ?? '').replace(/\/$/, '')}/api/webhooks/twilio/voice-status`;
    const v = verifyTwilio(this.env[this.config.authTokenRef], signedUrlForms(url), signature, rawBody ?? '');
    if (!v.ok) return { ok: false, reason: v.reason === 'not_configured' ? 'not_configured' : 'bad_signature' };
    const e = parseStatusCallback(v.params);
    if (!e) return { ok: false, reason: 'malformed' };
    return { ok: true, event: { eventId: e.dedupeKey, providerCallId: e.callSid, type: e.terminal ? 'call.ended' : 'call.status', at: e.timestamp ?? new Date().toISOString(), reason: e.status } };
  }

  async startCallAsync(req: StartCallRequest & { to: string; welcomeGreeting: string }): Promise<StartCallResult> {
    this.check(req);
    const to = this.config.destinations[req.destination];
    if (!to || to !== req.to) throw new LiveExecutionDisabled('Destination is not on the configured allowlist.');
    const base = (this.config.publicBaseUrl ?? '').replace(/\/$/, '');
    const twiml = relayTwiml({ relayUrl: this.config.relayUrl ?? '', actionUrl: `${base}/api/webhooks/twilio/relay-done`, welcomeGreeting: req.welcomeGreeting,
      parameters: { callId: req.requestId, scope: `${req.tenantId}.${req.clientId}` }, dtmfDetection: true, interruptible: 'speech' });
    const http = createCallRequest(this.account(), { to, from: this.config.callerId ?? '', twiml, statusCallback: `${base}/api/webhooks/twilio/voice-status`,
      timeoutSeconds: Math.min(600, req.timeBudgetSeconds), record: req.recording.enabled });
    const r = await this.transport(http);
    const sid = typeof r.json.sid === 'string' ? r.json.sid : null;
    if (r.status >= 300 || !sid) throw new Error(`Twilio returned ${r.status}${typeof r.json.message === 'string' ? `: ${r.json.message}` : ''}`);
    return { providerCallId: sid, status: 'queued' };
  }

  async cancelCallAsync(providerCallId: string): Promise<CancelResult> {
    this.check();
    const r = await this.transport(endCallRequest(this.account(), providerCallId));
    if (r.status >= 300) throw new Error(`Twilio returned ${r.status}`);
    return { status: 'cancel_requested' };
  }

  async transferCallAsync(providerCallId: string): Promise<TransferResult> {
    this.check();
    const line = this.config.specialistLine;
    if (!line || !/^\+[1-9]\d{7,14}$/.test(line)) return { status: 'not_connected' };
    const r = await this.transport(redirectCallRequest(this.account(), providerCallId, twimlDocument(`<Dial>${line}</Dial>`)));
    if (r.status >= 300) throw new Error(`Twilio returned ${r.status}`);
    return { status: 'transfer_requested' };
  }

  async retrieveResultAsync(providerCallId: string): Promise<CallResult> {
    this.check();
    const r = await this.transport(fetchCallRequest(this.account(), providerCallId));
    if (r.status === 404) return { providerCallId, status: 'unknown', endedBy: null, endReason: null, recordingAvailable: false };
    if (r.status >= 300) throw new Error(`Twilio returned ${r.status}`);
    const status = String(r.json.status ?? '');
    return { providerCallId, status: IN_PROGRESS.includes(status) ? 'in_progress' : status ? 'ended' : 'unknown', endedBy: IN_PROGRESS.includes(status) ? null : 'provider', endReason: IN_PROGRESS.includes(status) ? null : status, recordingAvailable: false };
  }
}

export const liveTelephony = new LiveTelephonyAdapter();

// Procurement checklist recorded as data. Items are taken from the build pack's
// "Telephony procurement checklist" (docs/07) and call governance (docs/08).
// Status is not_started for every item: nothing has been evaluated.
export const TELEPHONY_PROCUREMENT_SOURCE = {
  source: 'AR-Resolution-Claude-Build-Pack/docs/07_INTEGRATIONS_AND_DATA_CONTRACTS.md#telephony-procurement-checklist; docs/08 call and recording governance',
  retrievedAt: '2026-10-12',
};

export interface ChecklistItem { id: string; item: string; question: string; status: 'not_started' | 'in_progress' | 'satisfied' | 'blocked'; evidence: string | null; source: string }

const D07 = 'docs/07 Telephony procurement checklist';
const D08 = 'docs/08 Call and recording governance';
export const TELEPHONY_PROCUREMENT_CHECKLIST: ChecklistItem[] = [
  { id: 'hipaa_eligible', item: 'HIPAA-eligible products under the actual contract', question: 'Which exact products and features are eligible under the signed contract?', status: 'not_started', evidence: null, source: D07 },
  { id: 'baa_scope', item: 'BAA scope', question: 'Is a BAA signed, and which services and editions does it cover?', status: 'not_started', evidence: null, source: D07 },
  { id: 'media_region', item: 'Media-region behavior', question: 'Where is call media processed and stored?', status: 'not_started', evidence: null, source: D07 },
  { id: 'retention', item: 'Recording and transcription retention', question: 'What are the retention and deletion settings for recordings and transcripts?', status: 'not_started', evidence: null, source: D07 },
  { id: 'subprocessors', item: 'Speech and model subprocessors', question: 'Which speech and model subprocessors handle audio or text, and under which agreements?', status: 'not_started', evidence: null, source: D07 },
  { id: 'callback_signatures', item: 'Callback signatures', question: 'Which documented algorithm signs status callbacks, and is there a replay window?', status: 'not_started', evidence: null, source: D07 },
  { id: 'cps_concurrency', item: 'Calls-per-second and concurrency limits', question: 'What are the account CPS and concurrent-call limits?', status: 'not_started', evidence: null, source: D07 },
  { id: 'cancellation', item: 'Cancellation', question: 'Can an in-progress call be cancelled through the API with a confirmed end state?', status: 'not_started', evidence: null, source: D07 },
  { id: 'warm_transfer', item: 'Warm transfer', question: 'Can a live call be warm-transferred to a human specialist with context?', status: 'not_started', evidence: null, source: D07 },
  { id: 'hold_detection', item: 'Hold detection', question: 'Is hold/music detection available, and how is a returning representative detected?', status: 'not_started', evidence: null, source: D07 },
  { id: 'number_reputation', item: 'Number reputation', question: 'How are outbound numbers registered and their reputation monitored?', status: 'not_started', evidence: null, source: D07 },
  { id: 'usage_billing', item: 'Usage billing', question: 'How are minutes, recording, transcription and hold time billed?', status: 'not_started', evidence: null, source: D07 },
  { id: 'no_free_trial', item: 'No generic free trial for PHI', question: 'Is the environment an approved PHI environment rather than a generic trial?', status: 'not_started', evidence: null, source: D07 },
  { id: 'counsel_review', item: 'Counsel review of call law, disclosure and recording', question: 'Has counsel reviewed destination type, purpose, dialing method, consent, disclosures and state recording laws?', status: 'not_started', evidence: null, source: D08 },
];
