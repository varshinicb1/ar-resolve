// Durable payer call orchestration (E08 Voice). One call is a row in
// voice_calls driven through a state machine one step at a time; each step is a
// single transaction with an optimistic version check, so a crash mid-step
// rolls back and the step replays deterministically after restart.
//
// Representative turns are untrusted evidence. The engine only accepts typed
// values from extract.ts for the question that was asked; free text never
// selects a state transition, an action or a permission.
import { type Db, all, one, run, tx } from '../../db/db.ts';
import { AppError, canonicalJson, conflict, forbidden, invalid, newId, notFound, now, nowIso, sha256 } from '../../util.ts';
import { audit } from '../audit.ts';
import { can, requirePerm, type Scope } from '../auth.ts';
import { activePause } from '../controls.ts';
import { addEvidence } from '../evidence.ts';
import { currentFacts, resolveFacts } from '../facts.ts';
import { evaluateAndPropose, getAccountRow, type AccountRow } from '../workflow.ts';
import {
  initialLineState, payerTruth, scriptFor, simRespond, simVoiceAdapter, SIM_PAYER_LINES, SIM_SCRIPTS,
  type AgentAction, type LineState, type SimContext,
} from '../../connectors/sim-voice.ts';
import type { VoiceAdapter } from '../../connectors/live-voice.ts';
import {
  ACCUMULATOR_TIMING, BEFORE_CLAIM, EXTRACTOR_VERSION, findAdjustmentGroup, findClaimReferences, findCrossover, findDate, findMoney, findReference,
  findTurnaround, isAcceptance, isAgreeToLook, isConfirmation, isInstructionLike, isNegation, isRefusal, isUnknown, speakMoney, spellReference,
} from './extract.ts';
import { nextQuestion, promptFor, TERMINAL_QUESTION, type PlannedQuestion, type QuestionPlan } from './plan.ts';
import { ACTIVE_CALL_STATES, currentPolicy, evaluateGate, policyVersion } from './policy.ts';
import { guardInbound, guardOutbound, type GuardVerdict } from '../guard.ts';
import { open as openText, seal } from '../phi.ts';
import { speakDollars, speakIsoDate, speakReference } from './spoken.ts';
import { finishSimulatedRecording, recordingGate, startSimulatedRecording } from '../recording.ts';

export const TERMINAL_STATES = ['completed', 'dropped', 'cancelled', 'failed'];
const AUTOMATED_STATES = ACTIVE_CALL_STATES.filter((s) => s !== 'handoff_to_human');
export const ENGINE_VERSION = 'voice-orchestrator.v1';
const STEP_MS = Number(process.env.AR_VOICE_STEP_MS ?? 1000);
// Mirrors ENVIRONMENT in server/http/app.ts: simulator controls exist only in the synthetic environment.
const SYNTHETIC_ENVIRONMENT = true;

export interface CallRow {
  tenant_id: string; client_id: string; call_id: string; account_id: string; payer_id: string; destination: string; scenario_id: string;
  plan_id: string; plan_version: number; policy_version: number; policy_sha256: string; adapter: string; provider_call_id: string; sim_script: string | null;
  state: string; outcome: string | null; reason_code: string | null; plan: string; line_state: string; pending_read_back: string | null;
  sim_elapsed_ms: number; ivr_ms: number; hold_ms: number; talk_ms: number; hold_segment_ms: number; hold_timeout_ms: number;
  cancel_requested: string | null; handoff: string | null; assigned_to: string | null; reconcile_required: number; reconciled_by: string | null;
  idempotency_key: string; account_revision_at_start: number; transcript_evidence_id: string | null; interaction_id: string | null;
  version: number; next_step_at: string; created_by: string; created_at: string; updated_at: string; ended_at: string | null;
}

// Mutable working copy of a call during one step.
interface Work {
  row: CallRow;
  plan: QuestionPlan;
  line: LineState;
  account: AccountRow;
  ctx: SimContext;
  adapter: VoiceAdapter;
}

export function adapterFor(db: Db, name: string): VoiceAdapter {
  if (name === 'sim_voice') return simVoiceAdapter(db);
  throw new AppError(422, 'live_telephony_disabled', 'Live telephony is disabled');
}

export function workerScope(c: CallRow): Scope {
  return { userId: c.created_by, displayName: 'voice orchestrator', tenantId: c.tenant_id, clientId: c.client_id, roles: [] };
}

export function loadCall(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, callId: string): CallRow {
  const c = one<CallRow>(db, 'SELECT * FROM voice_calls WHERE tenant_id=? AND client_id=? AND call_id=?', scope.tenantId, scope.clientId, callId);
  if (!c) throw notFound('Call');
  return c;
}

function open(db: Db, row: CallRow): Work {
  const account = getAccountRow(db, workerScope(row), row.account_id);
  const script = scriptFor(row.client_id, account.external_id, row.sim_script);
  const line = SIM_PAYER_LINES[row.payer_id];
  const ctx: SimContext = {
    line, script, truth: payerTruth(row.client_id, account.external_id, script), db, providerCallId: row.provider_call_id,
    account: { claimReference: account.claim_reference, serviceDate: account.service_date, providerId: account.provider_id, payerId: account.payer_id },
  };
  return { row: { ...row }, plan: JSON.parse(row.plan), line: JSON.parse(row.line_state), account, ctx, adapter: adapterFor(db, row.adapter) };
}

function save(db: Db, w: Work, nextDelayMs = STEP_MS) {
  const r = w.row;
  const changed = run(db, `UPDATE voice_calls SET state=?, outcome=?, reason_code=?, plan=?, line_state=?, pending_read_back=?, sim_elapsed_ms=?, ivr_ms=?, hold_ms=?,
      talk_ms=?, hold_segment_ms=?, cancel_requested=?, handoff=?, assigned_to=?, reconcile_required=?, transcript_evidence_id=?, interaction_id=?,
      version=version+1, next_step_at=?, updated_at=?, ended_at=? WHERE tenant_id=? AND client_id=? AND call_id=? AND version=?`,
  r.state, r.outcome, r.reason_code, canonicalJson(w.plan), canonicalJson(w.line), r.pending_read_back, r.sim_elapsed_ms, r.ivr_ms, r.hold_ms,
  r.talk_ms, r.hold_segment_ms, r.cancel_requested, r.handoff, r.assigned_to, r.reconcile_required, r.transcript_evidence_id, r.interaction_id,
  new Date(now().getTime() + nextDelayMs).toISOString(), nowIso(), r.ended_at, r.tenant_id, r.client_id, r.call_id, r.version);
  if (changed !== 1) throw conflict('call_changed', 'The call changed concurrently; the step will be retried');
  r.version++;
}

function nextSeq(db: Db, r: CallRow): number {
  return one<{ n: number }>(db, 'SELECT COALESCE(MAX(seq),0)+1 n FROM voice_call_events WHERE tenant_id=? AND client_id=? AND call_id=?', r.tenant_id, r.client_id, r.call_id)!.n;
}

function event(db: Db, w: Work, e: { kind: string; speaker?: string | null; text?: string | null; questionId?: string | null; data?: Record<string, unknown> }): number {
  const seq = nextSeq(db, w.row);
  run(db, 'INSERT INTO voice_call_events VALUES (?,?,?,?,?,?,?,?,?,?,?)', w.row.tenant_id, w.row.client_id, w.row.call_id, seq, e.kind, e.speaker ?? null,
    e.text === null || e.text === undefined ? null : seal(e.text), e.questionId ?? null, w.row.sim_elapsed_ms, canonicalJson(e.data ?? {}), nowIso());
  return seq;
}

function flag(db: Db, w: Work, code: string, detail: string, extra: Record<string, unknown> = {}) {
  event(db, w, { kind: 'flag', text: detail, data: { code, ...extra } });
}

