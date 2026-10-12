// Deterministic question plans (docs/05 deductible call flow, docs/06 "keep the
// question plan in typed memory"). A plan is generated from the account's
// missing, conflicting and unverified facts plus the scenario playbook. Each
// scenario registers a versioned builder in PLAYBOOKS; DED01 is the first.
import type { RequiredFact } from '../../../shared/rules/catalog.ts';
import type { FactRow } from '../facts.ts';

export type Expects = 'date' | 'money' | 'reference' | 'enum' | 'text' | 'commitment' | 'reconcile';
export type QuestionReason = 'playbook' | 'missing' | 'conflicting' | 'unverified' | 'playbook_confirmation' | 'playbook_action' | 'reconcile';
export type QuestionStatus = 'pending' | 'asked' | 'awaiting_read_back' | 'answered' | 'confirmed' | 'unconfirmed' | 'unknown' | 'refused'
  | 'skipped' | 'declined' | 'accepted' | 'found' | 'not_found';

export const TERMINAL_QUESTION: QuestionStatus[] = ['answered', 'confirmed', 'unconfirmed', 'unknown', 'refused', 'skipped', 'declined', 'accepted', 'found', 'not_found'];
export const ANSWERED_QUESTION: QuestionStatus[] = ['answered', 'confirmed', 'accepted', 'found', 'not_found', 'declined'];

export interface PlannedQuestion {
  id: string;
  label: string;
  prompt: string;
  followUp: string;
  expects: Expects;
  factKey: string | null;
  answerKey: string;
  readBack: boolean;
  reason: QuestionReason;
  why: string;
  purposeful: boolean;
  dependsOn: { questionId: string; status: QuestionStatus } | null;
  status: QuestionStatus;
  attempts: number;
  maxAttempts: number;
  readBackAttempts: number;
  note: string | null;
}

export interface QuestionPlan {
  planId: string;
  version: number;
  scenario: string;
  generatedAt: string;
  basis: { accountRevision: number; outcome: string | null; verbalReprocessingPreauthorized: boolean; priorUnreconciledCallId: string | null };
  questions: PlannedQuestion[];
  meta: {
    needsClaimClarification: boolean;
    claimClarifications: number;
    verbalAcceptance: { questionId: string; turnSeq: number } | null;
  };
  verification?: { answerKey: string; verdict: string; detail: string }[];
}

export interface PlanInputs {
  accountRevision: number;
  claimReference: string;
  serviceDate: string;
  facts: Map<string, FactRow>;
  requiredFacts: RequiredFact[];
  outcome: string | null;
  verbalReprocessingPreauthorized: boolean;
  priorUnreconciledCallId: string | null;
  priorRequestKnown: boolean;
  generatedAt: string;
}

type Template = Pick<PlannedQuestion, 'id' | 'label' | 'prompt' | 'followUp' | 'expects' | 'factKey' | 'answerKey' | 'readBack' | 'maxAttempts'>;

