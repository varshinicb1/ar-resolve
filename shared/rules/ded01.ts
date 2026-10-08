// DED01 deductible allocation review: the single deterministic rule engine.
// Used by the API/worker (server/services/rules.ts) and by the browser rule studio.
// This is a synthetic reconciliation check under stated plan assumptions,
// not a universal adjudication formula and not customer-approved policy.

export type Ded01Outcome =
  | 'collect_evidence'
  | 'specialist_review'
  | 'clarify_allocation'
  | 'verify_crossover'
  | 'secondary_review'
  | 'patient_responsibility_review'
  | 'monitor_secondary';

export interface Ded01Input {
  identityVerified?: unknown;
  planSupported?: unknown;
  eobVerified?: unknown;
  conflict?: unknown;
  allowedCents?: unknown;
  limitCents?: unknown;
  metBeforeCents?: unknown;
  appliedCents?: unknown;
  claimReference?: unknown;
  adjustmentGroup?: unknown;
  secondaryAtDos?: unknown;
  crossoverStatus?: unknown;
  postingVerified?: unknown;
}

export interface Ded01Calculation {
  formula: string;
  allowedCents: number;
  limitCents: number;
  metBeforeCents: number;
  remainingCents: number;
  expectedCents: number;
  appliedCents: number;
  differenceCents: number;
  assumption: string;
}

export interface Ded01Result {
  outcome: Ded01Outcome;
  abstained: boolean;
  reasonCodes: string[];
  missing: string[];
  calculation: Ded01Calculation | null;
}

export const DED01_REQUIRED: readonly (keyof Ded01Input)[] = [
  'identityVerified', 'planSupported', 'eobVerified', 'allowedCents', 'limitCents',
  'metBeforeCents', 'appliedCents', 'claimReference', 'adjustmentGroup', 'secondaryAtDos', 'crossoverStatus',
];

const AMOUNT_KEYS = ['allowedCents', 'limitCents', 'metBeforeCents', 'appliedCents'] as const;

export const SUPPORTED_PLAN_ASSUMPTION =
  'Single verified in-network individual deductible; accumulator measured before this claim at adjudication';