function transition(db: Db, w: Work, to: string, data: Record<string, unknown> = {}) {
  const from = w.row.state;
  if (from === to) return;
  w.row.state = to;
  event(db, w, { kind: 'state', text: `${from} → ${to}`, data: { from, to, ...data } });
}

const secondsFor = (text: string) => Math.ceil(text.split(/\s+/).length / 2.5) + 1;

function addTime(w: Work, seconds: number, bucket: 'ivr' | 'hold' | 'talk') {
  const ms = seconds * 1000;
  w.row.sim_elapsed_ms += ms;
  if (bucket === 'ivr') w.row.ivr_ms += ms;
  if (bucket === 'hold') { w.row.hold_ms += ms; w.row.hold_segment_ms += ms; }
  if (bucket === 'talk') w.row.talk_ms += ms;
}

// Agent speaks (optional), the simulated line responds; every produced event is
// appended. Returns the seqs of representative turns and the raw sim events.
// Ported Guard (ADR 0070): an outbound utterance that the Guard blocks is never spoken; the step
// stops and the call is handed to a human. Inbound representative turns are flagged only.
class GuardHalt extends Error {
  verdict: GuardVerdict;
  constructor(v: GuardVerdict) { super(v.hits.map((h) => h.why).join('; ')); this.verdict = v; }
}

function sourcedContext(db: Db, w: Work) {
  const cents = new Set<number>([w.account.balance_cents]);
  for (const t of all<{ text: string | null }>(db, `SELECT text FROM voice_call_events WHERE tenant_id=? AND client_id=? AND call_id=? AND speaker='rep'`, w.row.tenant_id, w.row.client_id, w.row.call_id)) {
    for (const m of findMoney(openText(t.text ?? ''))) cents.add(m.cents);
  }
  return { sourcedCents: cents, sourcedDates: new Set<string>([w.account.service_date]) };
}

function guardAgent(db: Db, w: Work, action: AgentAction, text: string, questionId: string | null) {
  const v = guardOutbound(text, { ...sourcedContext(db, w), intent: action.type === 'say' ? action.intent : action.type });
  if (v.action === 'allow') return;
  const data = { direction: 'outbound', guard: v.version, profile: v.profile, modes: v.modes, rules: v.hits.map((h) => h.ruleId), questionId };
  if (v.action === 'block') {
    flag(db, w, 'guard_blocked_utterance', `Guard withheld an agent utterance (${v.hits.map((h) => h.why).join('; ')}). Nothing was said; the call goes to a human.`, data);
    throw new GuardHalt(v);
  }
  flag(db, w, 'guard_outbound_warning', `Guard warning on an agent utterance: ${v.hits.map((h) => h.why).join('; ')}. Spoken; recorded for reviewers.`, data);
}

function guardRep(db: Db, w: Work, seq: number, text: string) {
  const v = guardInbound(text);
  if (v.action === 'allow') return;
  flag(db, w, 'guard_inbound_warning', `Guard: representative turn ${seq} flagged (${v.hits.map((h) => h.why).join('; ')}). Stored as evidence only; no effect on actions.`,
    { direction: 'inbound', guard: v.version, profile: v.profile, turnSeq: seq, modes: v.modes, rules: v.hits.map((h) => h.ruleId), severity: v.severity });
}

function exchange(db: Db, w: Work, action: AgentAction, agentText: string | null, questionId: string | null = null) {
  const talkBucket = ['dialing', 'ivr'].includes(w.row.state) ? 'ivr' : 'talk';
  if (agentText && action.type !== 'ivr_input') guardAgent(db, w, action, agentText, questionId);
  if (agentText) {
    addTime(w, secondsFor(agentText), talkBucket);
    event(db, w, { kind: action.type === 'ivr_input' ? 'dtmf' : 'turn', speaker: 'agent', text: agentText, questionId, data: { action: action.type } });
  }
  const { state, events } = simRespond(w.ctx, w.line, action);
  w.line = state;
  const repTurns: { seq: number; text: string }[] = [];
  for (const e of events) {
    switch (e.kind) {
      case 'ivr': addTime(w, e.seconds, 'ivr'); event(db, w, { kind: 'ivr', speaker: 'ivr', text: e.text }); break;
      case 'hold': addTime(w, e.seconds, 'hold'); event(db, w, { kind: 'hold', text: `${e.text} (${e.seconds}s)`, data: { seconds: e.seconds } }); break;
      case 'connected': event(db, w, { kind: 'system', text: `Representative connected (${e.repName})`, data: { repName: e.repName } }); break;
      case 'rep': { addTime(w, e.seconds, 'talk'); const seq = event(db, w, { kind: 'turn', speaker: 'rep', text: e.text, questionId }); repTurns.push({ seq, text: e.text }); guardRep(db, w, seq, e.text); break; }
      case 'transfer': event(db, w, { kind: 'system', text: e.text, data: { transfer: true } }); break;
      case 'ended': event(db, w, { kind: 'system', text: `Line ended by ${e.by}: ${e.reason.replace(/_/g, ' ')}`, data: { ended: true, by: e.by, reason: e.reason } }); break;
    }
  }
  return { repTurns, events };
}

// ---------------------------------------------------------------- answers

interface AnswerRow { answer_id: string; question_id: string; answer_key: string; fact_key: string | null; value: string | null; unit: string | null; status: string; turn_seqs: string; read_back_seq: number | null; flags: string }

function putAnswer(db: Db, w: Work, qn: PlannedQuestion, a: { answerKey?: string; value: unknown; status: string; turnSeqs: number[]; flags?: string[]; factKey?: string | null }) {
  const id = newId('ans');
  run(db, 'INSERT INTO voice_answers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', w.row.tenant_id, w.row.client_id, w.row.call_id, id, qn.id, a.answerKey ?? qn.answerKey,
    a.factKey === undefined ? qn.factKey : a.factKey, a.value === null || a.value === undefined ? null : JSON.stringify(a.value), qn.expects === 'money' ? 'USD_cents' : null,
    a.status, JSON.stringify(a.turnSeqs), null, JSON.stringify(a.flags ?? []), nowIso(), nowIso());
  return id;
}

function latestAnswer(db: Db, w: Work, qn: PlannedQuestion): AnswerRow | undefined {
  return one<AnswerRow>(db, `SELECT * FROM voice_answers WHERE tenant_id=? AND client_id=? AND call_id=? AND question_id=? AND answer_key=? AND status IN ('extracted','answered','confirmed','unconfirmed')
    ORDER BY rowid DESC LIMIT 1`, w.row.tenant_id, w.row.client_id, w.row.call_id, qn.id, qn.answerKey);
}

function updateAnswer(db: Db, w: Work, id: string, set: { status?: string; value?: unknown; turnSeqs?: number[]; readBackSeq?: number; flags?: string[] }) {
  const cur = one<AnswerRow>(db, 'SELECT * FROM voice_answers WHERE tenant_id=? AND client_id=? AND answer_id=?', w.row.tenant_id, w.row.client_id, id)!;
  run(db, 'UPDATE voice_answers SET status=?, value=?, turn_seqs=?, read_back_seq=?, flags=?, updated_at=? WHERE tenant_id=? AND client_id=? AND answer_id=?',
    set.status ?? cur.status, set.value === undefined ? cur.value : JSON.stringify(set.value), set.turnSeqs ? JSON.stringify(set.turnSeqs) : cur.turn_seqs,
    set.readBackSeq ?? cur.read_back_seq, set.flags ? JSON.stringify(set.flags) : cur.flags, nowIso(), w.row.tenant_id, w.row.client_id, id);
}

// Screens a representative turn that does not answer the question asked.
// Nothing is extracted from it; instruction-like text is flagged for reviewers.
function screenUnsolicited(db: Db, w: Work, t: { seq: number; text: string }) {
  if (isInstructionLike(t.text)) flag(db, w, 'instruction_like_text', 'Representative turn contains instruction-like text. Stored as evidence only; it has no effect on actions or permissions.', { turnSeq: t.seq });
  else if (findMoney(t.text).length || findDate(t.text)) flag(db, w, 'unsupported_statement', 'Unsolicited figures not tied to a planned question; not extracted.', { turnSeq: t.seq });
}

