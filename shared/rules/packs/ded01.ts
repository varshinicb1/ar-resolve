// DED01 as a registered logic module. The engine itself is unchanged in
// shared/rules/ded01.ts; this adapter only moves the fact mapping, request text,
// note rows and calculation line that used to live in server/services.
import { DED01_V1 } from '../catalog.ts';
import { evaluateDed01, OUTCOME_LABELS, reasonLabel, type Ded01Input } from '../ded01.ts';
import type { LogicModule, RuleResult } from '../types.ts';

function fmt(c: unknown) {
  return typeof c === 'number' ? `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(c);
}

interface Calc { expectedCents: number; appliedCents: number; differenceCents: number; limitCents: number; metBeforeCents: number; allowedCents: number }

export const ded01Module: LogicModule = {
  id: 'ded01.v1',
  ruleId: 'DED01',
  title: 'Deductible allocation review',
  kind: 'executable',
  summary: 'Checks the applied deductible against a validated simple plan and proposes clarification, crossover or secondary/patient-responsibility review.',
  outcomeLabels: OUTCOME_LABELS,
  reasonLabel,
  paramSpecs: [],
  branches: [
    { when: 'Identity or required context unavailable', propose: 'collect_evidence' },
    { when: 'Unsupported plan, adjustment group not PR, malformed amount or source conflict', propose: 'specialist_review' },
    { when: 'Verified simple allocation differs', propose: 'clarify_allocation' },
    { when: 'Allocation matches and secondary active but crossover unknown', propose: 'verify_crossover' },
    { when: 'Allocation matches, secondary active and already crossed', propose: 'monitor_secondary' },
    { when: 'Allocation matches and secondary active, not crossed and posting verified', propose: 'secondary_review' },
    { when: 'Allocation matches and secondary none', propose: 'patient_responsibility_review' },
  ],
  hardStops: [
    'No automatic patient billing',
    'Malformed or negative amounts are never normalized into plausible values',
    'Unknown secondary coverage is not "no coverage"',
    'Out-of-network or multiple accumulators go to specialist review',
  ],
  noteFacts: [
    ['identityVerified', 'Identity matches EOB', false], ['planDesign', 'Plan design', false], ['adjustmentGroup', 'Adjustment group', false],
    ['allowedCents', 'Allowed (line 1)', true], ['appliedCents', 'Deductible applied (CARC 1)', true], ['limitCents', 'Deductible limit', true],
    ['metBeforeCents', 'Met before this claim', true], ['secondaryAtDos', 'Secondary at DOS', false], ['crossoverStatus', 'Crossover', false],
    ['postingVerified', 'PM posting matches EOB', false],
  ],
  baseline: DED01_V1,
  fixtureFile: 'deductible-fixtures.json',
  mapInput(ctx) {
    const { usable, fact, def } = ctx;
    const plan = usable('planDesign');
    const input: Ded01Input = {
      identityVerified: usable('identityVerified'),
      planSupported: plan === null ? null : plan === def.scope.plan,
      claimReference: usable('claimReference'),
      adjustmentGroup: usable('adjustmentGroup'),
      allowedCents: usable('allowedCents'),
      appliedCents: usable('appliedCents'),
      limitCents: usable('limitCents'),
      metBeforeCents: usable('metBeforeCents'),
      secondaryAtDos: usable('secondaryAtDos'),
      crossoverStatus: usable('crossoverStatus'),
      postingVerified: usable('postingVerified'),
    };
    const eobKeys = ['claimReference', 'adjustmentGroup', 'allowedCents', 'appliedCents'];
    input.eobVerified = eobKeys.every((k) => fact(k)?.status === 'verified') ? true : eobKeys.some((k) => fact(k)) ? false : null;
    input.conflict = ctx.allFacts().some((f) => f.status === 'conflicting');
    return input as Record<string, unknown>;
  },
  evaluate: (input) => evaluateDed01(input as Ded01Input) as RuleResult,
  request(kind, a, r) {
    const c = r.calculation as Calc | null;
    switch (kind) {
      case 'clarify_allocation':
        return { summary: `Ask ${a.payer_id} to explain the deductible allocation on ${a.claim_reference} line 1 and reprocess if it was applied in error.`,
          expectedDeductibleCents: c?.expectedCents, appliedDeductibleCents: c?.appliedCents, differenceCents: c?.differenceCents,
          limitCents: c?.limitCents, metBeforeCents: c?.metBeforeCents };
      case 'verify_crossover':
        return { summary: `Ask ${a.payer_id} whether ${a.claim_reference} crossed over to the secondary payer, and when.` };
      case 'secondary_review':
        return { summary: `Create a worklist task to review staging a secondary claim for ${a.claim_reference}. No claim is submitted by this action.` };
      case 'patient_responsibility_review':
        return { summary: `Create a worklist task to review patient responsibility for ${a.claim_reference} against client policy and billing protections. No patient bill is generated.` };
      case 'monitor_secondary':
        return { summary: `Create a follow-up task to monitor secondary adjudication for ${a.claim_reference}.` };
      default:
        return { summary: kind };
    }
  },
  calculationText(r) {
    const c = r.calculation as Calc | null;
    if (!c) return null;
    return `Calculation (supported-plan assumption): expected = min(${fmt(c.allowedCents)}, max(0, ${fmt(c.limitCents)} - ${fmt(c.metBeforeCents)})) = ${fmt(c.expectedCents)}; applied ${fmt(c.appliedCents)}; difference ${fmt(c.differenceCents)}.`;
  },
};
