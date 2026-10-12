// Call policy gate (FR07, docs/05 "before dialing", docs/08 call governance).
// Every refusal carries a reason code. Client call policy is versioned data;
// disclosure and recording settings are configuration supplied by the client
// and its counsel. Nothing here is legal advice or a compliance determination.
import { type Db, all, one, run } from '../../db/db.ts';
import { AppError, canonicalJson, invalid, now, nowIso, sha256 } from '../../util.ts';
import { audit } from '../audit.ts';
import { requirePerm, type Scope } from '../auth.ts';
import { activePause } from '../controls.ts';
import { currentFacts } from '../facts.ts';
import { DED01_V1 } from '../../../shared/rules/catalog.ts';
import type { AccountRow } from '../workflow.ts';
import { SIM_PAYER_LINES, type PayerLine } from '../../connectors/sim-voice.ts';
import { buildPlan, callNeeded, scenarioFor, type QuestionPlan } from './plan.ts';

export interface ClientCallPolicy {
  schema: 'ar-resolve.call-policy.v1';
  allowedDestinations: string[];
  billingEntityName: string;
  disclosure: { automationDisclosure: string; announceRecording: boolean };
  recording: { enabled: boolean; consentMode: 'all_party' | 'one_party'; note: string };
  verbalReprocessingPreauthorized: boolean;
  maxStatusAgeHours: number;
  channel: 'simulated';
  costAssumption: { perMinuteCents: number; label: string };
}

export const POLICY_NOTE = 'Configuration supplied by the client and its counsel per jurisdiction and workflow. Not legal advice; no setting here establishes compliance.';

export function defaultPolicy(clientName: string): ClientCallPolicy {
  return {
    schema: 'ar-resolve.call-policy.v1',
    allowedDestinations: ['sim:demo-payer/provider-services'],
    billingEntityName: clientName,
    disclosure: {
      automationDisclosure: `This is an automated assistant calling on behalf of ${clientName}, a healthcare provider, about a claim.`,
      announceRecording: true,
    },
    recording: { enabled: false, consentMode: 'all_party', note: POLICY_NOTE },
    verbalReprocessingPreauthorized: false,
    maxStatusAgeHours: 24,
    channel: 'simulated',
    costAssumption: { perMinuteCents: 2, label: 'Placeholder assumption for comparison only (not a vendor quote): 2 cents per occupied minute, hold included.' },
  };
}

export interface PolicyRecord { version: number; sha256: string; definition: ClientCallPolicy; reason: string; createdBy: string; createdAt: string | null }

export function currentPolicy(db: Db, tenantId: string, clientId: string): PolicyRecord {
  const r = one<{ version: number; definition: string; sha256: string; reason: string; created_by: string; created_at: string }>(db,
    'SELECT * FROM voice_policy_versions WHERE tenant_id=? AND client_id=? ORDER BY version DESC LIMIT 1', tenantId, clientId);
  if (r) return { version: r.version, sha256: r.sha256, definition: JSON.parse(r.definition), reason: r.reason, createdBy: r.created_by, createdAt: r.created_at };
  return builtInPolicy(db, tenantId, clientId);
}

export function policyVersion(db: Db, tenantId: string, clientId: string, version: number): PolicyRecord {
  if (version === 0) return builtInPolicy(db, tenantId, clientId);
  const r = one<{ version: number; definition: string; sha256: string; reason: string; created_by: string; created_at: string }>(db,
    'SELECT * FROM voice_policy_versions WHERE tenant_id=? AND client_id=? AND version=?', tenantId, clientId, version);
  if (!r) throw new Error('policy version missing');
  return { version: r.version, sha256: r.sha256, definition: JSON.parse(r.definition), reason: r.reason, createdBy: r.created_by, createdAt: r.created_at };
}

function builtInPolicy(db: Db, tenantId: string, clientId: string): PolicyRecord {
  const name = one<{ name: string }>(db, 'SELECT name FROM clients WHERE tenant_id=? AND client_id=?', tenantId, clientId)?.name ?? clientId;
  const def = defaultPolicy(name);
  return { version: 0, sha256: sha256(canonicalJson(def)), definition: def, reason: 'Built-in synthetic default', createdBy: 'system', createdAt: null };
}