function retryOr(qn: PlannedQuestion, terminal: PlannedQuestion['status'], note: string) {
  if (qn.attempts < qn.maxAttempts) { qn.status = 'pending'; qn.note = note; } else { qn.status = terminal; qn.note = note; }
}

// Applies the representative's reply to the question asked.
function applyAnswer(db: Db, w: Work, qn: PlannedQuestion, turns: { seq: number; text: string }[]) {
  const [ans, ...rest] = turns;
  for (const t of rest) screenUnsolicited(db, w, t);
  if (!ans) { retryOr(qn, 'unknown', 'No answer'); return; }
  if (isInstructionLike(ans.text)) flag(db, w, 'instruction_like_text', 'Answer turn contains instruction-like text; only typed values for the asked question are used.', { turnSeq: ans.seq });

  // A claim reference that is not this account's claim quarantines the answer.
  // (A reference given in answer to a reference question is not a claim number.)
  const givenRef = qn.expects === 'reference' || qn.expects === 'reconcile' ? findReference(ans.text) : null;
  const claims = findClaimReferences(ans.text).filter((c) => c !== givenRef);
  if (claims.some((c) => c !== w.account.claim_reference)) {
    putAnswer(db, w, qn, { value: ans.text, status: 'quarantined', turnSeqs: [ans.seq], flags: ['wrong_claim_reference'] });
    flag(db, w, 'wrong_claim_reference', `Representative referred to ${claims.filter((c) => c !== w.account.claim_reference).join(', ')}, not ${w.account.claim_reference}. Values quarantined.`, { turnSeq: ans.seq });
    w.plan.meta.needsClaimClarification = true;
    qn.status = 'pending';
    qn.attempts = Math.max(0, qn.attempts - 1);
    return;
  }
  const refused = isRefusal(ans.text);
  const unknown = !refused && isUnknown(ans.text);

  switch (qn.expects) {
    case 'money': {
      if (refused) { putAnswer(db, w, qn, { value: null, status: 'refused', turnSeqs: [ans.seq] }); retryOr(qn, 'refused', 'Representative declined to provide the value'); return; }
      if (unknown) { putAnswer(db, w, qn, { value: null, status: 'unknown', turnSeqs: [ans.seq] }); qn.status = 'unknown'; qn.note = 'Representative could not provide it; request written EOB or accumulator history'; return; }
      const amounts = [...new Set(findMoney(ans.text).map((m) => m.cents))];
      if (qn.factKey === 'metBeforeCents' && amounts.length && ACCUMULATOR_TIMING.test(ans.text) && !BEFORE_CLAIM.test(ans.text)) {
        putAnswer(db, w, qn, { answerKey: 'totalToDateCents', factKey: null, value: amounts[0], status: 'quarantined', turnSeqs: [ans.seq], flags: ['accumulator_timing_unclear'] });
        flag(db, w, 'accumulator_timing_unclear', `${speakMoney(amounts[0])} was given as a running total, not the amount met before this claim. Not recorded as met-before.`, { turnSeq: ans.seq });
        retryOr(qn, 'unknown', 'Only a running total was given');
        return;
      }
      if (amounts.length !== 1) {
        flag(db, w, amounts.length ? 'ambiguous_value' : 'no_value', amounts.length ? 'More than one amount in the answer' : 'No amount found in the answer', { turnSeq: ans.seq });
        retryOr(qn, 'unknown', 'No single amount');
        return;
      }
      putAnswer(db, w, qn, { value: amounts[0], status: qn.readBack ? 'extracted' : 'answered', turnSeqs: [ans.seq] });
      break;
    }
    case 'date': {
      if (/\bin process\b|\bnot (?:yet )?processed\b|\bpending\b/i.test(ans.text)) {
        putAnswer(db, w, qn, { answerKey: 'claimStatus', factKey: null, value: 'in_process', status: 'answered', turnSeqs: [ans.seq] });
        putAnswer(db, w, qn, { value: null, status: 'unknown', turnSeqs: [ans.seq] });
        qn.status = 'answered'; qn.note = 'Claim in process; no processed date';
        return;
      }
      const d = findDate(ans.text);
      if (!d) { retryOr(qn, 'unknown', 'No date found'); return; }
      if (d.yearMissing) { putAnswer(db, w, qn, { value: d.partial, status: 'unconfirmed', turnSeqs: [ans.seq], flags: ['date_year_missing'] }); flag(db, w, 'date_year_missing', 'Date given without a year; not completed by guessing', { turnSeq: ans.seq }); retryOr(qn, 'unconfirmed', 'Year missing'); return; }
      putAnswer(db, w, qn, { answerKey: 'claimStatus', factKey: null, value: 'processed', status: 'answered', turnSeqs: [ans.seq] });
      putAnswer(db, w, qn, { value: d.iso, status: 'answered', turnSeqs: [ans.seq] });
      qn.status = 'answered';
      return;
    }
    case 'enum': {
      const v = qn.factKey === 'adjustmentGroup' ? findAdjustmentGroup(ans.text) : findCrossover(ans.text);
      if (!v) { if (unknown) { qn.status = 'unknown'; putAnswer(db, w, qn, { value: null, status: 'unknown', turnSeqs: [ans.seq] }); return; } retryOr(qn, 'unknown', 'No recognised value'); return; }
      putAnswer(db, w, qn, { value: v, status: 'answered', turnSeqs: [ans.seq] });
      qn.status = 'answered';
      return;
    }
    case 'text':
      putAnswer(db, w, qn, { value: ans.text, status: 'answered', turnSeqs: [ans.seq] });
      qn.status = 'answered';
      return;
    case 'commitment': {
      if (isAcceptance(ans.text)) {
        const tat = findTurnaround(ans.text);
        putAnswer(db, w, qn, { value: { kind: 'reprocessing_request', status: 'accepted_by_rep', tat, note: 'Acceptance of a request is not a corrected adjudication or payment' }, status: 'answered', turnSeqs: [ans.seq], flags: tat ? [] : ['turnaround_missing'] });
        qn.status = 'accepted';
        w.plan.meta.verbalAcceptance = { questionId: qn.id, turnSeq: ans.seq };
        event(db, w, { kind: 'system', text: 'Representative accepted a reprocessing request (verbal). Recorded as a commitment, not an outcome.', data: { commitment: true, turnSeq: ans.seq } });
        return;
      }
      putAnswer(db, w, qn, { value: { kind: 'reprocessing_request', status: isAgreeToLook(ans.text) ? 'agreed_to_review' : 'declined' }, status: 'answered', turnSeqs: [ans.seq] });
      qn.status = 'declined';
      qn.note = isAgreeToLook(ans.text) ? 'Representative agreed to look; not an accepted request' : 'Representative declined';
      return;
    }
    case 'reference': {
      const ref = refused ? null : findReference(ans.text);
      if (!ref) {
        if (qn.attempts >= qn.maxAttempts) {
          putAnswer(db, w, qn, { value: null, status: refused ? 'refused' : 'unknown', turnSeqs: [ans.seq], flags: ['missing_reference'] });
          flag(db, w, 'missing_reference', `No ${qn.answerKey === 'callReference' ? 'call' : 'request'} reference was provided${refused ? ' (representative declined)' : ''}. None is fabricated; routed to review.`, { turnSeq: ans.seq });
        }
        retryOr(qn, refused ? 'refused' : 'unknown', refused ? 'Representative declined to give a reference' : 'No reference heard');
        return;
      }
      putAnswer(db, w, qn, { value: ref, status: 'extracted', turnSeqs: [ans.seq] });
      break;
    }
    case 'reconcile': {
      const ref = findReference(ans.text);
      if (ref && /\b(yes|see|found)\b/i.test(ans.text)) {
        putAnswer(db, w, qn, { value: ref, status: 'extracted', turnSeqs: [ans.seq] });
        const tat = findTurnaround(ans.text);
        if (tat) putAnswer(db, w, qn, { answerKey: 'priorRequestTurnaround', factKey: null, value: tat, status: 'answered', turnSeqs: [ans.seq] });
        break;
      }
      if (isUnknown(ans.text) || /\bdon'?t see any\b|\bno (?:open )?request\b/i.test(ans.text)) {
        putAnswer(db, w, qn, { value: null, status: 'answered', turnSeqs: [ans.seq], flags: ['no_request_found'] });
        qn.status = 'not_found';
        qn.note = 'Payer has no record of the earlier request; a new request may be made if policy allows';
        return;
      }
      retryOr(qn, 'unknown', 'Unclear whether a request exists');
      return;
    }
  }
  // Values that require read-back
  qn.status = 'awaiting_read_back';
  w.row.pending_read_back = qn.id;
}

