// Ported from clinic-receptionist src/value.ts (same owner): "what the system did that staff would
// otherwise have done", measured from the activity tables, with staff time saved as an ESTIMATE from
// a stated per-call minutes assumption, labelled as one wherever it is shown.
//
// Adapted for AR Resolve (ADR 0080). The origin counted calls answered and resolved without a person
// (minutes per call default 4). Here the activity is AR follow-up, so the card reports:
//   measured  investigations, simulated payer calls completed without hand-off, hand-offs, review
//             decisions, items awaiting review, median hours from proposal to decision;
//   estimate  calls avoided by structured status (accounts that reached a next step from structured
//             evidence with no call), labor minutes saved and review minutes added, each from the
//             assumptions shown next to it.
// Every assumption is a PLACEHOLDER, not a benchmark: nothing here is a measured productivity,
// accuracy or recovery result. In this environment all activity is synthetic and calls are simulated.
import { type Db, all, one } from '../db/db.ts';
import { now } from '../util.ts';
import { requirePerm, type Scope } from './auth.ts';

export const VALUE_VERSION = 'value.v1';

export interface ValueAssumptions {
  /** Minutes a specialist spends on one manual payer status call, hold included. */
  manualCallMinutes: number;
  /** Minutes a reviewer spends on one review decision. */
  reviewMinutesPerDecision: number;
  /** Minutes a specialist spends taking over a call the agent handed off. */
  handoffMinutes: number;
}

export const DEFAULT_ASSUMPTIONS: ValueAssumptions = { manualCallMinutes: 20, reviewMinutesPerDecision: 3, handoffMinutes: 10 };
export const ASSUMPTION_NOTE = 'Placeholder assumptions for illustration, not measurements or benchmarks. Replace them with time studies from the customer before using any estimate.';

export interface Figure { id: string; label: string; value: number | null; unit: 'count' | 'minutes' | 'hours'; kind: 'measured' | 'estimate'; basis: string }

