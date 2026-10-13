// Ported from clinic-receptionist src/recording.ts (same owner), adapted and gated (ADR 0080).
//
// The origin started a Twilio recording when RECORD_CALLS=on, relying on its greeting to announce
// recording, kept the audio at Twilio and streamed it to signed-in staff through an audited route.
// In AR Resolve the whole feature is DISABLED BY DEFAULT and refused unless every gate holds:
//   1. deployment flag AR_RECORDING=on;
//   2. the client's recording policy (versioned data) is enabled;
//   3. the consent mode (one_party / all_party) has been CONFIGURED by the customer and its counsel;
//      the application never infers it from a state, a number or a payer;
//   4. a person recorded that counsel reviewed the configuration (reference to the memo or ticket);
//   5. the disclosure line exists and says the call is recorded; the engine speaks it in the opening
//      utterance and recording starts only after that utterance was spoken (never before);
//   6. the PHI gate: a simulated call on synthetic data passes; any other adapter needs full PHI
//      readiness for the scope (governance.ts) - and live telephony is disabled anyway.
// Recordings here are SIMULATED: a metadata row with a sealed storage reference and no audio.
// Every access to a recording is audited. Retention class "recordings" (retention.ts) purges them.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { canonicalJson, hashJson, invalid, newId, notFound, nowIso } from '../util.ts';
import { audit } from './audit.ts';
import { requirePerm, type Scope } from './auth.ts';
import { open, seal } from './phi.ts';
import { isTombstone } from './sealed-store.ts';
import { phiReadiness } from './governance.ts';
import { ENVIRONMENT_FOR_GATE } from '../connectors/framework.ts';
import type { Settings } from '../core/registry.ts';

export const RECORDING_VERSION = 'recording.v1';
export const CONSENT_MODES = ['not_configured', 'one_party', 'all_party'] as const;
export type ConsentMode = (typeof CONSENT_MODES)[number];
export const RECORDING_NOTE = 'Consent mode and disclosure wording are customer and counsel configuration per jurisdiction. The application does not determine which consent rule applies and does not establish compliance.';

export interface RecordingPolicy {
  schema: 'ar-resolve.recording-policy.v1';
  enabled: boolean;
  consentMode: ConsentMode;
  consentSource: string;
  disclosureLine: string;
  counselReview: { recorded: boolean; reference: string | null; recordedBy: string | null; recordedAt: string | null };
  retentionClass: 'recordings';
}

export function defaultRecordingPolicy(): RecordingPolicy {
  return { schema: 'ar-resolve.recording-policy.v1', enabled: false, consentMode: 'not_configured', consentSource: '', disclosureLine: 'This call is being recorded.',
    counselReview: { recorded: false, reference: null, recordedBy: null, recordedAt: null }, retentionClass: 'recordings' };
}

export interface RecordingPolicyRecord { version: number; sha256: string; definition: RecordingPolicy; reason: string; createdBy: string; createdAt: string | null }

export function currentRecordingPolicy(db: Db, tenantId: string, clientId: string): RecordingPolicyRecord {
  const r = one<{ version: number; definition: string; sha256: string; reason: string; created_by: string; created_at: string }>(db,
    'SELECT * FROM recording_policies WHERE tenant_id=? AND client_id=? ORDER BY version DESC LIMIT 1', tenantId, clientId);
  if (r) return { version: r.version, sha256: r.sha256, definition: JSON.parse(r.definition), reason: r.reason, createdBy: r.created_by, createdAt: r.created_at };
  const d = defaultRecordingPolicy();
  return { version: 0, sha256: hashJson(d), definition: d, reason: 'Built-in default: recording off', createdBy: 'system', createdAt: null };
}

