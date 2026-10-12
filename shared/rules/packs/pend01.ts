// PEND01: claim pending / status follow-up (build pack docs/05 "Pending status").
// Draft, synthetic. Electronic status first (docs/07, S13); follow-up dates come
// only from a payer commitment captured in evidence, never from assumed wait days.
import type { RuleDefinition } from '../catalog.ts';
import type { LogicModule } from '../types.ts';
import { conflictAmong, daysBetween, gate, isBlank, isIsoDate, makeReasonLabel, readAll, result } from './common.ts';

export const PEND01_V1: RuleDefinition = {
  id: 'PEND01',
  version: 1,
  status: 'draft',
  logicModule: 'pend01.v1',
  scope: { tenant: '*', client: '*', payer: 'demo-payer', plan: '*', claimType: 'professional' },
  effectiveFrom: '2026-01-01',
  effectiveThrough: '2026-12-31',
  owner: 'Business reviewer to be assigned',
  supportedAssumptions: [
    'A synthetic 276/277-style electronic status response is the first status source',
    'Status freshness threshold is a client-policy placeholder, not a payer turnaround time',
    'A follow-up date is set only from a payer commitment captured in evidence',
  ],
  requiredFacts: [
    { key: 'identityVerified', label: 'Claim identity matches status response', acceptedStatuses: ['verified'] },
    { key: 'claimReference', label: 'Payer claim reference', acceptedStatuses: ['verified'] },
    { key: 'claimStatus', label: 'Current payer claim status', acceptedStatuses: ['verified'] },
    { key: 'statusAsOf', label: 'Status response date', acceptedStatuses: ['verified'] },
    { key: 'payerReceivedDate', label: 'Payer receipt date', acceptedStatuses: ['verified'], optional: true },
    { key: 'lastActivityDate', label: 'Last payer activity', acceptedStatuses: ['verified', 'reported'], optional: true },
    { key: 'requestedInformation', label: 'Information the payer requested', acceptedStatuses: ['verified', 'reported'], optional: true },
    { key: 'payerCommitmentDate', label: 'Payer-committed follow-up date', acceptedStatuses: ['verified', 'reported'], optional: true },
  ],
  actions: [
    { kind: 'collect_evidence', risk: 'abstain', connector: null, approveLabel: null },
    { kind: 'specialist_review', risk: 'abstain', connector: null, approveLabel: null },
    { kind: 'request_status_update', risk: 'information_request', connector: 'sim_payer', approveLabel: 'Approve status inquiry' },
    { kind: 'clarify_pending_request', risk: 'information_request', connector: 'sim_payer', approveLabel: 'Approve request-details inquiry' },
    { kind: 'route_info_request', risk: 'internal_work_item', connector: 'internal_worklist', approveLabel: 'Approve information-request task' },
    { kind: 'schedule_followup', risk: 'internal_work_item', connector: 'internal_worklist', approveLabel: 'Approve follow-up task' },
  ],
  prohibitedActions: ['claim_resubmission', 'automatic_writeoff', 'automatic_patient_billing', 'assumed_wait_days_followup'],
  sources: ['Build pack docs/05 Pending status playbook', 'Build pack docs/07 status order (S13 CMS claim status request/response)', 'Client policy pending'],
  followUpBusinessDays: null,
  followUpSource: 'Payer commitment captured in evidence (verified, or reported with a call reference). No default wait days.',
  params: { statusMaxAgeDays: 14 },
  hardStops: ['No arbitrary wait-days assumption', 'No resubmission when the claim is not on file'],
  noteTemplate: ['Status source and date', 'Payer receipt date', 'Requested information', 'Payer commitment and follow-up basis', 'Remaining unknowns'],
};

const STATUSES = ['received_pending', 'pending_info_requested', 'finalized', 'not_on_file'];

const REASONS: Record<string, string> = {
  STATUS_UNRECOGNIZED: 'Payer status value is not recognized by this pack',
  STATUS_STALE: 'The status response is older than the client freshness threshold',
  STATUS_FINALIZED: 'Payer reports the claim finalized',
  ADJUDICATION_EVIDENCE_NEEDED: 'Obtain the EOB/ERA before any conclusion',
  CLAIM_NOT_ON_FILE: 'Payer has no record of the claim: verify submission proof; never resubmit blindly',
  INFO_REQUESTED: 'Payer requested information that is identified in evidence',
  INFO_REQUESTED_DETAILS_UNKNOWN: 'Payer requested information but the exact request is not on file',
  PENDING: 'Claim is pending with the payer',
  PAYER_RECEIPT_UNCONFIRMED: 'Payer receipt date is not verified',
  NO_PAYER_COMMITMENT: 'No payer commitment date on file',
  PAYER_COMMITMENT_ON_FILE: 'Payer committed to a follow-up date',
  COMMITMENT_DATE_PASSED: 'The payer-committed date has passed',
};