function validatePolicy(p: any): ClientCallPolicy {
  const bad = (m: string) => invalid(`Call policy: ${m}`);
  if (!p || typeof p !== 'object') throw bad('must be an object');
  if (!Array.isArray(p.allowedDestinations) || !p.allowedDestinations.every((d: unknown) => typeof d === 'string' && /^sim:[\w-]+\/[\w-]+$/.test(d))) throw bad('allowedDestinations must be simulated destination ids (sim:payer/line)');
  if (typeof p.billingEntityName !== 'string' || !p.billingEntityName.trim()) throw bad('billingEntityName is required');
  if (typeof p.disclosure?.automationDisclosure !== 'string' || typeof p.disclosure?.announceRecording !== 'boolean') throw bad('disclosure.automationDisclosure and disclosure.announceRecording are required');
  if (typeof p.recording?.enabled !== 'boolean' || !['all_party', 'one_party'].includes(p.recording?.consentMode)) throw bad('recording.enabled and recording.consentMode (all_party|one_party) are required');
  if (typeof p.verbalReprocessingPreauthorized !== 'boolean') throw bad('verbalReprocessingPreauthorized must be true or false');
  if (!Number.isInteger(p.maxStatusAgeHours) || p.maxStatusAgeHours < 1 || p.maxStatusAgeHours > 720) throw bad('maxStatusAgeHours must be 1..720');
  if (p.channel !== 'simulated') throw new AppError(422, 'live_telephony_disabled', 'Only the simulated channel can be configured. Live telephony is disabled until a provider, BAA and customer authorization are recorded.');
  if (!Number.isInteger(p.costAssumption?.perMinuteCents) || p.costAssumption.perMinuteCents < 0) throw bad('costAssumption.perMinuteCents must be a non-negative integer');
  return {
    schema: 'ar-resolve.call-policy.v1', allowedDestinations: [...p.allowedDestinations], billingEntityName: p.billingEntityName.trim(),
    disclosure: { automationDisclosure: p.disclosure.automationDisclosure.trim(), announceRecording: p.disclosure.announceRecording },
    recording: { enabled: p.recording.enabled, consentMode: p.recording.consentMode, note: POLICY_NOTE },
    verbalReprocessingPreauthorized: p.verbalReprocessingPreauthorized, maxStatusAgeHours: p.maxStatusAgeHours, channel: 'simulated',
    costAssumption: { perMinuteCents: p.costAssumption.perMinuteCents, label: String(p.costAssumption.label ?? 'Placeholder assumption (not a vendor quote)') },
  };
}

// Writes a new immutable policy version. Partial input is merged over the current version.
export function updatePolicy(db: Db, scope: Scope, patch: Record<string, unknown>, reason: string): PolicyRecord {
  requirePerm(scope, 'operate');
  if (!reason || reason.trim().length < 5) throw invalid('A reason is required for a call policy change');
  const cur = currentPolicy(db, scope.tenantId, scope.clientId);
  const merged: any = { ...cur.definition, ...patch };
  for (const k of ['disclosure', 'recording', 'costAssumption'] as const) if (patch[k] && typeof patch[k] === 'object') merged[k] = { ...(cur.definition as any)[k], ...(patch[k] as object) };
  const def = validatePolicy(merged);
  const version = cur.version + 1;
  const hash = sha256(canonicalJson(def));
  run(db, 'INSERT INTO voice_policy_versions VALUES (?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, version, canonicalJson(def), hash, reason.trim(), scope.userId, nowIso());
  audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'call_policy', objectId: `v${version}`, eventType: 'call_policy_changed', details: { version, sha256: hash, reason: reason.trim() } });
  return currentPolicy(db, scope.tenantId, scope.clientId);
}

// ---------------------------------------------------------------- gate

export interface GateCheck { id: string; label: string; pass: boolean; reasonCode: string | null; detail: string }
export interface GateResult {
  allowed: boolean;
  reasonCodes: string[];
  checks: GateCheck[];
  policy: { version: number; sha256: string };
  line: PayerLine | null;
  scenario: string | null;
  plan: QuestionPlan | null;
  evaluatedAt: string;
}

export const ACTIVE_CALL_STATES = ['queued', 'dialing', 'ivr', 'hold', 'transfer', 'rep_connected', 'authenticating', 'questioning', 'read_back', 'wrap_up', 'handoff_to_human'];

function localTime(tz: string, d: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((p) => [p.type, p.value]));
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  return { day, hhmm: `${parts.hour}:${parts.minute}`, weekday: parts.weekday };
}