// Read-back in words (ADR 0080, ported from clinic-receptionist src/spoken.ts): text-to-speech cannot
// misread "$425.00" or merge the characters of a reference. The Guard turns the words back into
// digits before its identifier and sourced-figure checks (guard.ts).
function formatForReadBack(qn: PlannedQuestion, value: unknown): string {
  if (qn.expects === 'money') return speakDollars(value as number);
  if (qn.expects === 'date' && typeof value === 'string') return speakIsoDate(value);
  return speakReference(String(value));
}

// ---------------------------------------------------------------- steps

const CRASH_FAULT = 'crash_mid_step';

export function setVoiceFault(db: Db, fault: string, remaining: number) {
  run(db, 'INSERT INTO sim_voice_faults VALUES (?, ?) ON CONFLICT(fault) DO UPDATE SET remaining = excluded.remaining', fault, remaining);
}
function takeVoiceFault(db: Db, fault: string): boolean {
  return run(db, 'UPDATE sim_voice_faults SET remaining = remaining - 1 WHERE fault = ? AND remaining > 0', fault) === 1;
}

function hangupTo(db: Db, w: Work, state: string, reasonCode: string, outcome: string, reason: string) {
  if (w.line.phase !== 'ended') exchange(db, w, { type: 'hangup', reason }, null);
  finish(db, w, state, reasonCode, outcome);
}

function onLineEnded(db: Db, w: Work) {
  const end = w.line.ended ?? { by: 'provider', reason: 'unknown' };
  if (end.by === 'agent' && (end.reason === 'completed' || end.reason === 'cancelled')) {
    const c = w.row.cancel_requested;
    return c ? finish(db, w, 'cancelled', c === 'automation_paused' ? 'AUTOMATION_PAUSED' : 'CANCELLED', 'cancelled') : finish(db, w, 'completed', null, 'completed');
  }
  if (end.reason === 'rep_refused_automation') return finish(db, w, 'failed', 'REP_REFUSED', 'refused_by_representative');
  if (end.reason === 'ivr_invalid_input') return finish(db, w, 'failed', 'IVR_NAVIGATION_FAILED', 'ivr_failed');
  const accepted = !!w.plan.meta.verbalAcceptance && !w.plan.questions.some((q) => q.id === 'request_reference' && q.status === 'confirmed');
  if (accepted) {
    w.row.reconcile_required = 1;
    flag(db, w, 'dropped_after_acceptance', 'The line dropped after the representative accepted a request and before its reference was confirmed. Reconcile with the payer before any new request.');
  }
  finish(db, w, 'dropped', accepted ? 'DROPPED_AFTER_ACCEPTANCE' : 'DROPPED', 'dropped');
}

export function stepCall(db: Db, w: Work): void {
  try { stepCallInner(db, w); } catch (err) {
    if (!(err instanceof GuardHalt)) throw err;
    handoff(db, w, null, 'GUARD_BLOCKED_UTTERANCE', `Guard withheld an agent utterance: ${err.message}`);
  }
}