export const pend01Module: LogicModule = {
  id: 'pend01.v1',
  ruleId: 'PEND01',
  title: 'Claim pending / status follow-up',
  kind: 'executable',
  summary: 'Uses the electronic status response to ask for status or request details, route payer information requests, or schedule follow-up from a payer commitment.',
  outcomeLabels: {
    collect_evidence: 'Evidence missing',
    specialist_review: 'Specialist review required',
    request_status_update: 'Request current claim status from payer',
    clarify_pending_request: 'Ask payer exactly what information is needed',
    route_info_request: 'Route payer information request to worklist',
    schedule_followup: 'Schedule follow-up on payer-committed date',
  },
  reasonLabel: makeReasonLabel(REASONS),
  paramSpecs: [{ key: 'statusMaxAgeDays', label: 'Maximum status age', min: 1, max: 60, unit: 'calendar days',
    description: 'A status response older than this is refreshed before any other step. Client-policy placeholder; synthetic default.' }],
  branches: [
    { when: 'Identity or status response unavailable', propose: 'collect_evidence' },
    { when: 'Source conflict, unrecognized status, claim not on file or invalid date', propose: 'specialist_review' },
    { when: 'Status older than the freshness threshold', propose: 'request_status_update' },
    { when: 'Finalized but no EOB on file', propose: 'collect_evidence' },
    { when: 'Payer requested information, request not identified', propose: 'clarify_pending_request' },
    { when: 'Payer requested information, request identified', propose: 'route_info_request' },
    { when: 'Pending, receipt unconfirmed, or no future payer commitment', propose: 'request_status_update' },
    { when: 'Pending with a future payer-committed date', propose: 'schedule_followup' },
  ],
  hardStops: PEND01_V1.hardStops!,
  noteFacts: [
    ['identityVerified', 'Identity matches status response', false], ['claimStatus', 'Payer status', false], ['statusAsOf', 'Status as of', false],
    ['payerReceivedDate', 'Payer receipt date', false], ['lastActivityDate', 'Last payer activity', false],
    ['requestedInformation', 'Requested information', false], ['payerCommitmentDate', 'Payer-committed date', false],
  ],
  baseline: PEND01_V1,
  fixtureFile: 'pend01-fixtures.json',
  mapInput(ctx) {
    const input = readAll(ctx);
    input.conflict = conflictAmong(ctx, ctx.def.requiredFacts.map((f) => f.key));
    input.asOfDate = ctx.asOf;
    return input;
  },
  evaluate(input, params) {
    const g = gate(input, ['identityVerified', 'claimReference', 'claimStatus', 'statusAsOf', 'asOfDate']);
    if (g) return g;
    const status = input.claimStatus;
    if (typeof status !== 'string' || !STATUSES.includes(status)) return result('specialist_review', ['STATUS_UNRECOGNIZED']);
    const asOf = input.asOfDate as string;
    if (!isIsoDate(input.statusAsOf) || !isIsoDate(asOf) || input.statusAsOf > asOf) return result('specialist_review', ['DATE_INVALID:statusAsOf']);
    const maxAge = params.statusMaxAgeDays ?? 14;
    const age = daysBetween(input.statusAsOf, asOf);
    const calc: Record<string, unknown> = { asOfDate: asOf, statusAsOf: input.statusAsOf, statusAgeDays: age, maxAgeDays: maxAge };
    if (age > maxAge) return result('request_status_update', ['STATUS_STALE'], [], calc);
    if (status === 'finalized') return result('collect_evidence', ['STATUS_FINALIZED', 'ADJUDICATION_EVIDENCE_NEEDED'], ['eob'], calc);
    if (status === 'not_on_file') return result('specialist_review', ['CLAIM_NOT_ON_FILE'], [], calc);
    if (status === 'pending_info_requested') {
      if (isBlank(input.requestedInformation) || typeof input.requestedInformation !== 'string') return result('clarify_pending_request', ['INFO_REQUESTED_DETAILS_UNKNOWN'], [], calc);
      return result('route_info_request', ['INFO_REQUESTED'], [], calc);
    }
    // received_pending
    if (isBlank(input.payerReceivedDate)) return result('request_status_update', ['PENDING', 'PAYER_RECEIPT_UNCONFIRMED'], [], calc);
    if (!isIsoDate(input.payerReceivedDate) || input.payerReceivedDate > asOf) return result('specialist_review', ['DATE_INVALID:payerReceivedDate'], [], calc);
    const commitment = input.payerCommitmentDate;
    if (isBlank(commitment)) return result('request_status_update', ['PENDING', 'NO_PAYER_COMMITMENT'], [], calc);
    if (!isIsoDate(commitment)) return result('specialist_review', ['DATE_INVALID:payerCommitmentDate'], [], calc);
    if (commitment < asOf) return result('request_status_update', ['PENDING', 'COMMITMENT_DATE_PASSED'], [], { ...calc, payerCommitmentDate: commitment });
    return result('schedule_followup', ['PENDING', 'PAYER_COMMITMENT_ON_FILE'], [], { ...calc, followUpDate: commitment, followUpBasis: 'payer commitment in evidence' });
  },
  request(kind, a, r) {
    const c = (r.calculation ?? {}) as Record<string, unknown>;
    switch (kind) {
      case 'request_status_update':
        return { summary: `Ask ${a.payer_id} for the current status of ${a.claim_reference}, the payer receipt date, and any committed processing date with a reference.`,
          statusAsOf: c.statusAsOf ?? null, statusAgeDays: c.statusAgeDays ?? null };
      case 'clarify_pending_request':
        return { summary: `Ask ${a.payer_id} exactly which information is required to finish processing ${a.claim_reference}, where to send it and by when.` };
      case 'route_info_request':
        return { summary: `Create a worklist task to assemble the information ${a.payer_id} requested for ${a.claim_reference}. Nothing is sent to the payer by this action.` };
      case 'schedule_followup':
        return { summary: `Create a follow-up task for ${a.claim_reference} on ${String(c.followUpDate)}, the date the payer committed to.`, followUpDate: c.followUpDate, followUpBasis: c.followUpBasis };
      default:
        return { summary: kind };
    }
  },
  calculationText(r) {
    const c = r.calculation as Record<string, unknown> | null;
    if (!c) return null;
    return `Status age: ${String(c.statusAgeDays)} days as of ${String(c.asOfDate)} (threshold ${String(c.maxAgeDays)}).${c.followUpDate ? ` Follow-up date ${String(c.followUpDate)} from payer commitment.` : ''}`;
  },
  noteExtras: (def) => [`Follow-up basis: ${def.followUpSource}`],
};