const DED01_TEMPLATES: Record<string, Template> = {
  reconcile_prior_request: { id: 'reconcile_prior_request', label: 'Reconcile the earlier request', expects: 'reconcile', factKey: null, answerKey: 'priorRequest', readBack: true, maxAttempts: 2,
    prompt: 'An earlier call about claim {claim} ended unexpectedly after a reprocessing request was discussed. Can you see whether a request was opened on this claim?',
    followUp: 'Could you check once more whether any reprocessing request exists on claim {claim}?' },
  claim_status: { id: 'claim_status', label: 'Claim status and processed date', expects: 'date', factKey: null, answerKey: 'processedDate', readBack: false, maxAttempts: 2,
    prompt: 'Can you confirm the status of claim {claim} and the date it was processed?', followUp: 'Sorry, what was the processed date for claim {claim}?' },
  allowed_amount: { id: 'allowed_amount', label: 'Allowed amount (line 1)', expects: 'money', factKey: 'allowedCents', answerKey: 'allowedCents', readBack: true, maxAttempts: 2,
    prompt: 'What was the allowed amount on line one of claim {claim}?', followUp: 'Could you repeat the allowed amount on line one?' },
  deductible_applied: { id: 'deductible_applied', label: 'Deductible applied (line 1)', expects: 'money', factKey: 'appliedCents', answerKey: 'appliedCents', readBack: true, maxAttempts: 2,
    prompt: 'How much was applied to the deductible on line one?', followUp: 'Could you repeat the amount applied to the deductible on line one?' },
  adjustment_group: { id: 'adjustment_group', label: 'Adjustment group', expects: 'enum', factKey: 'adjustmentGroup', answerKey: 'adjustmentGroup', readBack: false, maxAttempts: 2,
    prompt: 'Which adjustment group code was used for the deductible on that line?', followUp: 'Was that group code PR or CO?' },
  deductible_limit: { id: 'deductible_limit', label: 'Deductible limit and accumulator', expects: 'money', factKey: 'limitCents', answerKey: 'limitCents', readBack: true, maxAttempts: 2,
    prompt: 'Which plan year and accumulator were used for this claim, and what is the individual in-network deductible?', followUp: 'Could you repeat the individual in-network deductible amount?' },
  met_before_claim: { id: 'met_before_claim', label: 'Deductible met before this claim', expects: 'money', factKey: 'metBeforeCents', answerKey: 'metBeforeCents', readBack: true, maxAttempts: 2,
    prompt: 'How much of that deductible had been met before this claim was adjudicated? I need the amount before this claim, not today\'s total.',
    followUp: 'I need the amount that had been met before this claim was adjudicated, not the current total. Can you see that figure?' },
  crossover_status: { id: 'crossover_status', label: 'Crossover to secondary', expects: 'enum', factKey: 'crossoverStatus', answerKey: 'crossoverStatus', readBack: false, maxAttempts: 2,
    prompt: 'Has this claim crossed over to the secondary payer?', followUp: 'Can you see whether the claim was forwarded to the secondary payer?' },
  explain_allocation: { id: 'explain_allocation', label: 'Explanation of the allocation', expects: 'text', factKey: null, answerKey: 'allocationExplanation', readBack: false, maxAttempts: 1,
    prompt: 'Our records show the deductible may have been met before this claim, yet an amount was applied. Can you explain how the deductible was allocated on this line?', followUp: '' },
  request_reprocessing: { id: 'request_reprocessing', label: 'Request reprocessing (client pre-authorized)', expects: 'commitment', factKey: null, answerKey: 'reprocessingCommitment', readBack: false, maxAttempts: 1,
    prompt: 'Can you open a reprocessing request for line one of claim {claim} so the deductible allocation is reviewed?', followUp: '' },
  request_reference: { id: 'request_reference', label: 'Request reference number', expects: 'reference', factKey: null, answerKey: 'requestReference', readBack: true, maxAttempts: 2,
    prompt: 'What is the reference number for that request?', followUp: 'Is there a request number I can note?' },
  call_reference: { id: 'call_reference', label: 'Call reference', expects: 'reference', factKey: null, answerKey: 'callReference', readBack: true, maxAttempts: 2,
    prompt: 'Before we finish, may I have a reference number for this call?', followUp: 'Is there any reference number for this call I can note?' },
};

const FACT_QUESTIONS: [string, string][] = [
  ['allowedCents', 'allowed_amount'], ['appliedCents', 'deductible_applied'], ['adjustmentGroup', 'adjustment_group'],
  ['limitCents', 'deductible_limit'], ['metBeforeCents', 'met_before_claim'], ['crossoverStatus', 'crossover_status'],
];

// Outcomes where the playbook confirms the accumulator by phone before a
// patient-responsibility review or an allocation clarification proceeds.
const CONFIRM_ON_OUTCOME: Record<string, string[]> = {
  patient_responsibility_review: ['metBeforeCents'],
  clarify_allocation: ['metBeforeCents'],
};

function q(t: Template, reason: QuestionReason, why: string, dependsOn: PlannedQuestion['dependsOn'] = null): PlannedQuestion {
  return { ...t, reason, why, purposeful: reason !== 'playbook', dependsOn, status: 'pending', attempts: 0, readBackAttempts: 0, note: null };
}