function stepCallInner(db: Db, w: Work): void {
  const r = w.row;
  if (TERMINAL_STATES.includes(r.state) || r.state === 'handoff_to_human') return;

  // Controlled cancellation on pause (FR16): stop new questions and close politely.
  const pause = activePause(db, r.tenant_id, r.client_id);
  if (pause && !r.cancel_requested) { r.cancel_requested = 'automation_paused'; event(db, w, { kind: 'system', text: `Automation paused (${pause.scopeKey}); ending the call in a controlled way`, data: { pause: pause.scopeKey } }); }

  if (w.line.phase === 'ended' && r.state !== 'queued') { onLineEnded(db, w); return; }

  switch (r.state) {
    case 'queued':
      if (r.cancel_requested) { finish(db, w, 'cancelled', 'CANCELLED', 'cancelled'); return; }
      transition(db, w, 'dialing');
      event(db, w, { kind: 'system', text: `Dialing ${r.destination} (simulated line)` });
      return;
    case 'dialing': {
      if (r.cancel_requested) { finish(db, w, 'cancelled', 'CANCELLED', 'cancelled'); return; }
      exchange(db, w, { type: 'dial' }, null);
      transition(db, w, 'ivr');
      return;
    }
    case 'ivr': {
      if (r.cancel_requested) return hangupTo(db, w, 'cancelled', 'CANCELLED', 'cancelled', 'cancelled');
      const node = w.ctx.line.ivr[w.line.ivrIndex];
      const value = node.input.replace('{claim}', w.account.claim_reference).replace('{provider}', w.account.provider_id);
      exchange(db, w, { type: 'ivr_input', value }, node.kind === 'dtmf' ? `[DTMF ${value}]` : value);
      if (w.line.phase === 'ended') return onLineEnded(db, w);
      if (w.line.phase === 'hold') { r.hold_segment_ms = 0; transition(db, w, 'hold'); }
      return;
    }
    case 'transfer':
      r.hold_segment_ms = 0;
      transition(db, w, 'hold', { afterTransfer: true });
      return;
    case 'hold': {
      if (r.cancel_requested) return hangupTo(db, w, 'cancelled', 'CANCELLED', 'cancelled', 'cancelled');
      exchange(db, w, { type: 'wait' }, null);
      if (w.line.phase === 'rep') { transition(db, w, 'rep_connected'); return; }
      if (r.hold_segment_ms >= r.hold_timeout_ms) {
        flag(db, w, 'hold_timeout', `Hold exceeded ${Math.round(r.hold_timeout_ms / 1000)}s; abandoned before reaching a representative. Nothing was said to the payer; safe to retry under policy.`);
        return hangupTo(db, w, 'failed', 'HOLD_TIMEOUT', 'abandoned_on_hold', 'hold_timeout');
      }
      return;
    }
    case 'rep_connected': {
      if (r.cancel_requested) { transition(db, w, 'wrap_up'); return; }
      const pol = policyVersion(db, r.tenant_id, r.client_id, r.policy_version).definition;
      // A recorded call (ADR 0080) speaks the client's recording disclosure line in the opening; recording starts only after it was spoken.
      const rec = w.plan.recording;
      const text = pol.disclosure.automationDisclosure + (rec ? ` ${rec.disclosureLine}` : pol.recording.enabled && pol.disclosure.announceRecording ? ' This call may be recorded.' : '');
      exchange(db, w, { type: 'say', intent: 'disclose', text }, text);
      if (rec) {
        const seq = one<{ s: number }>(db, "SELECT MAX(seq) s FROM voice_call_events WHERE tenant_id=? AND client_id=? AND call_id=? AND speaker='agent'", r.tenant_id, r.client_id, r.call_id)!.s;
        startSimulatedRecording(db, { tenantId: r.tenant_id, clientId: r.client_id, callId: r.call_id, accountId: r.account_id, policyVersion: rec.policyVersion, policySha256: rec.policySha256, consentMode: rec.consentMode, disclosureSeq: seq });
      }
      if (w.line.phase === 'ended') return onLineEnded(db, w);
      transition(db, w, 'authenticating');
      return;
    }
    case 'authenticating': {
      if (r.cancel_requested) { transition(db, w, 'wrap_up'); return; }
      const pol = policyVersion(db, r.tenant_id, r.client_id, r.policy_version).definition;
      // Minimum necessary: billing entity, provider id, claim reference and DOS from verified account context.
      const text = `I'm calling on behalf of ${pol.billingEntityName}, provider ID ${w.account.provider_id}, about claim ${w.account.claim_reference} with date of service ${w.account.service_date}.`;
      const { repTurns } = exchange(db, w, { type: 'say', intent: 'identify', text }, text);
      if (w.line.phase === 'ended') return onLineEnded(db, w);
      const reply = repTurns.map((t) => t.text).join(' ');
      if (/\b(date of birth|full name|social security|member id|home address)\b/i.test(reply)) {
        flag(db, w, 'unsupported_identity_request', 'Representative asked for identifiers outside the approved script; stopping for a human (docs/08).', { turnSeq: repTurns[0]?.seq });
        handoff(db, w, null, 'UNSUPPORTED_IDENTITY_REQUEST', 'Representative requested identifiers outside the approved script');
        return;
      }
      transition(db, w, 'questioning');
      return;
    }
    case 'questioning': {
      if (r.cancel_requested) { transition(db, w, 'wrap_up'); return; }
      if (w.plan.meta.needsClaimClarification) {
        w.plan.meta.claimClarifications++;
        if (w.plan.meta.claimClarifications > 2) { handoff(db, w, null, 'WRONG_CLAIM_PERSISTS', 'Representative kept referring to a different claim'); return; }
        const text = `I'm calling about claim ${w.account.claim_reference} with date of service ${w.account.service_date}, not another claim. Can you confirm you have that claim open?`;
        const { repTurns } = exchange(db, w, { type: 'say', intent: 'clarify_claim', text }, text);
        if (repTurns.some((t) => findClaimReferences(t.text).includes(w.account.claim_reference) && !findClaimReferences(t.text).some((c) => c !== w.account.claim_reference))) w.plan.meta.needsClaimClarification = false;
        return;
      }
      const qn = nextQuestion(w.plan);
      if (!qn) { transition(db, w, 'wrap_up'); return; }
      const text = promptFor(qn, w.account.claim_reference);
      qn.attempts++;
      qn.status = 'asked';
      const { repTurns, events } = exchange(db, w, { type: 'ask', questionId: qn.id, text }, text, qn.id);
      if (events.some((e) => e.kind === 'transfer')) { qn.status = 'pending'; qn.attempts--; transition(db, w, 'transfer'); return; }
      applyAnswer(db, w, qn, repTurns);
      if (w.line.phase === 'ended') return onLineEnded(db, w);
      if (w.row.pending_read_back === qn.id) transition(db, w, 'read_back', { questionId: qn.id });
      return;
    }
    case 'read_back': {
      const qn = w.plan.questions.find((x) => x.id === r.pending_read_back);
      const ans = qn ? latestAnswer(db, w, qn) : undefined;
      if (!qn || !ans) { r.pending_read_back = null; transition(db, w, 'questioning'); return; }
      const value = JSON.parse(ans.value!);
      qn.readBackAttempts++;
      const text = `Reading back ${qn.expects === 'reconcile' ? 'the request number' : qn.label.toLowerCase()}: ${formatForReadBack(qn, value)}. Is that correct?`;
      const { repTurns } = exchange(db, w, { type: 'read_back', questionId: qn.id, text, value }, text, qn.id);
      const reply = repTurns[0];
      for (const t of repTurns.slice(1)) screenUnsolicited(db, w, t);
      const done = (status: PlannedQuestion['status']) => { qn.status = status; r.pending_read_back = null; transition(db, w, 'questioning'); };
      if (reply && isConfirmation(reply.text)) {
        updateAnswer(db, w, ans.answer_id, { status: 'confirmed', readBackSeq: reply.seq });
        return done(qn.expects === 'reconcile' ? 'found' : 'confirmed');
      }
      if (reply && isNegation(reply.text)) {
        const corrected = qn.expects === 'money' ? [...new Set(findMoney(reply.text).map((m) => m.cents))] : [findReference(reply.text)].filter(Boolean);
        if (corrected.length === 1 && qn.readBackAttempts < 2) {
          updateAnswer(db, w, ans.answer_id, { status: 'unconfirmed', flags: ['corrected_on_read_back'] });
          putAnswer(db, w, qn, { value: corrected[0], status: 'extracted', turnSeqs: [reply.seq], flags: ['from_read_back_correction'] });
          flag(db, w, 'read_back_correction', 'Representative corrected the value on read-back; reading back again.', { turnSeq: reply.seq });
          return; // stay in read_back for the corrected value
        }
      }
      updateAnswer(db, w, ans.answer_id, { status: 'unconfirmed' });
      flag(db, w, 'read_back_unconfirmed', `${qn.label} was not confirmed on read-back; it is not recorded as a fact.`, { turnSeq: reply?.seq ?? null });
      return done('unconfirmed');
    }
    case 'wrap_up': {
      const pending = w.plan.questions.filter((x) => !TERMINAL_QUESTION.includes(x.status)).map((x) => x.label.toLowerCase());
      const text = r.cancel_requested ? 'I need to end this call now. Thank you for your help. Goodbye.'
        : `Thank you. I have what I need${pending.length ? `, apart from ${pending.join(', ')}` : ''}. Goodbye.`;
      exchange(db, w, { type: 'say', intent: 'close', text }, text);
      if (w.line.phase === 'ended') return onLineEnded(db, w);
      return;
    }
  }
}

// ---------------------------------------------------------------- finish: evidence, facts, proposals

