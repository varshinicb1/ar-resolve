// DUP01: duplicate clarification (build pack docs/05 "Duplicate").
// Draft, synthetic. Hard stop: no blind resubmission of an identical claim.
// Claim frequency is carried as synthetic semantic values (original/replacement/void),
// not as X12 frequency codes, which this pack does not interpret.
import type { RuleDefinition } from '../catalog.ts';
import type { LogicModule } from '../types.ts';
import { conflictAmong, gate, isBlank, makeReasonLabel, readAll, result } from './common.ts';

export const DUP01_V1: RuleDefinition = {
  id: 'DUP01',
  version: 1,
  status: 'draft',
  logicModule: 'dup01.v1',
  scope: { tenant: '*', client: '*', payer: 'demo-payer', plan: '*', claimType: 'professional' },
  effectiveFrom: '2026-01-01',
  effectiveThrough: '2026-12-31',
  owner: 'Business reviewer to be assigned',
  supportedAssumptions: [
    'Original and corrected claims are distinct objects in the PM claim history',
    'Service-line comparison is done by the PM system and recorded as a fact',
  ],
  requiredFacts: [
    { key: 'identityVerified', label: 'Claim identity matches EOB', acceptedStatuses: ['verified'] },
    { key: 'claimReference', label: 'Payer claim reference', acceptedStatuses: ['verified'] },
    { key: 'originalClaimReference', label: 'Original claim the payer matched', acceptedStatuses: ['verified', 'reported'], optional: true },
    { key: 'claimFrequency', label: 'This claim is original / replacement / void', acceptedStatuses: ['verified'], optional: true },
    { key: 'linesMatchOriginal', label: 'Service lines identical to original', acceptedStatuses: ['verified'], optional: true },
    { key: 'originalDisposition', label: 'Disposition of the original claim', acceptedStatuses: ['verified', 'reported'], optional: true },
  ],
  actions: [
    { kind: 'collect_evidence', risk: 'abstain', connector: null, approveLabel: null },
    { kind: 'specialist_review', risk: 'abstain', connector: null, approveLabel: null },
    { kind: 'clarify_duplicate', risk: 'information_request', connector: 'sim_payer', approveLabel: 'Approve duplicate clarification inquiry' },
    { kind: 'request_duplicate_review', risk: 'reprocessing_request', connector: 'sim_payer', approveLabel: 'Approve duplicate reconsideration request' },
    { kind: 'review_existing_disposition', risk: 'internal_work_item', connector: 'internal_worklist', approveLabel: 'Approve disposition review task' },
  ],
  prohibitedActions: ['claim_resubmission', 'automatic_writeoff', 'automatic_code_change', 'automatic_patient_billing'],
  sources: ['Build pack docs/05 Duplicate playbook', 'Build pack docs/04 (original, corrected claim and appeal are distinct objects)', 'X12 CARC list (S08) for routing codes only', 'Client policy pending'],
  followUpBusinessDays: null,
  followUpSource: 'Payer commitment captured in evidence; no assumed turnaround',
  hardStops: ['No blind resubmission of an identical claim', 'A replacement identical to its original goes to a specialist'],
  noteTemplate: ['Original and current claim references', 'Frequency and line comparison', 'Original disposition', 'Remaining unknowns'],
};

const FREQUENCIES = ['original', 'replacement'];
const DISPOSITIONS = ['paid', 'denied', 'pending'];

const REASONS: Record<string, string> = {
  ORIGINAL_CLAIM_UNKNOWN: 'The claim the payer matched as the original is not identified',
  ORIGINAL_EQUALS_CURRENT: 'Original reference equals this claim (data issue)',
  VOID_CLAIM: 'This claim is a void; specialist handling required',
  FREQUENCY_UNRECOGNIZED: 'Claim frequency value is not recognized',
  ORIGINAL_DISPOSITION_UNKNOWN: 'Disposition of the original claim is unknown',
  ORIGINAL_NOT_FOUND_AT_PAYER: 'Payer could not find the original claim',
  DISPOSITION_UNRECOGNIZED: 'Original disposition value is not recognized',
  LINE_COMPARISON_MISSING: 'Line comparison with the original is not on file',
  CORRECTED_CLAIM_DENIED_AS_DUPLICATE: 'A replacement claim was denied as a duplicate of its original',
  REPLACEMENT_IDENTICAL_TO_ORIGINAL: 'Replacement claim lines are identical to the original',
  EXACT_DUPLICATE_OF_ORIGINAL: 'This claim duplicates the original; work the original instead',
  SERVICES_DIFFER_FROM_ORIGINAL: 'Service lines differ from the original: clarify with the payer',
  ORIGINAL_PAID: 'Original claim was paid',
  ORIGINAL_DENIED: 'Original claim was denied',
  ORIGINAL_PENDING: 'Original claim is pending',
};

