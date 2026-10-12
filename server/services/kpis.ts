// Operational KPIs that can be computed from recorded data (build pack docs 09
// and 14). Each metric states its numerator, denominator and definition. On the
// synthetic environment these describe the demo's own activity; they are not
// evidence of accuracy, recovery or productivity.
import { readFileSync } from 'node:fs';
import { type Db, all, one } from '../db/db.ts';
import { invalid } from '../util.ts';
import { requirePerm, type Scope } from './auth.ts';
import { calculate, variants, ECONOMICS_DISCLAIMER, ASSUMPTION_LABELS, type EconomicsAssumptions } from '../../shared/economics.ts';

export interface Metric {
  id: string; label: string; value: number | null; unit: 'ratio' | 'count' | 'minutes' | 'per_account';
  numerator: number | null; denominator: number | null; definition: string;
}

const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 10_000) / 10_000 : null);

function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10) / 10;
}

const minutesBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;

export function computeKpis(db: Db, scope: Scope) {
  requirePerm(scope, 'view');
  const T = scope.tenantId, C = scope.clientId;
  const n = (sql: string, ...p: unknown[]) => one<{ n: number }>(db, sql, T, C, ...p)!.n ?? 0;

  const accounts = n('SELECT COUNT(*) n FROM accounts WHERE tenant_id=? AND client_id=?');
  const touchRows = all<{ account_id: string; touches: number }>(db, `SELECT account_id, SUM(t) touches FROM (
      SELECT account_id, COUNT(*) t FROM workflow_runs WHERE tenant_id=? AND client_id=? GROUP BY account_id
      UNION ALL SELECT account_id, COUNT(*) FROM interactions WHERE tenant_id=? AND client_id=? GROUP BY account_id
      UNION ALL SELECT p.account_id, COUNT(*) FROM review_decisions d JOIN proposed_actions p USING (tenant_id, client_id, action_id) WHERE d.tenant_id=? AND d.client_id=? GROUP BY p.account_id
    ) GROUP BY account_id`, T, C, T, C, T, C);
  const touches = touchRows.reduce((s, r) => s + r.touches, 0);

  const proposals = n(`SELECT COUNT(*) n FROM proposed_actions WHERE tenant_id=? AND client_id=? AND kind <> 'note_writeback'`);
  const reviewed = n(`SELECT COUNT(DISTINCT d.action_id) n FROM review_decisions d JOIN proposed_actions p USING (tenant_id, client_id, action_id) WHERE d.tenant_id=? AND d.client_id=? AND p.kind <> 'note_writeback'`);
  const reviewOpened = n(`SELECT COUNT(*) n FROM analytics_events WHERE tenant_id=? AND client_id=? AND event_name='review_opened'`);
  const runs = n('SELECT COUNT(*) n FROM workflow_runs WHERE tenant_id=? AND client_id=?');
  const abstained = n(`SELECT COUNT(*) n FROM workflow_runs WHERE tenant_id=? AND client_id=? AND state IN ('needs_information','specialist_review','blocked')`);

  const ttp = all<{ created_at: string; first: string }>(db, `SELECT a.created_at, MIN(p.created_at) first FROM accounts a JOIN proposed_actions p ON p.tenant_id=a.tenant_id AND p.client_id=a.client_id AND p.account_id=a.account_id
    WHERE a.tenant_id=? AND a.client_id=? AND p.kind <> 'note_writeback' GROUP BY a.account_id`, T, C).map((r) => minutesBetween(r.created_at, r.first));
  const latency = all<{ created_at: string; decided: string; kind: string }>(db, `SELECT p.created_at, d.created_at decided, p.kind FROM review_decisions d JOIN proposed_actions p USING (tenant_id, client_id, action_id)
    WHERE d.tenant_id=? AND d.client_id=? AND d.decision='approved'`, T, C);
  const finLatency = latency.filter((l) => l.kind !== 'note_writeback').map((l) => minutesBetween(l.created_at, l.decided));

  const attempted = n('SELECT COUNT(*) n FROM action_outbox WHERE tenant_id=? AND client_id=? AND attempts > 0');
  const succeeded = n(`SELECT COUNT(*) n FROM action_outbox WHERE tenant_id=? AND client_id=? AND state IN ('accepted','confirmed')`);
  const attempts = n('SELECT COALESCE(SUM(attempts),0) n FROM action_outbox WHERE tenant_id=? AND client_id=?');
  const uncertainEvents = n(`SELECT COUNT(*) n FROM audit_events WHERE tenant_id=? AND client_id=? AND event_type='dispatch_uncertain'`);

  const completed = all<{ completed_at: string; due_date: string }>(db, `SELECT completed_at, due_date FROM followup_tasks WHERE tenant_id=? AND client_id=? AND state='completed'`, T, C);
  const onTime = completed.filter((c) => c.completed_at.slice(0, 10) <= c.due_date).length;
  const overdueOpen = n(`SELECT COUNT(*) n FROM followup_tasks WHERE tenant_id=? AND client_id=? AND state='overdue'`);
  const fuCommitment = n(`SELECT COUNT(*) n FROM followup_tasks WHERE tenant_id=? AND client_id=? AND basis='payer_commitment' AND state <> 'superseded'`);
  const fuAll = n(`SELECT COUNT(*) n FROM followup_tasks WHERE tenant_id=? AND client_id=? AND state <> 'superseded'`);

  const reconciledAccounts = n(`SELECT COUNT(DISTINCT account_id) n FROM outcome_ledger WHERE tenant_id=? AND client_id=? AND entry_type IN ('adjudication_changed','adjudication_unchanged','reversal','cash_posted')`);
  const reopened = n(`SELECT COUNT(DISTINCT account_id) n FROM audit_events WHERE tenant_id=? AND client_id=? AND event_type='account_reopened'`);
  const identityBlocked = n(`SELECT COUNT(DISTINCT account_id) n FROM analytics_events WHERE tenant_id=? AND client_id=? AND event_name='identity_blocked'`);

  const metrics: Metric[] = [
    { id: 'touches_per_account', label: 'Touches per worked account', unit: 'per_account', value: ratio(touches, touchRows.length), numerator: touches, denominator: touchRows.length,
      definition: 'Rule evaluations + payer interactions + review decisions, divided by accounts with at least one touch. Retries and re-runs are counted, not hidden.' },
    { id: 'review_burden', label: 'Review burden', unit: 'ratio', value: ratio(reviewed, proposals), numerator: reviewed, denominator: proposals,
      definition: 'Proposals that received a human decision / proposals generated (all financial and worklist proposals require review in this phase). Excludes note write-backs.' },
    { id: 'review_opened', label: 'Review panels opened', unit: 'count', value: reviewOpened, numerator: reviewOpened, denominator: null,
      definition: 'review_opened analytics events (a reviewer viewed a proposal awaiting review).' },
    { id: 'abstention_rate', label: 'Abstention rate', unit: 'ratio', value: ratio(abstained, runs), numerator: abstained, denominator: runs,
      definition: 'Rule runs that abstained (needs information, specialist review or identity block) / all rule runs. Abstention is a safety behaviour and is reported, never excluded.' },
    { id: 'time_to_proposal_median', label: 'Time to first proposal (median)', unit: 'minutes', value: pct(ttp, 50), numerator: null, denominator: ttp.length,
      definition: 'Minutes from account import to its first proposed action, median over accounts that have a proposal.' },
    { id: 'time_to_proposal_p90', label: 'Time to first proposal (p90)', unit: 'minutes', value: pct(ttp, 90), numerator: null, denominator: ttp.length, definition: 'As above, 90th percentile (nearest rank).' },
    { id: 'approval_latency_median', label: 'Approval latency (median)', unit: 'minutes', value: pct(finLatency, 50), numerator: null, denominator: finLatency.length,
      definition: 'Minutes from proposal creation to its approval decision, median over approved financial/worklist proposals.' },
    { id: 'dispatch_success', label: 'Dispatch success', unit: 'ratio', value: ratio(succeeded, attempted), numerator: succeeded, denominator: attempted,
      definition: 'Outbox rows with a recorded receipt (accepted or confirmed) / outbox rows dispatched at least once. A receipt is not payment.' },
    { id: 'uncertain_rate', label: 'Uncertain dispatch rate', unit: 'ratio', value: ratio(uncertainEvents, attempts), numerator: uncertainEvents, denominator: attempts,
      definition: 'dispatch_uncertain audit events / dispatch attempts. Each uncertain dispatch is reconciled by read-back before any retry.' },
    { id: 'followup_adherence', label: 'Follow-up adherence', unit: 'ratio', value: ratio(onTime, completed.length + overdueOpen), numerator: onTime, denominator: completed.length + overdueOpen,
      definition: 'Follow-ups completed on or before their due date / (completed follow-ups + follow-ups currently overdue).' },
    { id: 'followup_commitment_share', label: 'Follow-ups based on a payer commitment', unit: 'ratio', value: ratio(fuCommitment, fuAll), numerator: fuCommitment, denominator: fuAll,
      definition: 'Follow-ups whose date comes from a captured payer commitment / all active or completed follow-ups. The rest use the labelled internal review interval.' },
    { id: 'reopened_rate', label: 'Reopened rate', unit: 'ratio', value: ratio(reopened, reconciledAccounts), numerator: reopened, denominator: reconciledAccounts,
      definition: 'Accounts reopened by a contradictory outcome / accounts with at least one reconciled remittance or cash outcome.' },
    { id: 'identity_blocks', label: 'Identity blocks', unit: 'count', value: identityBlocked, numerator: identityBlocked, denominator: accounts,
      definition: 'Accounts stopped by the identity control. Identity errors are a zero-tolerance incident class; a block is the control working.' },
  ];

  const outcomes = all<{ entry_type: string; attribution: string; n: number; amount: number | null; delta: number | null }>(db,
    `SELECT entry_type, attribution, COUNT(*) n, SUM(amount_cents) amount, SUM(delta_cents) delta FROM outcome_ledger WHERE tenant_id=? AND client_id=? GROUP BY entry_type, attribution ORDER BY entry_type, attribution`, T, C)
    .map((r) => ({ entryType: r.entry_type, attribution: r.attribution, count: r.n, amountCents: r.amount, deltaCents: r.delta }));
  const events = all<{ event_name: string; n: number }>(db, 'SELECT event_name, COUNT(*) n FROM analytics_events WHERE tenant_id=? AND client_id=? GROUP BY event_name ORDER BY event_name', T, C)
    .map((r) => ({ event: r.event_name, count: r.n }));
  return {
    environment: 'synthetic', computedFor: { tenantId: T, clientId: C, accounts },
    notice: 'Computed from this synthetic environment\'s own activity. These are not accuracy, recovery or productivity results.',
    metrics, outcomesByType: outcomes, analyticsEvents: events,
  };
}