function finish(db: Db, w: Work, state: string, reasonCode: string | null, outcome: string) {
  const r = w.row;
  for (const qn of w.plan.questions) if (!TERMINAL_QUESTION.includes(qn.status)) { qn.status = qn.status === 'asked' || qn.status === 'awaiting_read_back' ? 'unconfirmed' : 'skipped'; qn.note = qn.note ?? `Call ended (${state})`; }
  r.pending_read_back = null;
  transition(db, w, state, { reasonCode, outcome });
  finishSimulatedRecording(db, { tenantId: r.tenant_id, clientId: r.client_id, callId: r.call_id, durationMs: r.sim_elapsed_ms }); // no-op unless recorded (ADR 0080)
  r.reason_code = reasonCode;
  r.outcome = outcome;
  r.ended_at = nowIso();
  const scope = workerScope(r);
  const answers = all<AnswerRow>(db, 'SELECT * FROM voice_answers WHERE tenant_id=? AND client_id=? AND call_id=? ORDER BY rowid', r.tenant_id, r.client_id, r.call_id);
  const events = all<{ seq: number; kind: string; speaker: string | null; text: string | null; question_id: string | null; sim_at_ms: number; data: string }>(db,
    'SELECT seq, kind, speaker, text, question_id, sim_at_ms, data FROM voice_call_events WHERE tenant_id=? AND client_id=? AND call_id=? ORDER BY seq', r.tenant_id, r.client_id, r.call_id)
    .map((e) => ({ ...e, text: e.text === null ? null : openText(e.text) }));

  // Verifier: compare captured fact values with current facts; missing references.
  const facts = currentFacts(db, scope, r.account_id);
  const verification: { answerKey: string; verdict: string; detail: string }[] = [];
  const extracts = new Map<number, Record<string, unknown>>();
  for (const a of answers) {
    const value = a.value === null ? null : JSON.parse(a.value);
    if (a.fact_key && (a.status === 'confirmed' || a.status === 'answered') && value !== null) {
      const f = facts.get(a.fact_key);
      const contradicts = f && (f.status === 'verified' || f.status === 'reported') && JSON.stringify(f.value) !== JSON.stringify(value);
      verification.push({ answerKey: a.answer_key, verdict: contradicts ? 'contradicts_existing' : 'supported', detail: contradicts ? `Rep value ${JSON.stringify(value)} vs existing ${f!.status} ${JSON.stringify(f!.value)}; fact will be conflicting` : `Recorded as reported (${a.status === 'confirmed' ? 'read back and confirmed' : 'answered'})` });
      if (contradicts) flag(db, w, 'contradicts_existing', `${a.fact_key}: representative value differs from the existing ${f!.status} fact`, { factKey: a.fact_key });
      const seq = JSON.parse(a.turn_seqs)[0] as number;
      extracts.set(seq, { ...(extracts.get(seq) ?? {}), [a.fact_key]: value });
    } else if (a.status === 'unconfirmed' || a.status === 'extracted') verification.push({ answerKey: a.answer_key, verdict: 'unconfirmed', detail: 'Not confirmed on read-back; not recorded as a fact' });
    else if (a.status === 'quarantined') verification.push({ answerKey: a.answer_key, verdict: 'quarantined', detail: JSON.parse(a.flags).join(', ') });
    else if (a.status === 'refused' || a.status === 'unknown') verification.push({ answerKey: a.answer_key, verdict: a.status, detail: JSON.parse(a.flags).includes('missing_reference') ? 'No reference provided; none fabricated' : 'Left unknown' });
  }
  const callRef = answers.find((a) => a.answer_key === 'callReference' && a.status === 'confirmed');
  const callReference = callRef ? JSON.parse(callRef.value!) as string : null;
  if (!callReference && events.some((e) => e.speaker === 'rep') && !events.some((e) => e.kind === 'flag' && JSON.parse(e.data).code === 'missing_reference')) {
    flag(db, w, 'missing_reference', 'No confirmed call reference. None is fabricated; routed to review.');
  }
  w.plan.verification = verification;

  const hasRep = events.some((e) => e.speaker === 'rep');
  let evidenceId: string | null = null;
  if (hasRep) {
    const content = {
      simulated: true, mocked: true, channel: 'voice', engine: ENGINE_VERSION, extractor: EXTRACTOR_VERSION, callId: r.call_id, destination: r.destination,
      callReference, policy: { version: r.policy_version, sha256: r.policy_sha256 }, plan: { id: r.plan_id, version: r.plan_version }, simScript: r.sim_script,
      notice: 'Simulated payer line. No telephony, speech or model was used. Representative text is untrusted evidence; only read-back values for planned questions become observations.',
      endState: state, reasonCode,
      turns: events.filter((e) => e.kind !== 'state' && e.kind !== 'flag').map((e) => ({ turn: e.seq, speaker: e.speaker ?? e.kind, text: e.text ?? '', atMs: e.sim_at_ms, ...(e.speaker === 'rep' && extracts.has(e.seq) ? { extracts: extracts.get(e.seq) } : {}) })),
      answers: answers.map((a) => ({ questionId: a.question_id, key: a.answer_key, factKey: a.fact_key, value: a.value === null ? null : JSON.parse(a.value), status: a.status, turns: JSON.parse(a.turn_seqs), readBackTurn: a.read_back_seq, flags: JSON.parse(a.flags) })),
      flags: events.filter((e) => e.kind === 'flag').map((e) => ({ turn: e.seq, ...JSON.parse(e.data), text: e.text })),
      verification,
    };
    const ev = addEvidence(db, scope, { accountId: r.account_id, kind: 'call_transcript', title: `Simulated payer call ${callReference ?? r.call_id}`, source: 'sim-voice-adapter', content, effectiveAt: nowIso() });
    evidenceId = ev?.evidenceId ?? null;
  }
  const interactionId = newId('call');
  const transitions = events.filter((e) => e.kind === 'state').map((e) => ({ state: JSON.parse(e.data).to as string, atMs: e.sim_at_ms }));
  run(db, 'INSERT INTO interactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', r.tenant_id, r.client_id, r.account_id, interactionId, 'voice', r.destination, state,
    JSON.stringify([{ state: 'queued', atMs: 0 }, ...transitions]), evidenceId, callReference, 1, r.created_by, nowIso());
  r.transcript_evidence_id = evidenceId;
  r.interaction_id = interactionId;
  audit(db, { tenantId: r.tenant_id, clientId: r.client_id, actorId: 'system', objectType: 'voice_call', objectId: r.call_id, accountId: r.account_id,
    eventType: 'voice_call_ended', details: { state, reasonCode, outcome, callReference, evidenceId, simulated: true } });

  // Reconciliation of an earlier dropped call.
  const rec = w.plan.questions.find((q) => q.id === 'reconcile_prior_request');
  const prior = w.plan.basis.priorUnreconciledCallId;
  if (prior && rec && (rec.status === 'found' || rec.status === 'not_found')) {
    run(db, 'UPDATE voice_calls SET reconcile_required=0, reconciled_by=?, updated_at=?, version=version+1 WHERE tenant_id=? AND client_id=? AND call_id=?', r.call_id, nowIso(), r.tenant_id, r.client_id, prior);
    audit(db, { tenantId: r.tenant_id, clientId: r.client_id, actorId: 'system', objectType: 'voice_call', objectId: prior, accountId: r.account_id,
      eventType: 'voice_call_reconciled', details: { reconciledBy: r.call_id, outcome: rec.status === 'found' ? 'request_found_at_payer' : 'no_request_at_payer' } });
  }

  const before = getAccountRow(db, scope, r.account_id).revision;
  resolveFacts(db, scope, r.account_id);
  const verbal = !!w.plan.meta.verbalAcceptance || rec?.status === 'found';
  if (verbal) {
    // A verbal request is already with the payer: retire open proposals for the
    // same request so it is not approved and sent a second time.
    const acct = getAccountRow(db, scope, r.account_id);
    for (const p of all<{ action_id: string }>(db, `SELECT action_id FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND state='awaiting_review' AND kind='clarify_allocation'`, r.tenant_id, r.client_id, r.account_id)) {
      run(db, `UPDATE proposed_actions SET state='superseded', updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=?`, nowIso(), r.tenant_id, r.client_id, p.action_id);
      audit(db, { tenantId: r.tenant_id, clientId: r.client_id, actorId: 'system', objectType: 'action', objectId: p.action_id, accountId: r.account_id,
        eventType: 'proposal_superseded', details: { reason: 'A verbal reprocessing request was accepted on a payer call', callId: r.call_id, newRevision: acct.revision } });
    }
    const confirmedRef = w.plan.questions.some((q) => (q.id === 'request_reference' && q.status === 'confirmed') || (q.id === 'reconcile_prior_request' && q.status === 'found'));
    run(db, 'UPDATE accounts SET state=?, updated_at=? WHERE tenant_id=? AND client_id=? AND account_id=?', confirmedRef ? 'awaiting_receipt' : 'receipt_uncertain', nowIso(), r.tenant_id, r.client_id, r.account_id);
    // Notification hook (ADR 0070): an open verbal request until a receipt or adjudication reconciles it.
    audit(db, { tenantId: r.tenant_id, clientId: r.client_id, actorId: 'system', objectType: 'voice_call', objectId: r.call_id, accountId: r.account_id,
      eventType: 'verbal_request_recorded', details: { referenceConfirmed: confirmedRef } });
  } else if (evidenceId) {
    evaluateAndPropose(db, scope, r.account_id, { trigger: 'call', callId: r.call_id, interactionId, revisionBefore: before });
  }
}

// ---------------------------------------------------------------- handoff