export interface ValueInputs {
  days: number;
  investigations: number;
  structuredResolvedWithoutCall: number;
  callsCompletedWithoutHandoff: number;
  callsHandedOff: number;
  simulatedCallMinutes: number;
  decisions: number;
  awaitingReview: number;
  decisionLatencyHours: number[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};

/** Pure summary (unit-tested): every figure says whether it is measured or an estimate, and from what. */
export function summarizeValue(i: ValueInputs, a: ValueAssumptions = DEFAULT_ASSUMPTIONS): { figures: Figure[]; netMinutesEstimate: number } {
  const avoided = i.structuredResolvedWithoutCall * a.manualCallMinutes;
  const automated = i.callsCompletedWithoutHandoff * a.manualCallMinutes;
  const handoff = i.callsHandedOff * a.handoffMinutes;
  const review = i.decisions * a.reviewMinutesPerDecision;
  const net = avoided + automated - handoff - review;
  const figures: Figure[] = [
    { id: 'investigations', label: 'Investigations run', value: i.investigations, unit: 'count', kind: 'measured', basis: `workflow runs in the last ${i.days} days` },
    { id: 'calls_avoided', label: 'Calls avoided by structured status', value: i.structuredResolvedWithoutCall, unit: 'count', kind: 'estimate',
      basis: 'Accounts whose investigation proposed a next step from structured evidence (EOB, claim status, eligibility, EDI, FHIR) with no payer call in the period, assuming each would otherwise have needed one status call' },
    { id: 'calls_automated', label: 'Simulated payer calls completed without hand-off', value: i.callsCompletedWithoutHandoff, unit: 'count', kind: 'measured', basis: 'voice calls completed with no hand-off (simulated payer line)' },
    { id: 'calls_handed_off', label: 'Calls handed to a person', value: i.callsHandedOff, unit: 'count', kind: 'measured', basis: 'voice calls that reached hand-off to a human' },
    { id: 'simulated_call_minutes', label: 'Simulated call minutes (hold included)', value: Math.round(i.simulatedCallMinutes), unit: 'minutes', kind: 'measured', basis: 'simulated elapsed time of calls in the period; not real payer hold times' },
    { id: 'review_decisions', label: 'Review decisions', value: i.decisions, unit: 'count', kind: 'measured', basis: 'approve / reject / needs-evidence decisions recorded in the period' },
    { id: 'awaiting_review', label: 'Awaiting review now', value: i.awaitingReview, unit: 'count', kind: 'measured', basis: 'proposals in awaiting_review' },
    { id: 'decision_latency', label: 'Median hours from proposal to decision', value: median(i.decisionLatencyHours), unit: 'hours', kind: 'measured', basis: `${i.decisionLatencyHours.length} decided proposals` },
    { id: 'minutes_saved_avoided', label: 'Labor minutes saved: calls avoided', value: avoided, unit: 'minutes', kind: 'estimate', basis: `${i.structuredResolvedWithoutCall} x ${a.manualCallMinutes} min per manual call (assumption)` },
    { id: 'minutes_saved_automated', label: 'Labor minutes saved: automated calls', value: automated, unit: 'minutes', kind: 'estimate', basis: `${i.callsCompletedWithoutHandoff} x ${a.manualCallMinutes} min per manual call (assumption)` },
    { id: 'minutes_handoff', label: 'Labor minutes spent: hand-offs', value: handoff, unit: 'minutes', kind: 'estimate', basis: `${i.callsHandedOff} x ${a.handoffMinutes} min per hand-off (assumption)` },
    { id: 'minutes_review', label: 'Review burden added', value: review, unit: 'minutes', kind: 'estimate', basis: `${i.decisions} x ${a.reviewMinutesPerDecision} min per decision (assumption)` },
    { id: 'minutes_net', label: 'Net labor minutes (estimate)', value: net, unit: 'minutes', kind: 'estimate', basis: 'saved (avoided + automated) minus hand-off and review minutes; every term is an assumption-based estimate' },
  ];
  return { figures, netMinutesEstimate: net };
}

function assumptionsFrom(q: Record<string, unknown>): ValueAssumptions {
  const pick = (k: keyof ValueAssumptions, env: string) => {
    const raw = q[k] ?? process.env[env];
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n >= 0 && n <= 600 ? n : DEFAULT_ASSUMPTIONS[k];
  };
  return { manualCallMinutes: pick('manualCallMinutes', 'AR_VALUE_MANUAL_CALL_MINUTES'), reviewMinutesPerDecision: pick('reviewMinutesPerDecision', 'AR_VALUE_REVIEW_MINUTES'), handoffMinutes: pick('handoffMinutes', 'AR_VALUE_HANDOFF_MINUTES') };
}

const STRUCTURED_EXCLUDED = ['call_transcript', 'reviewer_correction', 'action_receipt', 'import_row'];

export function computeValue(db: Db, scope: Scope, query: Record<string, unknown> = {}) {
  requirePerm(scope, 'view');
  const days = Math.min(365, Math.max(1, Number(query.days ?? 30) || 30));
  const since = new Date(now().getTime() - days * 86_400_000).toISOString();
  const S = [scope.tenantId, scope.clientId];
  const investigations = one<{ n: number }>(db, 'SELECT COUNT(*) n FROM workflow_runs WHERE tenant_id=? AND client_id=? AND created_at >= ?', ...S, since)!.n;
  const ex = STRUCTURED_EXCLUDED.map(() => '?').join(',');
  const structuredResolvedWithoutCall = one<{ n: number }>(db, `SELECT COUNT(DISTINCT r.account_id) n FROM workflow_runs r
    WHERE r.tenant_id=? AND r.client_id=? AND r.created_at >= ? AND r.state = 'awaiting_review'
      AND EXISTS (SELECT 1 FROM evidence e WHERE e.tenant_id=r.tenant_id AND e.client_id=r.client_id AND e.account_id=r.account_id AND e.kind NOT IN (${ex}))
      AND NOT EXISTS (SELECT 1 FROM voice_calls c WHERE c.tenant_id=r.tenant_id AND c.client_id=r.client_id AND c.account_id=r.account_id AND c.created_at >= ?)`,
  ...S, since, ...STRUCTURED_EXCLUDED, since)!.n;
  const calls = all<{ state: string; handoff: string | null; sim_elapsed_ms: number }>(db, 'SELECT state, handoff, sim_elapsed_ms FROM voice_calls WHERE tenant_id=? AND client_id=? AND created_at >= ?', ...S, since);
  const decided = all<{ created_at: string; decided_at: string }>(db, `SELECT p.created_at, MIN(d.created_at) decided_at FROM review_decisions d JOIN proposed_actions p USING (tenant_id, client_id, action_id)
    WHERE d.tenant_id=? AND d.client_id=? AND d.created_at >= ? GROUP BY p.action_id`, ...S, since);
  const inputs: ValueInputs = {
    days, investigations, structuredResolvedWithoutCall,
    callsCompletedWithoutHandoff: calls.filter((c) => c.state === 'completed' && !c.handoff).length,
    callsHandedOff: calls.filter((c) => !!c.handoff || c.state === 'handoff_to_human').length,
    simulatedCallMinutes: calls.reduce((a, c) => a + c.sim_elapsed_ms, 0) / 60_000,
    decisions: one<{ n: number }>(db, 'SELECT COUNT(*) n FROM review_decisions WHERE tenant_id=? AND client_id=? AND created_at >= ?', ...S, since)!.n,
    awaitingReview: one<{ n: number }>(db, "SELECT COUNT(*) n FROM proposed_actions WHERE tenant_id=? AND client_id=? AND state='awaiting_review'", ...S)!.n,
    decisionLatencyHours: decided.map((d) => Math.round(((Date.parse(d.decided_at) - Date.parse(d.created_at)) / 3_600_000) * 10) / 10),
  };
  const assumptions = assumptionsFrom(query);
  return { version: VALUE_VERSION, days, assumptions, assumptionNote: ASSUMPTION_NOTE, environment: 'synthetic',
    notice: 'Synthetic activity and simulated calls. Estimates are arithmetic on the stated assumptions, not results.', ...summarizeValue(inputs, assumptions), inputs };
}