export function setRecordingPolicy(db: Db, scope: Scope, body: Record<string, any>): RecordingPolicyRecord {
  requirePerm(scope, 'manage_recording');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 10) throw invalid('A reason of at least 10 characters is required');
  const cur = currentRecordingPolicy(db, scope.tenantId, scope.clientId).definition;
  const consentMode = (body.consentMode ?? cur.consentMode) as ConsentMode;
  if (!CONSENT_MODES.includes(consentMode)) throw invalid(`consentMode must be one of ${CONSENT_MODES.join(', ')} (configured by the customer and counsel)`);
  const consentSource = String(body.consentSource ?? cur.consentSource).trim().slice(0, 300);
  if (consentMode !== 'not_configured' && consentSource.length < 5) throw invalid('consentSource must say who configured the consent mode (for example the counsel memo reference)');
  const disclosureLine = String(body.disclosureLine ?? cur.disclosureLine).trim();
  if (disclosureLine.length > 300) throw invalid('disclosureLine is at most 300 characters');
  let counselReview = cur.counselReview;
  if (body.counselReview !== undefined) {
    const recorded = !!body.counselReview?.recorded;
    const reference = recorded ? String(body.counselReview?.reference ?? '').trim() : null;
    if (recorded && (!reference || reference.length < 3)) throw invalid('Recording a counsel review needs a reference (memo, ticket or document id)');
    counselReview = { recorded, reference, recordedBy: recorded ? scope.userId : null, recordedAt: recorded ? nowIso() : null };
  }
  const def: RecordingPolicy = { schema: 'ar-resolve.recording-policy.v1', enabled: body.enabled === undefined ? cur.enabled : !!body.enabled, consentMode, consentSource, disclosureLine, counselReview, retentionClass: 'recordings' };
  return tx(db, () => {
    const prev = currentRecordingPolicy(db, scope.tenantId, scope.clientId);
    const version = prev.version + 1;
    const hash = hashJson(def);
    run(db, 'INSERT INTO recording_policies VALUES (?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, version, canonicalJson(def), hash, reason, scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'recording_policy', objectId: `v${version}`, eventType: 'recording_policy_changed',
      details: { version, sha256: hash, reason, enabled: def.enabled, consentMode, counselReviewRecorded: counselReview.recorded,
        attestation: counselReview.recorded && !prev.definition.counselReview.recorded ? 'Counsel review recorded by a person; the code cannot verify it.' : null } });
    return currentRecordingPolicy(db, scope.tenantId, scope.clientId);
  });
}

export interface RecordingCheck { id: string; label: string; pass: boolean; detail: string }

/** Whether a call on this adapter may be recorded, with every check spelled out. */
export function recordingGate(db: Db, scope: Scope, adapter: string, settings: Settings = process.env) {
  const pol = currentRecordingPolicy(db, scope.tenantId, scope.clientId);
  const p = pol.definition;
  const checks: RecordingCheck[] = [];
  const add = (id: string, label: string, pass: boolean, detail: string) => checks.push({ id, label, pass, detail });
  add('feature_flag', 'Recording enabled for this deployment (AR_RECORDING=on)', (settings.AR_RECORDING ?? '').toLowerCase() === 'on', `AR_RECORDING=${settings.AR_RECORDING ?? 'off'} (off by default)`);
  add('policy_enabled', 'Client recording policy enabled', p.enabled, `Recording policy v${pol.version}: ${p.enabled ? 'enabled' : 'disabled'}`);
  add('consent_configured', 'Consent mode configured by the customer and counsel', p.consentMode !== 'not_configured', p.consentMode === 'not_configured' ? 'Not configured; the application never infers it' : `${p.consentMode} (source: ${p.consentSource})`);
  add('counsel_review', 'Counsel review recorded', p.counselReview.recorded, p.counselReview.recorded ? `Reference ${p.counselReview.reference}, recorded by ${p.counselReview.recordedBy}` : 'No counsel review on record');
  add('disclosure_line', 'Disclosure line says the call is recorded', /\brecord/i.test(p.disclosureLine), p.disclosureLine ? `"${p.disclosureLine}"` : 'Missing');
  const simulated = adapter === 'sim_voice';
  let phiOk = false;
  let phiDetail = '';
  if (simulated) { phiOk = ENVIRONMENT_FOR_GATE === 'synthetic'; phiDetail = phiOk ? 'Simulated call on synthetic data; no audio is captured' : 'The simulator runs in the synthetic environment only'; }
  else { const r = phiReadiness(db, scope, settings); phiOk = r.ready; phiDetail = r.ready ? 'PHI readiness complete' : `PHI gate closed: ${r.missing.length} item(s) missing`; }
  add('phi_gate', 'PHI gate', phiOk, phiDetail);
  return { allowed: checks.every((c) => c.pass), checks, policy: { version: pol.version, sha256: pol.sha256 }, disclosureLine: p.disclosureLine, consentMode: p.consentMode, note: RECORDING_NOTE };
}