function handoffPacket(db: Db, w: Work, reason: string) {
  const answers = all<AnswerRow>(db, 'SELECT * FROM voice_answers WHERE tenant_id=? AND client_id=? AND call_id=? ORDER BY rowid', w.row.tenant_id, w.row.client_id, w.row.call_id);
  const tail = all<{ seq: number; speaker: string | null; text: string | null }>(db,
    `SELECT seq, speaker, text FROM voice_call_events WHERE tenant_id=? AND client_id=? AND call_id=? AND kind IN ('turn','ivr','system') ORDER BY seq DESC LIMIT 6`, w.row.tenant_id, w.row.client_id, w.row.call_id).reverse()
    .map((e) => ({ ...e, text: e.text === null ? null : openText(e.text) }));
  return {
    reason,
    identityContext: { externalId: w.account.external_id, claimReference: w.account.claim_reference, payerId: w.account.payer_id, providerId: w.account.provider_id, serviceDate: w.account.service_date, identityVerified: true },
    questions: w.plan.questions.map((q) => ({ id: q.id, label: q.label, status: q.status, reason: q.reason, note: q.note })),
    answered: answers.filter((a) => ['confirmed', 'answered'].includes(a.status)).map((a) => ({ key: a.answer_key, value: a.value === null ? null : JSON.parse(a.value), status: a.status, turns: JSON.parse(a.turn_seqs) })),
    unconfirmed: answers.filter((a) => ['extracted', 'unconfirmed', 'quarantined'].includes(a.status)).map((a) => ({ key: a.answer_key, value: a.value === null ? null : JSON.parse(a.value), status: a.status, flags: JSON.parse(a.flags) })),
    openQuestions: w.plan.questions.filter((q) => !TERMINAL_QUESTION.includes(q.status)).map((q) => q.label),
    commitments: answers.filter((a) => a.answer_key === 'reprocessingCommitment').map((a) => JSON.parse(a.value ?? 'null')),
    connection: { state: w.row.state, linePhase: w.line.phase, connected: w.line.phase === 'rep' },
    transcriptTail: tail,
  };
}

function handoff(db: Db, w: Work, userId: string | null, reasonCode: string, reason: string) {
  const packet = handoffPacket(db, w, reason);
  w.adapter.transferCall(w.row.provider_call_id, { kind: 'human_queue', queue: `${w.row.client_id}-specialists` });
  w.row.handoff = seal(canonicalJson({ ...packet, by: userId ?? 'system', at: nowIso() }));
  w.row.assigned_to = userId;
  w.row.reason_code = reasonCode;
  transition(db, w, 'handoff_to_human', { reasonCode, by: userId ?? 'system' });
  audit(db, { tenantId: w.row.tenant_id, clientId: w.row.client_id, actorId: userId ?? 'system', objectType: 'voice_call', objectId: w.row.call_id, accountId: w.row.account_id,
    eventType: 'voice_call_handoff', details: { reasonCode, reason, openQuestions: packet.openQuestions.length } });
}

// ---------------------------------------------------------------- public operations