export function withinBusinessHours(line: PayerLine, d: Date) {
  const t = localTime(line.timezone, d);
  const open = line.businessHours.days.includes(t.day) && t.hhmm >= line.businessHours.open && t.hhmm < line.businessHours.close;
  return { open, local: `${t.weekday} ${t.hhmm} ${line.timezone}` };
}

export function unreconciledPriorCall(db: Db, scope: Scope, accountId: string) {
  return one<{ call_id: string }>(db, `SELECT call_id FROM voice_calls WHERE tenant_id=? AND client_id=? AND account_id=? AND reconcile_required=1 ORDER BY created_at LIMIT 1`,
    scope.tenantId, scope.clientId, accountId)?.call_id ?? null;
}

// Whether a verbal request on this claim is already known (accepted with a
// confirmed reference, or found on reconciliation): never request it again.
export function priorRequestKnown(db: Db, scope: Scope, accountId: string): boolean {
  return !!one(db, `SELECT 1 FROM voice_answers a JOIN voice_calls c USING (tenant_id, client_id, call_id)
    WHERE a.tenant_id=? AND a.client_id=? AND c.account_id=? AND ((a.answer_key='requestReference' AND a.status='confirmed') OR (a.answer_key='priorRequest' AND a.status='confirmed'))`,
  scope.tenantId, scope.clientId, accountId);
}

