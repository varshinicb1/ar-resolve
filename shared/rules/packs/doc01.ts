// DOC01: missing documentation (build pack docs/05 "Missing documentation").
// Draft, synthetic. Hard stops: wrong-patient document, unsupported release,
// blind re-sending when a prior submission receipt exists.
import type { RuleDefinition } from '../catalog.ts';
import type { LogicModule } from '../types.ts';
import { conflictAmong, gate, isBlank, makeReasonLabel, normalizeLabel, readAll, result } from './common.ts';

export const DOC01_V1: RuleDefinition = {
  id: 'DOC01',
  version: 1,
  status: 'draft',
  logicModule: 'doc01.v1',
  scope: { tenant: '*', client: '*', payer: 'demo-payer', plan: '*', claimType: 'professional' },
  effectiveFrom: '2026-01-01',
  effectiveThrough: '2026-12-31',
  owner: 'Business reviewer to be assigned',
  supportedAssumptions: [
    'The exact payer request (letter, remark or representative statement) identifies the document',
    'The staged attachment manifest names the patient token and claim it was pulled for',
    'Release of records is permitted only when the client record set says so',
  ],
  requiredFacts: [
    { key: 'identityVerified', label: 'Claim identity matches EOB', acceptedStatuses: ['verified'] },
    { key: 'claimReference', label: 'Payer claim reference', acceptedStatuses: ['verified'] },
    { key: 'remarkCodes', label: 'Remark codes on the EOB', acceptedStatuses: ['verified'], optional: true },
    { key: 'requestedDocument', label: 'Document the payer requested', acceptedStatuses: ['verified', 'reported'], optional: true },
    { key: 'requestReference', label: 'Payer request reference', acceptedStatuses: ['verified', 'reported'], optional: true },
    { key: 'submissionDestination', label: 'Verified submission destination', acceptedStatuses: ['verified'], optional: true },
    { key: 'priorSubmission', label: 'Prior upload/fax receipt', acceptedStatuses: ['verified'], optional: true },
    { key: 'attachmentPatientToken', label: 'Staged attachment patient token', acceptedStatuses: ['verified'], optional: true },
    { key: 'attachmentClaimReference', label: 'Staged attachment claim reference', acceptedStatuses: ['verified'], optional: true },
    { key: 'attachmentDocumentType', label: 'Staged attachment document type', acceptedStatuses: ['verified'], optional: true },
    { key: 'releaseAuthorized', label: 'Release of these records authorized', acceptedStatuses: ['verified'], optional: true },
  ],
  actions: [
    { kind: 'collect_evidence', risk: 'abstain', connector: null, approveLabel: null },
    { kind: 'specialist_review', risk: 'abstain', connector: null, approveLabel: null },
    { kind: 'clarify_document_request', risk: 'information_request', connector: 'sim_payer', approveLabel: 'Approve document-request inquiry' },
    { kind: 'verify_document_receipt', risk: 'information_request', connector: 'sim_payer', approveLabel: 'Approve receipt verification inquiry' },
    { kind: 'assemble_documents', risk: 'internal_work_item', connector: 'internal_worklist', approveLabel: 'Approve records-assembly task' },
    { kind: 'submit_documents', risk: 'document_submission', connector: 'sim_payer', approveLabel: 'Approve document submission' },
  ],
  prohibitedActions: ['claim_resubmission', 'automatic_writeoff', 'release_unrequested_records', 'automatic_code_change'],
  sources: ['Build pack docs/05 Missing documentation playbook', 'X12 CARC list (S08) for routing codes only', 'Client policy pending'],
  followUpBusinessDays: null,
  followUpSource: 'Payer receipt confirmation of the submission; no assumed turnaround',
  hardStops: ['Wrong-patient or wrong-claim document', 'Release not authorized by the client record set', 'Re-sending when a prior receipt exists'],
  noteTemplate: ['Exact request and reference', 'Document staged and manifest check', 'Destination', 'Prior submission receipt', 'Remaining unknowns'],
};

const REASONS: Record<string, string> = {
  REQUEST_DETAILS_UNKNOWN: 'The exact document request is not on file',
  REMARK_CODES_ON_FILE: 'Remark codes are on the EOB (code meaning is not interpreted by this pack)',
  PRIOR_SUBMISSION_UNKNOWN: 'Whether documents were already sent is unknown',
  PRIOR_SUBMISSION_ON_FILE: 'A prior submission receipt exists: confirm receipt instead of re-sending',
  PRIOR_SUBMISSION_UNRECOGNIZED: 'Prior submission value is not recognized',
  DESTINATION_UNVERIFIED: 'Submission destination is not verified',
  ATTACHMENT_NOT_STAGED: 'The requested document has not been staged',
  WRONG_PATIENT_DOCUMENT: 'Staged document does not match this patient and claim (hard stop)',
  ATTACHMENT_MANIFEST_INCOMPLETE: 'The attachment manifest does not name both patient token and claim',
  ATTACHMENT_TYPE_MISMATCH: 'Staged document type does not match the exact request',
  RELEASE_NOT_AUTHORIZED: 'Release of these records is not authorized (hard stop)',
  RELEASE_AUTHORIZATION_UNKNOWN: 'Release authorization is not on file',
  ATTACHMENT_VERIFIED: 'Attachment manifest matches patient, claim and request',
  RELEASE_AUTHORIZED: 'Release authorized by the client record set',
  NO_PRIOR_SUBMISSION: 'No prior submission on file',
};