/** Called by the engine right after the opening (disclosure) utterance was spoken. Simulated: no audio. */
export function startSimulatedRecording(db: Db, o: { tenantId: string; clientId: string; callId: string; accountId: string; policyVersion: number; policySha256: string; consentMode: string; disclosureSeq: number }) {
  const recordingId = newId('rec');
  const ref = seal(`sim-recording://${o.tenantId}/${o.clientId}/${o.callId}/${recordingId}`);
  run(db, `INSERT INTO call_recordings (tenant_id, client_id, recording_id, call_id, account_id, policy_version, policy_sha256, consent_mode, disclosure_seq, storage_ref, retention_class, simulated, state, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (tenant_id, client_id, call_id) DO NOTHING`,
  o.tenantId, o.clientId, recordingId, o.callId, o.accountId, o.policyVersion, o.policySha256, o.consentMode, o.disclosureSeq, ref, 'recordings', 1, 'recording', nowIso(), nowIso());
  audit(db, { tenantId: o.tenantId, clientId: o.clientId, actorId: 'system:voice', objectType: 'call_recording', objectId: recordingId, accountId: o.accountId, eventType: 'recording_started',
    details: { callId: o.callId, policyVersion: o.policyVersion, consentMode: o.consentMode, disclosureSeq: o.disclosureSeq, simulated: true } });
  return recordingId;
}

export function finishSimulatedRecording(db: Db, o: { tenantId: string; clientId: string; callId: string; durationMs: number }) {
  run(db, "UPDATE call_recordings SET state='available', duration_ms=?, updated_at=? WHERE tenant_id=? AND client_id=? AND call_id=? AND state='recording'", o.durationMs, nowIso(), o.tenantId, o.clientId, o.callId);
}

interface RecRow { recording_id: string; call_id: string; account_id: string; policy_version: number; consent_mode: string; disclosure_seq: number; storage_ref: string; retention_class: string; duration_ms: number | null; state: string; created_at: string }
const recView = (r: RecRow) => ({ recordingId: r.recording_id, callId: r.call_id, accountId: r.account_id, policyVersion: r.policy_version, consentMode: r.consent_mode,
  disclosureSeq: r.disclosure_seq, retentionClass: r.retention_class, durationMs: r.duration_ms, state: r.state, createdAt: r.created_at, simulated: true });

export function listRecordings(db: Db, scope: Scope) {
  requirePerm(scope, 'view_recordings');
  return all<RecRow>(db, 'SELECT * FROM call_recordings WHERE tenant_id=? AND client_id=? ORDER BY created_at DESC LIMIT 100', scope.tenantId, scope.clientId).map(recView);
}

/** Access to one recording (here: its sealed storage reference; there is no audio). Always audited. */
export function getRecording(db: Db, scope: Scope, callId: string) {
  requirePerm(scope, 'view_recordings');
  const r = one<RecRow>(db, 'SELECT * FROM call_recordings WHERE tenant_id=? AND client_id=? AND call_id=?', scope.tenantId, scope.clientId, callId);
  if (!r) throw notFound('Recording');
  audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'call_recording', objectId: r.recording_id, accountId: r.account_id, eventType: 'recording_accessed',
    details: { callId, state: r.state } });
  return { ...recView(r), storageRef: isTombstone(r.storage_ref) ? null : open(r.storage_ref), audio: null, note: 'Simulated recording: metadata only, no audio exists.' };
}

export function recordingView(db: Db, scope: Scope) {
  requirePerm(scope, 'view');
  const cur = currentRecordingPolicy(db, scope.tenantId, scope.clientId);
  return { version: RECORDING_VERSION, consentModes: CONSENT_MODES, note: RECORDING_NOTE, current: cur, gate: recordingGate(db, scope, 'sim_voice') };
}