export function evaluateGate(db: Db, scope: Scope, a: AccountRow): GateResult {
  const checks: GateCheck[] = [];
  const add = (id: string, label: string, pass: boolean, reasonCode: string, detail: string) => checks.push({ id, label, pass, reasonCode: pass ? null : reasonCode, detail });
  const pol = currentPolicy(db, scope.tenantId, scope.clientId);
  const p = pol.definition;
  const line = SIM_PAYER_LINES[a.payer_id] ?? null;
  const at = now();

  add('destination_configured', 'Payer destination configured', !!line, 'NO_PAYER_LINE', line ? line.label : `No call destination is configured for payer ${a.payer_id}`);
  add('destination_allowlisted', 'Destination on client allowlist', !!line && p.allowedDestinations.includes(line.destination), 'DESTINATION_NOT_ALLOWLISTED',
    line ? `${line.destination} ${p.allowedDestinations.includes(line.destination) ? 'is' : 'is not'} on the allowlist (policy v${pol.version})` : 'No destination');
  add('live_telephony', 'Channel permitted', p.channel === 'simulated', 'LIVE_TELEPHONY_DISABLED', 'Simulated payer line only; live telephony disabled');
  if (line) {
    const bh = withinBusinessHours(line, at);
    add('business_hours', 'Within payer business hours', bh.open, 'OUTSIDE_BUSINESS_HOURS',
      `Payer local time ${bh.local}; hours ${line.businessHours.open}-${line.businessHours.close} ${line.businessHours.days.length === 7 ? "daily" : "Mon-Fri"} (synthetic config; holiday calendar not configured)`);
  }
  const pause = activePause(db, scope.tenantId, scope.clientId);
  add('not_paused', 'Automation not paused', !pause, 'AUTOMATION_PAUSED', pause ? `Paused (${pause.scopeKey}): ${pause.reason}` : 'No pause in scope');

  const facts = currentFacts(db, scope, a.account_id);
  const id = facts.get('identityVerified');
  const idOk = a.state !== 'blocked' && id?.status === 'verified' && id.value === true;
  add('identity_verified', 'Account identity verified', idOk, a.state === 'blocked' || id?.value === false ? 'IDENTITY_CONFLICT' : 'IDENTITY_UNVERIFIED',
    idOk ? 'Claim, patient token and DOS match the EOB' : a.state === 'blocked' || id?.value === false ? 'Identity conflict: calls are blocked until resolved' : 'Identity has not been verified against an EOB');

  const inflight = one<{ action_id: string; state: string }>(db, `SELECT action_id, state FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND state IN ('dispatching','uncertain')`,
    scope.tenantId, scope.clientId, a.account_id);
  add('no_action_in_flight', 'No action in flight', !inflight, 'ACTION_IN_FLIGHT', inflight ? `Action ${inflight.action_id} is ${inflight.state}; reconcile it first` : 'None');

  const ph = ACTIVE_CALL_STATES.map(() => '?').join(',');
  const activeForAccount = one<{ call_id: string }>(db, `SELECT call_id FROM voice_calls WHERE tenant_id=? AND client_id=? AND account_id=? AND state IN (${ph})`,
    scope.tenantId, scope.clientId, a.account_id, ...ACTIVE_CALL_STATES);
  add('no_active_call', 'No other call active on this account', !activeForAccount, 'CALL_ALREADY_ACTIVE', activeForAccount ? `Call ${activeForAccount.call_id} is active` : 'None');

  if (line) {
    // Concurrency and rate limits are per payer line within the tenant's telephony account.
    const active = one<{ n: number }>(db, `SELECT COUNT(*) n FROM voice_calls WHERE tenant_id=? AND payer_id=? AND state IN (${ph})`, scope.tenantId, a.payer_id, ...ACTIVE_CALL_STATES)!.n;
    add('payer_concurrency', 'Payer concurrency limit', active < line.maxConcurrent, 'CONCURRENCY_LIMIT', `${active} of ${line.maxConcurrent} concurrent calls in use`);
    const since = new Date(at.getTime() - 3600_000).toISOString();
    const recent = one<{ n: number }>(db, 'SELECT COUNT(*) n FROM voice_calls WHERE tenant_id=? AND payer_id=? AND created_at >= ?', scope.tenantId, a.payer_id, since)!.n;
    add('payer_rate_limit', 'Payer rate limit', recent < line.maxCallsPerHour, 'RATE_LIMITED', `${recent} of ${line.maxCallsPerHour} calls placed in the last hour`);
  }

  const lastRun = one<{ created_at: string; result: string; account_revision: number }>(db,
    'SELECT created_at, result, account_revision FROM workflow_runs WHERE tenant_id=? AND client_id=? AND account_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    scope.tenantId, scope.clientId, a.account_id);
  const ageH = lastRun ? (at.getTime() - new Date(lastRun.created_at).getTime()) / 3600_000 : Infinity;
  add('recent_status', 'Recent electronic status checked', ageH <= p.maxStatusAgeHours, 'STATUS_NOT_RECENT',
    lastRun ? `Last investigation ${ageH.toFixed(1)}h ago (limit ${p.maxStatusAgeHours}h)` : 'No investigation has pulled electronic status yet');

  add('disclosure_policy', 'Disclosure and recording policy configured',
    !!p.disclosure.automationDisclosure && !(p.recording.enabled && p.recording.consentMode === 'all_party' && !p.disclosure.announceRecording),
    'DISCLOSURE_POLICY_INCOMPLETE', `Automation disclosure ${p.disclosure.automationDisclosure ? 'set' : 'missing'}; recording ${p.recording.enabled ? 'on' : 'off'} (${p.recording.consentMode} consent config). ${POLICY_NOTE}`);

  const scenario = scenarioFor(a.scenario);
  let plan: QuestionPlan | null = null;
  if (scenario) {
    const prior = unreconciledPriorCall(db, scope, a.account_id);
    plan = buildPlan(scenario, {
      accountRevision: a.revision, claimReference: a.claim_reference, serviceDate: a.service_date, facts, requiredFacts: DED01_V1.requiredFacts,
      outcome: lastRun ? (JSON.parse(lastRun.result).outcome as string) : null, verbalReprocessingPreauthorized: p.verbalReprocessingPreauthorized,
      priorUnreconciledCallId: prior, priorRequestKnown: priorRequestKnown(db, scope, a.account_id), generatedAt: nowIso(),
    });
  }
  add('call_needed', 'A call is still needed', !!plan && callNeeded(plan), scenario ? 'NO_CALL_NEEDED' : 'NO_PLAYBOOK',
    !scenario ? `No call playbook for scenario ${a.scenario}` : plan && callNeeded(plan)
      ? `${plan.questions.filter((x) => x.purposeful).length} question(s) need the payer: ${plan.questions.filter((x) => x.purposeful).map((x) => x.id).join(', ')}`
      : 'Current evidence answers every question the playbook needs; no call');

  const reasonCodes = checks.filter((c) => !c.pass).map((c) => c.reasonCode!);
  return { allowed: reasonCodes.length === 0, reasonCodes, checks, policy: { version: pol.version, sha256: pol.sha256 }, line, scenario, plan, evaluatedAt: nowIso() };
}

export function listPolicyVersions(db: Db, scope: Scope) {
  requirePerm(scope, 'view');
  return all<{ version: number; sha256: string; reason: string; created_by: string; created_at: string }>(db,
    'SELECT version, sha256, reason, created_by, created_at FROM voice_policy_versions WHERE tenant_id=? AND client_id=? ORDER BY version DESC', scope.tenantId, scope.clientId);
}
