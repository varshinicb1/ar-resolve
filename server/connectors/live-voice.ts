// Telephony adapter boundary for payer calls (docs/07 adapter contract: call
// adapters expose start, cancel, transfer and retrieve structured result; signed
// status callbacks per "Signed webhook ingestion").
//
// The live adapter is shaped for a HIPAA-eligible telephony provider but no
// provider is selected, no BAA is signed and no authorization is recorded, so
// every method throws LiveExecutionDisabled. Phase 0 uses sim-voice.ts only.
import { LiveExecutionDisabled } from './executors.ts';

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
export type CallbackVerification = { ok: true; event: StatusCallback } | { ok: false; reason: 'bad_signature' | 'stale_timestamp' | 'malformed' };

export interface VoiceAdapter {
  name: string;
  live: boolean;
  startCall(req: StartCallRequest): StartCallResult;
  cancelCall(providerCallId: string, reason: string): CancelResult;
  transferCall(providerCallId: string, target: { kind: 'human_queue'; queue: string }): TransferResult;
  retrieveResult(providerCallId: string): CallResult;
  verifyStatusCallback(rawBody: string, signature: string | undefined, timestamp: string | undefined): CallbackVerification;
}

// Configuration the live adapter would need. Every field is unset on purpose.
export interface LiveTelephonyConfig {
  provider: null;                 // not selected
  baaSigned: false;
  hipaaEligibleServicesConfirmed: false;
  mediaRegion: null;
  credentialsCustodian: null;
  callbackSigningSecretRef: null; // secret manager reference, never a literal
  authorizationRecordId: null;    // customer authorization for live calls
}

export const LIVE_TELEPHONY_CONFIG: LiveTelephonyConfig = {
  provider: null, baaSigned: false, hipaaEligibleServicesConfirmed: false, mediaRegion: null,
  credentialsCustodian: null, callbackSigningSecretRef: null, authorizationRecordId: null,
};

const DISABLED = 'Live telephony is disabled: no provider selected, no BAA or covered-service verification, and no recorded customer authorization.';

export class LiveTelephonyAdapter implements VoiceAdapter {
  name = 'live_telephony';
  live = true;
  config: LiveTelephonyConfig;
  constructor(config: LiveTelephonyConfig = LIVE_TELEPHONY_CONFIG) { this.config = config; }
  startCall(): StartCallResult { throw new LiveExecutionDisabled(DISABLED); }
  cancelCall(): CancelResult { throw new LiveExecutionDisabled(DISABLED); }
  transferCall(): TransferResult { throw new LiveExecutionDisabled(DISABLED); }
  retrieveResult(): CallResult { throw new LiveExecutionDisabled(DISABLED); }
  verifyStatusCallback(): CallbackVerification { throw new LiveExecutionDisabled(DISABLED); }
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