export function isAbstention(outcome: Ded01Outcome): boolean {
  return outcome === 'collect_evidence' || outcome === 'specialist_review';
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

function isCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function done(outcome: Ded01Outcome, reasonCodes: string[], missing: string[] = [], calculation: Ded01Calculation | null = null): Ded01Result {
  return { outcome, abstained: isAbstention(outcome), reasonCodes, missing, calculation };
}

export function evaluateDed01(f: Ded01Input): Ded01Result {
  // Identity failure and source conflicts outrank missing data: a conflicting fact
  // has no usable value, and it needs a specialist, not more collection.
  if (f.identityVerified === false) return done('collect_evidence', ['IDENTITY_NOT_VERIFIED'], ['identityVerified']);
  if (f.conflict) return done('specialist_review', ['SOURCE_CONFLICT']);
  const missing = DED01_REQUIRED.filter((k) => isBlank(f[k]));
  if (missing.length) return done('collect_evidence', ['REQUIRED_FACT_MISSING'], missing as string[]);
  if (f.identityVerified !== true) return done('collect_evidence', ['IDENTITY_NOT_VERIFIED'], ['identityVerified']);
  if (f.eobVerified !== true) return done('collect_evidence', ['EOB_NOT_VERIFIED'], ['eobVerified']);
  if (f.planSupported !== true) return done('specialist_review', ['PLAN_DESIGN_UNSUPPORTED']);
  if (f.adjustmentGroup !== 'PR') return done('specialist_review', ['ADJUSTMENT_GROUP_NOT_PR']);
  for (const k of AMOUNT_KEYS) {
    if (!isCents(f[k])) return done('specialist_review', ['AMOUNT_INVALID_OR_REVERSAL:' + k]);
  }
  const allowed = f.allowedCents as number;
  const limit = f.limitCents as number;
  const metBefore = f.metBeforeCents as number;
  const applied = f.appliedCents as number;
  const remaining = Math.max(0, limit - metBefore);
  const expected = Math.min(allowed, remaining);
  const calculation: Ded01Calculation = {
    formula: 'expected = min(allowed, max(0, limit - metBefore))',
    allowedCents: allowed, limitCents: limit, metBeforeCents: metBefore,
    remainingCents: remaining, expectedCents: expected, appliedCents: applied,
    differenceCents: applied - expected, assumption: SUPPORTED_PLAN_ASSUMPTION,
  };
  if (applied !== expected) return done('clarify_allocation', ['ALLOCATION_DIFFERS'], [], calculation);
  if (f.secondaryAtDos === 'unknown') return done('collect_evidence', ['ALLOCATION_CONSISTENT', 'SECONDARY_UNKNOWN'], ['secondaryAtDos'], calculation);
  if (f.secondaryAtDos === 'none') return done('patient_responsibility_review', ['ALLOCATION_CONSISTENT', 'NO_SECONDARY_AT_DOS'], [], calculation);
  if (f.secondaryAtDos !== 'active') return done('specialist_review', ['SECONDARY_STATUS_UNRECOGNIZED'], [], calculation);
  if (f.crossoverStatus === 'unknown') return done('verify_crossover', ['ALLOCATION_CONSISTENT', 'SECONDARY_ACTIVE', 'CROSSOVER_UNKNOWN'], [], calculation);
  if (f.crossoverStatus === 'crossed') return done('monitor_secondary', ['ALLOCATION_CONSISTENT', 'SECONDARY_ACTIVE', 'ALREADY_CROSSED'], [], calculation);
  if (f.postingVerified !== true) return done('collect_evidence', ['ALLOCATION_CONSISTENT', 'POSTING_NOT_VERIFIED'], ['postingVerified'], calculation);
  return done('secondary_review', ['ALLOCATION_CONSISTENT', 'SECONDARY_ACTIVE', 'NOT_CROSSED', 'POSTING_VERIFIED'], [], calculation);
}

export const OUTCOME_LABELS: Record<Ded01Outcome, string> = {
  collect_evidence: 'Evidence missing',
  specialist_review: 'Specialist review required',
  clarify_allocation: 'Request payer clarification of deductible allocation',
  verify_crossover: 'Verify crossover with payer',
  secondary_review: 'Stage secondary claim review',
  patient_responsibility_review: 'Review patient responsibility (no automatic billing)',
  monitor_secondary: 'Monitor secondary adjudication',
};

export const REASON_LABELS: Record<string, string> = {
  REQUIRED_FACT_MISSING: 'A required fact is missing or not usable',
  IDENTITY_NOT_VERIFIED: 'Claim identity is not verified',
  EOB_NOT_VERIFIED: 'No verified EOB/ERA adjudication evidence',
  PLAN_DESIGN_UNSUPPORTED: 'Plan design is outside the supported simple plan',
  SOURCE_CONFLICT: 'Sources disagree on a material fact',
  ADJUSTMENT_GROUP_NOT_PR: 'Adjustment group is not PR (patient responsibility)',
  ALLOCATION_DIFFERS: 'Applied deductible differs from the supported-plan expectation',
  ALLOCATION_CONSISTENT: 'Applied deductible matches the supported-plan expectation',
  SECONDARY_UNKNOWN: 'Secondary coverage at date of service is unknown',
  NO_SECONDARY_AT_DOS: 'No secondary coverage at date of service',
  SECONDARY_ACTIVE: 'Secondary coverage active at date of service',
  SECONDARY_STATUS_UNRECOGNIZED: 'Secondary coverage status is unrecognized',
  CROSSOVER_UNKNOWN: 'Crossover to secondary is not verified',
  ALREADY_CROSSED: 'Claim already crossed over to secondary',
  POSTING_NOT_VERIFIED: 'Posting in the PM system is not verified',
  NOT_CROSSED: 'Claim has not crossed over',
  POSTING_VERIFIED: 'Posting verified',
  RULE_SCOPE_MISMATCH: 'No compatible approved rule scope for this account',
};

export function reasonLabel(code: string): string {
  const [base, detail] = code.split(':');
  if (base === 'AMOUNT_INVALID_OR_REVERSAL') return `Amount ${detail} is malformed, fractional or negative (unsupported reversal)`;
  return REASON_LABELS[base] ?? code;
}
