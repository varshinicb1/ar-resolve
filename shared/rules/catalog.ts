// Versioned rule definitions as data. Branch logic is a reviewed deterministic
// function (logicModule) — rule editors never supply executable strings.
import type { Ded01Outcome } from './ded01.ts';

export type FactStatus = 'verified' | 'reported' | 'inferred' | 'missing' | 'conflicting' | 'stale';

export interface RequiredFact {
  key: string;
  label: string;
  acceptedStatuses: FactStatus[];
}

export type RiskClass = 'internal_work_item' | 'information_request' | 'reprocessing_request';

export interface ActionSpec {
  kind: Ded01Outcome;
  risk: RiskClass | 'abstain';
  connector: 'sim_payer' | 'internal_worklist' | null;
  approveLabel: string | null;
}

export interface RuleDefinition {
  id: string;
  version: number;
  status: 'draft' | 'approved' | 'retired';
  logicModule: 'ded01.v1';
  scope: { tenant: string; client: string; payer: string; plan: string; claimType: string };
  effectiveFrom: string;
  effectiveThrough: string;
  owner: string;
  supportedAssumptions: string[];
  requiredFacts: RequiredFact[];
  actions: ActionSpec[];
  prohibitedActions: string[];
  sources: string[];
  followUpBusinessDays: number | null;
  followUpSource: string;
}

export const DED01_V1: RuleDefinition = {
  id: 'DED01',
  version: 1,
  status: 'draft',
  logicModule: 'ded01.v1',
  scope: { tenant: '*', client: '*', payer: 'demo-payer', plan: 'simple-in-network-individual', claimType: 'professional' },
  effectiveFrom: '2026-01-01',
  effectiveThrough: '2026-12-31',
  owner: 'Business reviewer to be assigned',
  supportedAssumptions: [
    'Single verified in-network individual deductible',
    'Accumulator measured before this claim at relevant adjudication',
    'No reversal or multiple accumulator context',
  ],
  requiredFacts: [
    { key: 'identityVerified', label: 'Claim identity matches source', acceptedStatuses: ['verified'] },
    { key: 'planDesign', label: 'Plan design', acceptedStatuses: ['verified'] },
    { key: 'claimReference', label: 'Payer claim reference', acceptedStatuses: ['verified'] },
    { key: 'adjustmentGroup', label: 'Adjustment group', acceptedStatuses: ['verified'] },
    { key: 'allowedCents', label: 'Allowed amount', acceptedStatuses: ['verified'] },
    { key: 'appliedCents', label: 'Deductible applied', acceptedStatuses: ['verified'] },
    { key: 'limitCents', label: 'Deductible limit', acceptedStatuses: ['verified', 'reported'] },
    { key: 'metBeforeCents', label: 'Deductible met before this claim', acceptedStatuses: ['verified', 'reported'] },
    { key: 'secondaryAtDos', label: 'Secondary coverage at DOS', acceptedStatuses: ['verified', 'reported'] },
    { key: 'crossoverStatus', label: 'Crossover status', acceptedStatuses: ['verified', 'reported'] },
    { key: 'postingVerified', label: 'PM posting matches EOB', acceptedStatuses: ['verified'] },
  ],
  actions: [
    { kind: 'collect_evidence', risk: 'abstain', connector: null, approveLabel: null },
    { kind: 'specialist_review', risk: 'abstain', connector: null, approveLabel: null },
    { kind: 'clarify_allocation', risk: 'reprocessing_request', connector: 'sim_payer', approveLabel: 'Approve clarification request' },
    { kind: 'verify_crossover', risk: 'information_request', connector: 'sim_payer', approveLabel: 'Approve crossover inquiry' },
    { kind: 'secondary_review', risk: 'internal_work_item', connector: 'internal_worklist', approveLabel: 'Approve secondary review task' },
    { kind: 'patient_responsibility_review', risk: 'internal_work_item', connector: 'internal_worklist', approveLabel: 'Approve patient responsibility review task' },
    { kind: 'monitor_secondary', risk: 'internal_work_item', connector: 'internal_worklist', approveLabel: 'Approve monitoring task' },
  ],
  prohibitedActions: ['automatic_patient_billing', 'automatic_writeoff', 'automatic_code_change', 'claim_resubmission'],
  sources: ['S07 educational deductible call reference', 'S08 X12 CARC list', 'Client policy pending'],
  followUpBusinessDays: null,
  followUpSource: 'No verified payer turnaround; follow-up date comes only from a payer commitment captured in evidence',
};

export function actionSpec(rule: RuleDefinition, kind: string): ActionSpec | undefined {
  return rule.actions.find((a) => a.kind === kind);
}