export const dup01Module: LogicModule = {
  id: 'dup01.v1',
  ruleId: 'DUP01',
  title: 'Duplicate clarification',
  kind: 'executable',
  summary: 'Identifies the original claim and its disposition, asks the payer to process a true replacement, and never resubmits an identical claim.',
  outcomeLabels: {
    collect_evidence: 'Evidence missing',
    specialist_review: 'Specialist review required',
    clarify_duplicate: 'Clarify the duplicate relationship with the payer',
    request_duplicate_review: 'Ask payer to process the replacement claim',
    review_existing_disposition: 'Review the original claim disposition (worklist)',
  },
  reasonLabel: makeReasonLabel(REASONS),
  paramSpecs: [],
  branches: [
    { when: 'Identity, frequency or line comparison unavailable', propose: 'collect_evidence' },
    { when: 'Conflict, void, unrecognized values, self-reference or replacement identical to original', propose: 'specialist_review' },
    { when: 'Original unknown, original disposition unknown or not found, or services differ', propose: 'clarify_duplicate' },
    { when: 'Replacement with changed lines denied as duplicate', propose: 'request_duplicate_review' },
    { when: 'Exact duplicate of a paid, denied or pending original', propose: 'review_existing_disposition' },
  ],
  hardStops: DUP01_V1.hardStops!,
  noteFacts: [
    ['identityVerified', 'Identity matches EOB', false], ['claimReference', 'This claim', false], ['originalClaimReference', 'Original claim', false],
    ['claimFrequency', 'Frequency', false], ['linesMatchOriginal', 'Lines identical to original', false], ['originalDisposition', 'Original disposition', false],
  ],
  baseline: DUP01_V1,
  fixtureFile: 'dup01-fixtures.json',
  mapInput(ctx) {
    const input = readAll(ctx);
    input.conflict = conflictAmong(ctx, ctx.def.requiredFacts.map((f) => f.key));
    return input;
  },
  evaluate(input) {
    const g = gate(input, ['identityVerified', 'claimReference']);
    if (g) return g;
    if (isBlank(input.originalClaimReference)) return result('clarify_duplicate', ['ORIGINAL_CLAIM_UNKNOWN']);
    if (input.originalClaimReference === input.claimReference) return result('specialist_review', ['ORIGINAL_EQUALS_CURRENT']);
    if (isBlank(input.claimFrequency)) return result('collect_evidence', ['REQUIRED_FACT_MISSING'], ['claimFrequency']);
    if (input.claimFrequency === 'void') return result('specialist_review', ['VOID_CLAIM']);
    if (!FREQUENCIES.includes(input.claimFrequency as string)) return result('specialist_review', ['FREQUENCY_UNRECOGNIZED']);
    const disp = input.originalDisposition;
    if (isBlank(disp) || disp === 'unknown') return result('clarify_duplicate', ['ORIGINAL_DISPOSITION_UNKNOWN']);
    if (disp === 'not_found') return result('clarify_duplicate', ['ORIGINAL_NOT_FOUND_AT_PAYER']);
    if (!DISPOSITIONS.includes(disp as string)) return result('specialist_review', ['DISPOSITION_UNRECOGNIZED']);
    if (typeof input.linesMatchOriginal !== 'boolean') return result('collect_evidence', ['LINE_COMPARISON_MISSING'], ['linesMatchOriginal']);
    const dispReason = `ORIGINAL_${String(disp).toUpperCase()}`;
    const calc = { claimReference: input.claimReference, originalClaimReference: input.originalClaimReference, frequency: input.claimFrequency, linesMatchOriginal: input.linesMatchOriginal, originalDisposition: disp };
    if (input.claimFrequency === 'replacement') {
      if (input.linesMatchOriginal) return result('specialist_review', ['REPLACEMENT_IDENTICAL_TO_ORIGINAL', dispReason], [], calc);
      return result('request_duplicate_review', ['CORRECTED_CLAIM_DENIED_AS_DUPLICATE', dispReason], [], calc);
    }
    if (input.linesMatchOriginal) return result('review_existing_disposition', ['EXACT_DUPLICATE_OF_ORIGINAL', dispReason], [], calc);
    return result('clarify_duplicate', ['SERVICES_DIFFER_FROM_ORIGINAL', dispReason], [], calc);
  },
  request(kind, a, r) {
    const c = (r.calculation ?? {}) as Record<string, unknown>;
    switch (kind) {
      case 'clarify_duplicate':
        return { summary: `Ask ${a.payer_id} which claim ${a.claim_reference} was matched against as a duplicate, that claim's disposition, and whether the services differ.` };
      case 'request_duplicate_review':
        return { summary: `Ask ${a.payer_id} to process ${a.claim_reference} as a replacement of ${String(c.originalClaimReference)} rather than a duplicate. No claim is resubmitted by this action.`,
          originalClaimReference: c.originalClaimReference };
      case 'review_existing_disposition':
        return { summary: `Create a worklist task to review the ${String(c.originalDisposition)} original ${String(c.originalClaimReference)} instead of ${a.claim_reference}. No write-off or resubmission.`,
          originalClaimReference: c.originalClaimReference, originalDisposition: c.originalDisposition };
      default:
        return { summary: kind };
    }
  },
  noteExtras: (def) => [`Follow-up basis: ${def.followUpSource}`],
};
