// Read models for call operations: list, detail with transcript and metrics,
// per-account call panel and configuration (policy, lines, procurement status).
import { type Db, all, one } from '../../db/db.ts';
import { can, requirePerm, type Scope } from '../auth.ts';
import { getAccountRow } from '../workflow.ts';
import { SIM_PAYER_LINES, SIM_SCRIPTS } from '../../connectors/sim-voice.ts';
import { LIVE_TELEPHONY_CONFIG, liveTelephony, TELEPHONY_PROCUREMENT_CHECKLIST, TELEPHONY_PROCUREMENT_SOURCE } from '../../connectors/live-voice.ts';
import { ANSWERED_QUESTION, type QuestionPlan } from './plan.ts';
import { ACTIVE_CALL_STATES, currentPolicy, evaluateGate, listPolicyVersions, policyVersion, POLICY_NOTE } from './policy.ts';
import { loadCall, TERMINAL_STATES, type CallRow } from './engine.ts';

export function metrics(db: Db, c: CallRow) {
  const plan = JSON.parse(c.plan) as QuestionPlan;
  const planned = plan.questions.filter((q) => q.status !== 'skipped');
  const answered = planned.filter((q) => ANSWERED_QUESTION.includes(q.status));
  const pol = policyVersion(db, c.tenant_id, c.client_id, c.policy_version).definition;
  const totalSeconds = Math.round(c.sim_elapsed_ms / 1000);
  const minutes = Math.ceil(totalSeconds / 60);
  return {
    ivrSeconds: Math.round(c.ivr_ms / 1000), holdSeconds: Math.round(c.hold_ms / 1000), talkSeconds: Math.round(c.talk_ms / 1000), totalSeconds,
    timeBasis: 'Simulated line time (deterministic durations per IVR prompt, hold segment and spoken turn), not wall-clock time',
    completeness: { answered: answered.length, planned: planned.length, ratio: planned.length ? answered.length / planned.length : 0 },
    cost: { estimateCents: minutes * pol.costAssumption.perMinuteCents, minutes, perMinuteCents: pol.costAssumption.perMinuteCents, label: pol.costAssumption.label, isAssumption: true },
  };
}

function summary(db: Db, c: CallRow & { external_id: string }) {
  const m = metrics(db, c);
  return {
    callId: c.call_id, accountId: c.account_id, externalId: c.external_id, payerId: c.payer_id, destination: c.destination, state: c.state,
    outcome: c.outcome, reasonCode: c.reason_code, simScript: c.sim_script, active: !TERMINAL_STATES.includes(c.state), assignedTo: c.assigned_to,
    reconcileRequired: !!c.reconcile_required, holdSeconds: m.holdSeconds, totalSeconds: m.totalSeconds, completeness: m.completeness,
    createdBy: c.created_by, createdAt: c.created_at, endedAt: c.ended_at,
  };
}

export function listCalls(db: Db, scope: Scope, filter: string) {
  requirePerm(scope, 'view');
  const ph = ACTIVE_CALL_STATES.map(() => '?').join(',');
  const where = filter === 'active' ? `AND c.state IN (${ph})` : filter === 'recent' ? `AND c.state NOT IN (${ph})` : '';
  const params = filter === 'active' || filter === 'recent' ? ACTIVE_CALL_STATES : [];
  const rows = all<CallRow & { external_id: string }>(db, `SELECT c.*, a.external_id FROM voice_calls c JOIN accounts a ON a.tenant_id=c.tenant_id AND a.client_id=c.client_id AND a.account_id=c.account_id
    WHERE c.tenant_id=? AND c.client_id=? ${where} ORDER BY c.created_at DESC, c.rowid DESC LIMIT 100`, scope.tenantId, scope.clientId, ...params);
  const items = rows.map((r) => summary(db, r));
  return {
    items,
    counts: {
      active: items.filter((i) => i.active).length,
      needsAttention: items.filter((i) => i.state === 'handoff_to_human' || i.reconcileRequired).length,
    },
  };
}

