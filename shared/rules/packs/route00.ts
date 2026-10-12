// ROUTE00: the pack that runs when scenario selection cannot pick exactly one
// runnable pack. It only abstains, with the selector's reasons, so every account
// still gets a recorded, versioned run.
import type { RuleDefinition } from '../catalog.ts';
import { selectionReasonLabel, SELECTION_REASON_LABELS, type SelectionReason } from '../select.ts';
import type { LogicModule } from '../types.ts';
import { makeReasonLabel, result } from './common.ts';

export const ROUTE00_V1: RuleDefinition = {
  id: 'ROUTE00',
  version: 1,
  status: 'draft',
  logicModule: 'route00.v1',
  scope: { tenant: '*', client: '*', payer: '*', plan: '*', claimType: '*' },
  effectiveFrom: '2026-01-01',
  effectiveThrough: '2026-12-31',
  owner: 'Business reviewer to be assigned',
  supportedAssumptions: ['Selection never guesses: no match or several matches abstain'],
  requiredFacts: [
    { key: 'lineAdjustments', label: 'Line adjustments (group, CARC)', acceptedStatuses: ['verified'], optional: true },
    { key: 'remarkCodes', label: 'Remark codes (RARC)', acceptedStatuses: ['verified'], optional: true },
    { key: 'claimStatus', label: 'Payer claim status', acceptedStatuses: ['verified'], optional: true },
  ],
  actions: [
    { kind: 'collect_evidence', risk: 'abstain', connector: null, approveLabel: null },
    { kind: 'specialist_review', risk: 'abstain', connector: null, approveLabel: null },
  ],
  prohibitedActions: ['claim_resubmission', 'automatic_writeoff', 'automatic_patient_billing', 'automatic_code_change'],
  sources: ['Build pack docs/03 FR05', 'Build pack docs/04 policy precedence (abstain on conflicting scopes)'],
  followUpBusinessDays: null,
  followUpSource: 'Not applicable: no action is proposed',
};

const SELECTION_STATUS_REASON: Record<string, string> = {
  no_evidence: 'NO_ADJUDICATION_OR_STATUS',
  ambiguous: 'MULTIPLE_SCENARIOS_MATCHED',
  unknown: 'NO_SCENARIO_MATCH',
  conflict: 'SIGNAL_CONFLICT',
  not_runnable: 'RULE_NOT_RUNNABLE',
};

export const route00Module: LogicModule = {
  id: 'route00.v1',
  ruleId: 'ROUTE00',
  title: 'Scenario not determined',
  kind: 'router',
  summary: 'Abstains with the selector reasons when no single runnable scenario pack applies.',
  outcomeLabels: { collect_evidence: 'Evidence missing', specialist_review: 'Specialist review required' },
  reasonLabel: makeReasonLabel(SELECTION_REASON_LABELS),
  paramSpecs: [],
  branches: [
    { when: 'No adjudication or status evidence and no usable inventory hint', propose: 'collect_evidence' },
    { when: 'Several scenarios match, none match, sources conflict, or the selected pack is not runnable', propose: 'specialist_review' },
  ],
  hardStops: ['Never pick a scenario by guessing among multiple matches'],
  noteFacts: [['lineAdjustments', 'Line adjustments', false], ['remarkCodes', 'Remark codes', false], ['claimStatus', 'Payer claim status', false]],
  baseline: ROUTE00_V1,
  fixtureFile: 'route00-fixtures.json',
  mapInput(ctx) {
    for (const rf of ctx.def.requiredFacts) ctx.usable(rf.key);
    const s = ctx.selection;
    return { selectionStatus: s?.status ?? null, candidates: s?.candidates ?? [], selectionReasons: (s?.reasons ?? []).map((r) => r.code), scenario: s?.scenario ?? null };
  },
  evaluate(input) {
    const status = input.selectionStatus;
    const extra = Array.isArray(input.selectionReasons) ? (input.selectionReasons as string[]).filter((c) => c in SELECTION_REASON_LABELS && c !== SELECTION_STATUS_REASON[String(status)]) : [];
    if (status === 'no_evidence') return result('collect_evidence', ['NO_ADJUDICATION_OR_STATUS', ...extra], ['eob_or_claim_status']);
    const code = SELECTION_STATUS_REASON[String(status)] ?? 'NO_SCENARIO_MATCH';
    const candidates = Array.isArray(input.candidates) ? input.candidates : [];
    return result('specialist_review', [code, ...extra], [], candidates.length ? { candidates } : null);
  },
  request: (kind) => ({ summary: kind }),
  noteExtras: () => [],
};

export function describeSelectionReasons(reasons: SelectionReason[]): string[] {
  return reasons.map(selectionReasonLabel);
}