// ---------------------------------------------------------------- economics

let cached: EconomicsAssumptions | null = null;
export function baseAssumptions(): EconomicsAssumptions {
  cached ??= JSON.parse(readFileSync(new URL('../../evaluation/economics-assumptions.json', import.meta.url), 'utf8')) as EconomicsAssumptions;
  return cached;
}

export function economics(scope: Scope, overrides: Record<string, unknown> = {}) {
  requirePerm(scope, 'view');
  const base = { ...baseAssumptions() };
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in base)) throw invalid(`Unknown assumption: ${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw invalid(`${k} must be a non-negative number`);
    if (['review_share', 'resolution_rate', 'target_contribution_margin', 'utilization'].includes(k) && (v > 1 || (k !== 'review_share' && v === 0))) throw invalid(`${k} must be a fraction in (0, 1]`);
    (base as unknown as Record<string, number>)[k] = v;
  }
  return {
    disclaimer: ECONOMICS_DISCLAIMER,
    source: 'AR Resolution build pack: evaluation/economics-assumptions.json and evaluation/calculate.py (doc 14)',
    labels: ASSUMPTION_LABELS, assumptions: base,
    results: Object.fromEntries(Object.entries(variants(base)).map(([k, v]) => [k, { assumptions: v, result: calculate(v) }])),
  };
}