export function callDetail(db: Db, scope: Scope, callId: string) {
  requirePerm(scope, 'view');
  const c = loadCall(db, scope, callId);
  const a = getAccountRow(db, scope, c.account_id);
  const events = all<{ seq: number; kind: string; speaker: string | null; text: string | null; question_id: string | null; sim_at_ms: number; data: string; created_at: string }>(db,
    'SELECT seq, kind, speaker, text, question_id, sim_at_ms, data, created_at FROM voice_call_events WHERE tenant_id=? AND client_id=? AND call_id=? ORDER BY seq', scope.tenantId, scope.clientId, callId)
    .map((e) => ({ seq: e.seq, kind: e.kind, speaker: e.speaker, text: e.text, questionId: e.question_id, atMs: e.sim_at_ms, data: JSON.parse(e.data), createdAt: e.created_at }));
  const answers = all<{ answer_id: string; question_id: string; answer_key: string; fact_key: string | null; value: string | null; unit: string | null; status: string; turn_seqs: string; read_back_seq: number | null; flags: string }>(db,
    'SELECT * FROM voice_answers WHERE tenant_id=? AND client_id=? AND call_id=? ORDER BY rowid', scope.tenantId, scope.clientId, callId)
    .map((x) => ({ answerId: x.answer_id, questionId: x.question_id, key: x.answer_key, factKey: x.fact_key, value: x.value === null ? null : JSON.parse(x.value), unit: x.unit,
      status: x.status, turnSeqs: JSON.parse(x.turn_seqs) as number[], readBackSeq: x.read_back_seq, flags: JSON.parse(x.flags) as string[] }));
  const pol = policyVersion(db, c.tenant_id, c.client_id, c.policy_version);
  return {
    call: { ...summary(db, { ...c, external_id: a.external_id }), providerCallId: c.provider_call_id, adapter: c.adapter, scenario: c.scenario_id,
      policy: { version: pol.version, sha256: pol.sha256 }, accountRevisionAtStart: c.account_revision_at_start, transcriptEvidenceId: c.transcript_evidence_id,
      cancelRequested: c.cancel_requested, reconciledBy: c.reconciled_by, simulated: true },
    account: { accountId: a.account_id, externalId: a.external_id, claimReference: a.claim_reference, payerId: a.payer_id, serviceDate: a.service_date },
    plan: JSON.parse(c.plan) as QuestionPlan,
    events,
    flags: events.filter((e) => e.kind === 'flag').map((e) => ({ seq: e.seq, code: e.data.code as string, text: e.text, turnSeq: (e.data.turnSeq ?? null) as number | null })),
    answers,
    handoff: c.handoff ? JSON.parse(c.handoff) : null,
    metrics: metrics(db, c),
    permissions: { control: can(scope, 'investigate'), cancel: can(scope, 'investigate') || can(scope, 'operate') },
  };
}

export function accountCalls(db: Db, scope: Scope, accountId: string) {
  requirePerm(scope, 'view');
  const a = getAccountRow(db, scope, accountId);
  const rows = all<CallRow & { external_id: string }>(db, `SELECT c.*, ? external_id FROM voice_calls c WHERE c.tenant_id=? AND c.client_id=? AND c.account_id=? ORDER BY c.created_at DESC, c.rowid DESC`,
    a.external_id, scope.tenantId, scope.clientId, accountId);
  const gate = evaluateGate(db, scope, a);
  return {
    gate: { allowed: gate.allowed, reasonCodes: gate.reasonCodes, checks: gate.checks, policy: gate.policy,
      plan: gate.plan ? gate.plan.questions.map((q) => ({ id: q.id, label: q.label, reason: q.reason, why: q.why, readBack: q.readBack, purposeful: q.purposeful })) : [] },
    calls: rows.map((r) => summary(db, r)),
    scripts: Object.values(SIM_SCRIPTS).map((s) => ({ id: s.id, label: s.label, adversarial: s.adversarial, description: s.description })),
    permissions: { start: can(scope, 'investigate') },
  };
}

export function voiceConfig(db: Db, scope: Scope) {
  requirePerm(scope, 'view');
  const pol = currentPolicy(db, scope.tenantId, scope.clientId);
  const lastHour = new Date(Date.now() - 3600_000).toISOString();
  return {
    environment: 'synthetic',
    policy: { ...pol, note: POLICY_NOTE },
    policyVersions: listPolicyVersions(db, scope),
    lines: Object.values(SIM_PAYER_LINES).map((l) => ({
      ...l,
      inUse: one<{ n: number }>(db, `SELECT COUNT(*) n FROM voice_calls WHERE tenant_id=? AND payer_id=? AND state IN (${ACTIVE_CALL_STATES.map(() => '?').join(',')})`, scope.tenantId, l.payerId, ...ACTIVE_CALL_STATES)!.n,
      placedLastHour: one<{ n: number }>(db, 'SELECT COUNT(*) n FROM voice_calls WHERE tenant_id=? AND payer_id=? AND created_at >= ?', scope.tenantId, l.payerId, lastHour)!.n,
    })),
    scripts: Object.values(SIM_SCRIPTS).map((s) => ({ id: s.id, label: s.label, adversarial: s.adversarial, description: s.description })),
    liveAdapter: { name: liveTelephony.name, enabled: false, config: LIVE_TELEPHONY_CONFIG, status: 'Disabled: throws LiveExecutionDisabled' },
    procurement: { ...TELEPHONY_PROCUREMENT_SOURCE, items: TELEPHONY_PROCUREMENT_CHECKLIST },
    permissions: { editPolicy: can(scope, 'operate') },
  };
}