function buildDed01(i: PlanInputs): PlannedQuestion[] {
  const out: PlannedQuestion[] = [];
  const T = DED01_TEMPLATES;
  if (i.priorUnreconciledCallId) out.push(q(T.reconcile_prior_request, 'reconcile', `Call ${i.priorUnreconciledCallId} dropped after an apparent acceptance; reconcile before any new request`));
  out.push(q(T.claim_status, 'playbook', 'Playbook: confirm claim status and processed date for the intended claim'));
  const asked = new Set<string>();
  for (const [factKey, qid] of FACT_QUESTIONS) {
    const f = i.facts.get(factKey);
    const status = f?.status ?? 'missing';
    const accepted = i.requiredFacts.find((r) => r.key === factKey)?.acceptedStatuses ?? ['verified'];
    if (factKey === 'crossoverStatus' && i.facts.get('secondaryAtDos')?.value === 'none') continue;
    if (!accepted.includes(status)) {
      const reason: QuestionReason = status === 'missing' ? 'missing' : status === 'conflicting' ? 'conflicting' : 'unverified';
      out.push(q(T[qid], reason, `${factKey} is ${status}; the rule accepts ${accepted.join(' or ')}`));
      asked.add(factKey);
    } else if ((CONFIRM_ON_OUTCOME[i.outcome ?? ''] ?? []).includes(factKey) && !(f?.candidates ?? []).some((c) => c.sourceClass === 'transcript')) {
      out.push(q(T[qid], 'playbook_confirmation', `Proposed next step ${i.outcome} depends on ${factKey}; playbook asks for the amount met before this claim at adjudication`));
      asked.add(factKey);
    }
  }
  if (i.outcome === 'clarify_allocation') {
    out.push(q(T.explain_allocation, 'playbook_action', 'Evidence supports a possible inconsistency; playbook asks the representative to explain the allocation'));
    if (i.verbalReprocessingPreauthorized && !i.priorRequestKnown) {
      const dep = i.priorUnreconciledCallId ? { questionId: 'reconcile_prior_request', status: 'not_found' as QuestionStatus } : null;
      out.push(q(T.request_reprocessing, 'playbook_action', 'Client policy pre-authorizes a verbal reprocessing request for this outcome', dep));
      out.push(q(T.request_reference, 'playbook', 'Record the request reference if a request is accepted', { questionId: 'request_reprocessing', status: 'accepted' }));
    }
  }
  out.push(q(T.call_reference, 'playbook', 'Playbook: capture the call reference before closing; never fabricate one'));
  return out;
}

export interface Playbook { scenario: string; planId: string; version: number; build: (i: PlanInputs) => PlannedQuestion[] }

export const PLAYBOOKS: Record<string, Playbook> = {
  DED01: { scenario: 'DED01', planId: 'DED01-call', version: 1, build: buildDed01 },
};

export function scenarioFor(accountScenario: string): string | null {
  return accountScenario === 'deductible' ? 'DED01' : null;
}

export function buildPlan(scenario: string, i: PlanInputs): QuestionPlan {
  const pb = PLAYBOOKS[scenario];
  if (!pb) throw new Error(`No call playbook for scenario ${scenario}`);
  return {
    planId: pb.planId, version: pb.version, scenario, generatedAt: i.generatedAt,
    basis: { accountRevision: i.accountRevision, outcome: i.outcome, verbalReprocessingPreauthorized: i.verbalReprocessingPreauthorized, priorUnreconciledCallId: i.priorUnreconciledCallId },
    questions: pb.build(i),
    meta: { needsClaimClarification: false, claimClarifications: 0, verbalAcceptance: null },
  };
}

export function promptFor(qn: PlannedQuestion, claim: string): string {
  return (qn.attempts > 0 && qn.followUp ? qn.followUp : qn.prompt).replaceAll('{claim}', claim);
}

// Next askable question: pending, with its dependency satisfied. A dependency
// that resolved to anything else skips the question.
export function nextQuestion(plan: QuestionPlan): PlannedQuestion | null {
  for (const qn of plan.questions) {
    if (qn.status !== 'pending') continue;
    if (qn.dependsOn) {
      const dep = plan.questions.find((d) => d.id === qn.dependsOn!.questionId);
      if (dep && TERMINAL_QUESTION.includes(dep.status) && dep.status !== qn.dependsOn.status) { qn.status = 'skipped'; qn.note = `Skipped: ${dep.id} was ${dep.status}`; continue; }
      if (dep && !TERMINAL_QUESTION.includes(dep.status)) continue;
    }
    return qn;
  }
  return null;
}

export function callNeeded(plan: QuestionPlan): boolean {
  return plan.questions.some((qn) => qn.purposeful);
}