export const doc01Module: LogicModule = {
  id: 'doc01.v1',
  ruleId: 'DOC01',
  title: 'Missing documentation',
  kind: 'executable',
  summary: 'Clarifies the exact request, avoids duplicate sends, and stages a verified attachment manifest for human-approved submission.',
  outcomeLabels: {
    collect_evidence: 'Evidence missing',
    specialist_review: 'Specialist review required',
    clarify_document_request: 'Ask payer which document is required',
    verify_document_receipt: 'Confirm payer received the earlier submission',
    assemble_documents: 'Assemble the requested records (worklist)',
    submit_documents: 'Submit verified attachment to payer',
  },
  reasonLabel: makeReasonLabel(REASONS),
  paramSpecs: [],
  branches: [
    { when: 'Identity unavailable, prior submission unknown, destination unverified or release authorization unknown', propose: 'collect_evidence' },
    { when: 'Source conflict, wrong-patient document, type mismatch or release not authorized', propose: 'specialist_review' },
    { when: 'Exact request not on file', propose: 'clarify_document_request' },
    { when: 'Prior submission receipt on file', propose: 'verify_document_receipt' },
    { when: 'Request known, nothing staged yet', propose: 'assemble_documents' },
    { when: 'Manifest matches patient, claim and request; release authorized; no prior submission', propose: 'submit_documents' },
  ],
  hardStops: DOC01_V1.hardStops!,
  noteFacts: [
    ['identityVerified', 'Identity matches EOB', false], ['remarkCodes', 'Remark codes', false], ['requestedDocument', 'Requested document', false],
    ['requestReference', 'Request reference', false], ['submissionDestination', 'Destination', false], ['priorSubmission', 'Prior submission', false],
    ['attachmentDocumentType', 'Staged document type', false], ['releaseAuthorized', 'Release authorized', false],
  ],
  baseline: DOC01_V1,
  fixtureFile: 'doc01-fixtures.json',
  mapInput(ctx) {
    const input = readAll(ctx);
    const token = input.attachmentPatientToken;
    const claim = input.attachmentClaimReference;
    input.attachmentIdentityMatch = isBlank(token) && isBlank(claim) ? null
      : isBlank(token) || isBlank(claim) ? 'incomplete'
      : token === ctx.account.patient_token && claim === ctx.account.claim_reference;
    input.conflict = conflictAmong(ctx, ctx.def.requiredFacts.map((f) => f.key));
    return input;
  },
  evaluate(input) {
    const g = gate(input, ['identityVerified', 'claimReference']);
    if (g) return g;
    const remarks = Array.isArray(input.remarkCodes) && input.remarkCodes.length ? ['REMARK_CODES_ON_FILE'] : [];
    if (isBlank(input.requestedDocument) || typeof input.requestedDocument !== 'string') return result('clarify_document_request', ['REQUEST_DETAILS_UNKNOWN', ...remarks]);
    const prior = input.priorSubmission;
    if (isBlank(prior) || prior === 'unknown') return result('collect_evidence', ['PRIOR_SUBMISSION_UNKNOWN'], ['priorSubmission']);
    if (prior === 'receipt_on_file') return result('verify_document_receipt', ['PRIOR_SUBMISSION_ON_FILE']);
    if (prior !== 'none') return result('specialist_review', ['PRIOR_SUBMISSION_UNRECOGNIZED']);
    if (isBlank(input.submissionDestination)) return result('collect_evidence', ['DESTINATION_UNVERIFIED'], ['submissionDestination']);
    if (input.attachmentIdentityMatch === null || input.attachmentIdentityMatch === undefined) return result('assemble_documents', ['ATTACHMENT_NOT_STAGED']);
    if (input.attachmentIdentityMatch === 'incomplete') return result('collect_evidence', ['ATTACHMENT_MANIFEST_INCOMPLETE'], [isBlank(input.attachmentPatientToken) ? 'attachmentPatientToken' : 'attachmentClaimReference']);
    if (input.attachmentIdentityMatch !== true) return result('specialist_review', ['WRONG_PATIENT_DOCUMENT']);
    if (!normalizeLabel(input.attachmentDocumentType) || normalizeLabel(input.attachmentDocumentType) !== normalizeLabel(input.requestedDocument)) {
      return result('specialist_review', ['ATTACHMENT_TYPE_MISMATCH']);
    }
    if (input.releaseAuthorized === false) return result('specialist_review', ['RELEASE_NOT_AUTHORIZED']);
    if (input.releaseAuthorized !== true) return result('collect_evidence', ['RELEASE_AUTHORIZATION_UNKNOWN'], ['releaseAuthorized']);
    return result('submit_documents', ['ATTACHMENT_VERIFIED', 'RELEASE_AUTHORIZED', 'NO_PRIOR_SUBMISSION'], [], {
      requestedDocument: input.requestedDocument, attachmentDocumentType: input.attachmentDocumentType, destination: input.submissionDestination,
    });
  },
  request(kind, a, r) {
    const c = (r.calculation ?? {}) as Record<string, unknown>;
    switch (kind) {
      case 'clarify_document_request':
        return { summary: `Ask ${a.payer_id} exactly which document is required for ${a.claim_reference}, the request reference and the approved destination.` };
      case 'verify_document_receipt':
        return { summary: `Ask ${a.payer_id} to confirm receipt of the documents already sent for ${a.claim_reference}. Nothing is re-sent by this action.` };
      case 'assemble_documents':
        return { summary: `Create a worklist task to pull the requested records for ${a.claim_reference} and stage them with a manifest. Nothing is sent by this action.` };
      case 'submit_documents':
        return { summary: `Submit the staged ${String(c.attachmentDocumentType)} for ${a.claim_reference} to ${String(c.destination)} (simulated). Manifest matched patient, claim and request.`,
          attachment: { documentType: c.attachmentDocumentType, requested: c.requestedDocument, destination: c.destination } };
      default:
        return { summary: kind };
    }
  },
  noteExtras: (def) => [`Follow-up basis: ${def.followUpSource}`],
};