export function startCall(db: Db, scope: Scope, accountId: string, body: { idempotencyKey?: unknown; simScript?: unknown }) {
  requirePerm(scope, 'investigate');
  const key = body.idempotencyKey === undefined ? null : String(body.idempotencyKey);
  if (key !== null && !/^[\w-]{8,80}$/.test(key)) throw invalid('idempotencyKey must be 8-80 characters of letters, digits, _ or -');
  const simScript = body.simScript === undefined || body.simScript === null ? null : String(body.simScript);
  if (simScript && (!SYNTHETIC_ENVIRONMENT || !SIM_SCRIPTS[simScript])) throw invalid('Unknown simulator script');
  const out = tx(db, () => {
    const a = getAccountRow(db, scope, accountId);
    if (one<{ deleted_at: string | null }>(db, 'SELECT deleted_at FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', scope.tenantId, scope.clientId, accountId)?.deleted_at) throw conflict('account_deleted', 'This account was deleted at the owner\'s request (ADR 0080)');
    if (key) {
      const existing = one<CallRow>(db, 'SELECT * FROM voice_calls WHERE tenant_id=? AND client_id=? AND idempotency_key=?', scope.tenantId, scope.clientId, key);
      if (existing) {
        if (existing.account_id !== accountId) throw conflict('idempotency_key_reused', 'This idempotency key belongs to a different call');
        return { callId: existing.call_id, state: existing.state, duplicate: true };
      }
    }
    const gate = evaluateGate(db, scope, a);
    if (!gate.allowed) {
      // Recorded in its own committed write; nothing else changes on a refusal.
      audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'account', objectId: accountId, accountId,
        eventType: 'voice_call_refused', details: { reasonCodes: gate.reasonCodes, policyVersion: gate.policy.version } });
      return { refused: gate };
    }
    const callId = newId('vc');
    const idem = key ?? newId('idem');
    const recGate = recordingGate(db, scope, 'sim_voice'); // ADR 0080: off by default; every gate must hold
    if (recGate.allowed) gate.plan!.recording = { required: true, disclosureLine: recGate.disclosureLine, policyVersion: recGate.policy.version, policySha256: recGate.policy.sha256, consentMode: recGate.consentMode };
    const adapter = adapterFor(db, 'sim_voice');
    const pol = currentPolicy(db, scope.tenantId, scope.clientId);
    const started = adapter.startCall({ requestId: callId, tenantId: scope.tenantId, clientId: scope.clientId, accountRevision: a.revision, idempotencyKey: idem,
      destination: gate.line!.destination, timeBudgetSeconds: 3600, recording: { enabled: pol.definition.recording.enabled, consentMode: pol.definition.recording.consentMode } });
    const ts = nowIso();
    run(db, `INSERT INTO voice_calls (tenant_id, client_id, call_id, account_id, payer_id, destination, scenario_id, plan_id, plan_version, policy_version, policy_sha256,
        adapter, provider_call_id, sim_script, state, plan, line_state, hold_timeout_ms, idempotency_key, account_revision_at_start, next_step_at, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    scope.tenantId, scope.clientId, callId, accountId, a.payer_id, gate.line!.destination, gate.scenario!, gate.plan!.planId, gate.plan!.version, gate.policy.version, gate.policy.sha256,
    adapter.name, started.providerCallId, simScript, 'queued', canonicalJson(gate.plan), canonicalJson(initialLineState()), gate.line!.holdTimeoutSeconds * 1000, idem, a.revision, ts,
    scope.userId, ts, ts);
    const w = open(db, loadCall(db, scope, callId));
    event(db, w, { kind: 'state', text: '→ queued', data: { from: null, to: 'queued', gate: gate.checks.map((c) => c.id), policyVersion: gate.policy.version } });
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'voice_call', objectId: callId, accountId,
      eventType: 'voice_call_started', details: { destination: gate.line!.destination, policyVersion: gate.policy.version, plan: `${gate.plan!.planId}@${gate.plan!.version}`,
        questions: gate.plan!.questions.map((q) => q.id), simulated: true, simScript, recording: recGate.allowed } });
    return { callId, state: 'queued', duplicate: false };
  });
  if ('refused' in out && out.refused) {
    const g = out.refused;
    throw new AppError(422, 'call_policy_refused', `Call refused: ${g.reasonCodes.join(', ')}`, { reasonCodes: g.reasonCodes, checks: g.checks });
  }
  return out;
}

function stepOnce(db: Db, tenantId: string, clientId: string, callId: string): CallRow {
  // Simulator fault for restart tests: consumed outside the step transaction so
  // the crash itself is not rolled back with the step.
  const crash = takeVoiceFault(db, CRASH_FAULT);
  return tx(db, () => {
    const w = open(db, loadCall(db, { tenantId, clientId }, callId));
    stepCall(db, w);
    if (crash) throw new Error('Simulated worker crash mid-step');
    save(db, w, w.row.state === 'hold' ? STEP_MS * 2 : STEP_MS);
    return w.row;
  });
}

export function advanceCall(db: Db, scope: Scope, callId: string, maxSteps = 1) {
  requirePerm(scope, 'investigate');
  loadCall(db, scope, callId);
  const steps = Math.max(1, Math.min(200, Math.floor(maxSteps)));
  let c = loadCall(db, scope, callId);
  for (let i = 0; i < steps; i++) {
    if (TERMINAL_STATES.includes(c.state) || c.state === 'handoff_to_human') break;
    c = stepOnce(db, scope.tenantId, scope.clientId, callId);
  }
  return { callId, state: c.state, outcome: c.outcome, reasonCode: c.reason_code };
}

export function cancelCall(db: Db, scope: Scope, callId: string, reason: string) {
  if (!can(scope, 'investigate') && !can(scope, 'operate')) throw forbidden('Your role in this client does not permit: cancel call');
  if (!reason || reason.trim().length < 3) throw invalid('A cancellation reason is required');
  return tx(db, () => {
    const w = open(db, loadCall(db, scope, callId));
    if (TERMINAL_STATES.includes(w.row.state)) throw conflict('call_ended', `The call already ended (${w.row.state})`);
    w.adapter.cancelCall(w.row.provider_call_id, reason);
    w.row.cancel_requested = 'user';
    event(db, w, { kind: 'system', text: `Cancellation requested by ${scope.displayName}: ${reason.trim()}`, data: { cancel: true, by: scope.userId } });
    const s = w.row.state;
    if (s === 'queued' || s === 'dialing') finish(db, w, 'cancelled', 'CANCELLED', 'cancelled');
    else if (['ivr', 'hold', 'transfer', 'handoff_to_human'].includes(s)) hangupTo(db, w, 'cancelled', 'CANCELLED', 'cancelled', 'cancelled');
    // Representative on the line: the next step closes politely, then ends.
    audit(db, { tenantId: w.row.tenant_id, clientId: w.row.client_id, actorId: scope.userId, objectType: 'voice_call', objectId: callId, accountId: w.row.account_id,
      eventType: 'voice_call_cancel_requested', details: { reason: reason.trim(), stateAtRequest: s } });
    save(db, w);
    return {
      callId, state: w.row.state,
      message: TERMINAL_STATES.includes(w.row.state) ? 'Call ended.' : 'The agent will close the conversation politely and end the call at the next step.',
      scope: 'Stops this call only. A request the payer already accepted is not withdrawn; it is reconciled.',
    };
  });
}

export function takeOver(db: Db, scope: Scope, callId: string, reason: string) {
  requirePerm(scope, 'investigate');
  return tx(db, () => {
    const w = open(db, loadCall(db, scope, callId));
    if (TERMINAL_STATES.includes(w.row.state)) throw conflict('call_ended', `The call already ended (${w.row.state})`);
    if (w.row.state === 'handoff_to_human') throw conflict('already_handed_off', 'A specialist already has this call');
    handoff(db, w, scope.userId, 'SPECIALIST_TAKEOVER', reason?.trim() || 'Specialist took over the call');
    w.row.assigned_to = scope.userId;
    save(db, w);
    return { callId, state: w.row.state, handoff: JSON.parse(openText(w.row.handoff!)) };
  });
}

export function endHumanCall(db: Db, scope: Scope, callId: string, notes: string) {
  requirePerm(scope, 'investigate');
  return tx(db, () => {
    const w = open(db, loadCall(db, scope, callId));
    if (w.row.state !== 'handoff_to_human') throw conflict('not_handed_off', 'Only a call a specialist has taken over can be ended this way');
    if (w.row.assigned_to && w.row.assigned_to !== scope.userId && !can(scope, 'operate')) throw forbidden('Another specialist has this call');
    if (notes?.trim()) event(db, w, { kind: 'system', text: `Specialist notes (not extracted as facts): ${notes.trim().slice(0, 2000)}`, data: { notes: true, by: scope.userId } });
    w.row.assigned_to = w.row.assigned_to ?? scope.userId;
    if (w.line.phase !== 'ended') exchange(db, w, { type: 'hangup', reason: 'ended_by_specialist' }, null);
    finish(db, w, 'completed', 'HUMAN_COMPLETED', 'completed_by_specialist');
    save(db, w);
    return { callId, state: w.row.state };
  });
}

// Provider status callback (signed). The tenant is resolved from the provider
// call id on the server; the body cannot name a scope.
export function handleVoiceCallback(db: Db, raw: string, signature: string | undefined, timestamp: string | undefined) {
  const adapter = simVoiceAdapter(db);
  const v = adapter.verifyStatusCallback(raw, signature, timestamp);
  if (!v.ok) throw new AppError(401, 'invalid_callback', `Callback rejected: ${v.reason}`);
  const e = v.event;
  return tx(db, () => {
    if (one(db, 'SELECT 1 FROM voice_callbacks WHERE event_id=?', e.eventId)) return { accepted: true, duplicate: true };
    const c = one<CallRow>(db, 'SELECT * FROM voice_calls WHERE adapter=? AND provider_call_id=?', adapter.name, e.providerCallId);
    if (!c) throw notFound('Call');
    run(db, 'INSERT INTO voice_callbacks VALUES (?,?,?,?,?,?,?,?,?)', e.eventId, adapter.name, e.providerCallId, c.tenant_id, c.client_id, c.call_id, e.type, sha256(raw), nowIso());
    if (e.type === 'call.ended' && !TERMINAL_STATES.includes(c.state)) {
      const w = open(db, c);
      if (w.line.phase !== 'ended') {
        w.line.phase = 'ended';
        w.line.ended = { by: 'provider', reason: e.reason ?? 'provider_reported_end' };
        event(db, w, { kind: 'system', text: `Provider reported the call ended (${e.reason ?? 'no reason'})`, data: { callback: e.eventId } });
        save(db, w, 0);
      }
    }
    return { accepted: true, duplicate: false };
  });
}

// Worker: advances automated calls that are due, one step each.
export function voiceTick(db: Db): { stepped: number; errors: number } {
  const due = all<{ tenant_id: string; client_id: string; call_id: string }>(db,
    `SELECT tenant_id, client_id, call_id FROM voice_calls WHERE state IN (${AUTOMATED_STATES.map(() => '?').join(',')}) AND next_step_at <= ? ORDER BY next_step_at LIMIT 20`,
    ...AUTOMATED_STATES, nowIso());
  let stepped = 0;
  let errors = 0;
  for (const d of due) {
    try { stepOnce(db, d.tenant_id, d.client_id, d.call_id); stepped++; } catch (err) { errors++; if (!(err instanceof AppError)) console.error('[voice]', (err as Error).message); }
  }
  return { stepped, errors };
}

// On restart: ask the adapter for each non-terminal call's line status. A line
// still in progress resumes from the persisted step; a line the provider reports
// ended is finished as dropped (and flagged for reconciliation if a request was accepted).
export function recoverCalls(db: Db): { resumed: number; reconciled: number } {
  let resumed = 0;
  let reconciled = 0;
  const rows = all<CallRow>(db, `SELECT * FROM voice_calls WHERE state IN (${AUTOMATED_STATES.map(() => '?').join(',')})`, ...AUTOMATED_STATES);
  for (const c of rows) {
    tx(db, () => {
      const w = open(db, loadCall(db, { tenantId: c.tenant_id, clientId: c.client_id }, c.call_id));
      const status = w.adapter.retrieveResult(c.provider_call_id);
      if (status.status === 'ended' && w.row.state !== 'queued') { onLineEnded(db, w); reconciled++; }
      else { event(db, w, { kind: 'system', text: 'Orchestrator restarted; line still in progress, resuming from the persisted step', data: { recovered: true } }); resumed++; }
      save(db, w, 0);
    });
  }
  return { resumed, reconciled };
}

export function startVoiceWorker(db: Db, intervalMs = STEP_MS): () => void {
  try { recoverCalls(db); } catch (err) { console.error('[voice] recovery', (err as Error).message); }
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    try { voiceTick(db); } catch (err) { console.error('[voice]', (err as Error).message); } finally { busy = false; }
  }, Math.max(200, Math.floor(intervalMs / 2)));
  t.unref?.();
  return () => clearInterval(t);
}

