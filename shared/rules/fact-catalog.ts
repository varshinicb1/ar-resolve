// Fact keys added for the scenario packs after DED01, with their value types and
// the typed source paths they are extracted from. Extraction reads only these
// fixed paths; free text inside a source is a value, never an instruction.
//
// These keys are "sparse": a fact row is written only once some source has
// observed the key, so accounts that never see them (all DED01 accounts) keep
// exactly the Phase 0 fact set.

export type FactType =
  | { kind: 'enum'; values: (string | boolean)[] }
  | { kind: 'string' }
  | { kind: 'date' }
  | { kind: 'boolean' }
  | { kind: 'string_list' }
  | { kind: 'adjustments' };

export interface ExtendedFact { key: string; label: string; type: FactType; correctable: boolean }

const e = (values: (string | boolean)[]): FactType => ({ kind: 'enum', values });
const S: FactType = { kind: 'string' };
const D: FactType = { kind: 'date' };
const B: FactType = { kind: 'boolean' };

export const EXTENDED_FACTS: ExtendedFact[] = [
  { key: 'lineAdjustments', label: 'Line adjustments (group, CARC)', type: { kind: 'adjustments' }, correctable: false },
  { key: 'remarkCodes', label: 'Remark codes (RARC)', type: { kind: 'string_list' }, correctable: false },
  // claim status (synthetic 276/277-style response)
  { key: 'claimStatus', label: 'Payer claim status', type: e(['received_pending', 'pending_info_requested', 'finalized', 'not_on_file']), correctable: true },
  { key: 'statusAsOf', label: 'Status response date', type: D, correctable: true },
  { key: 'payerReceivedDate', label: 'Payer receipt date', type: D, correctable: true },
  { key: 'lastActivityDate', label: 'Last payer activity', type: D, correctable: true },
  { key: 'requestedInformation', label: 'Information the payer requested', type: S, correctable: true },
  { key: 'payerCommitmentDate', label: 'Payer-committed follow-up date', type: D, correctable: true },
  // documentation
  { key: 'requestedDocument', label: 'Document the payer requested', type: S, correctable: true },
  { key: 'requestReference', label: 'Payer request reference', type: S, correctable: true },
  { key: 'submissionDestination', label: 'Verified submission destination', type: S, correctable: true },
  { key: 'priorSubmission', label: 'Prior upload/fax receipt', type: e(['none', 'receipt_on_file', 'unknown']), correctable: true },
  { key: 'attachmentPatientToken', label: 'Staged attachment patient token', type: S, correctable: false },
  { key: 'attachmentClaimReference', label: 'Staged attachment claim reference', type: S, correctable: false },
  { key: 'attachmentDocumentType', label: 'Staged attachment document type', type: S, correctable: false },
  { key: 'releaseAuthorized', label: 'Release of these records authorized', type: B, correctable: false },
  // duplicate
  { key: 'originalClaimReference', label: 'Original claim the payer matched', type: S, correctable: true },
  { key: 'claimFrequency', label: 'Claim frequency', type: e(['original', 'replacement', 'void']), correctable: true },
  { key: 'linesMatchOriginal', label: 'Service lines identical to original', type: B, correctable: true },
  { key: 'originalDisposition', label: 'Disposition of the original claim', type: e(['paid', 'denied', 'pending', 'not_found', 'unknown']), correctable: true },
  // specialist checklists
  { key: 'otherCoverageAtDos', label: 'Other coverage at DOS', type: e(['active', 'none']), correctable: true },
  { key: 'primaryOrderSource', label: 'Primary/secondary order evidence', type: S, correctable: true },
  { key: 'priorPayerAdjudication', label: 'Prior payer adjudication', type: e(['on_file', 'not_on_file']), correctable: true },
  { key: 'originalSubmissionDate', label: 'Original submission date', type: D, correctable: true },
  { key: 'submissionReceiptRef', label: 'Submission receipt reference', type: S, correctable: true },
  { key: 'filingRuleReference', label: 'Filing/appeal rule reference', type: S, correctable: true },
  { key: 'filingTriggerDate', label: 'Filing clock trigger date', type: D, correctable: true },
  { key: 'authRequired', label: 'Authorization required', type: B, correctable: true },
  { key: 'authNumber', label: 'Authorization number', type: S, correctable: true },
  { key: 'authSpanCoversDos', label: 'Authorization span covers DOS', type: B, correctable: true },
  { key: 'authProviderMatches', label: 'Authorized provider matches', type: B, correctable: true },
  { key: 'denialLetterOnFile', label: 'Denial letter on file', type: B, correctable: true },
  { key: 'payerPolicyReference', label: 'Payer policy and version', type: S, correctable: true },
  { key: 'clinicalRecordsOnFile', label: 'Clinical records on file', type: B, correctable: true },
  { key: 'claimLinesOnFile', label: 'Claim lines on file', type: B, correctable: true },
  { key: 'payerEditReference', label: 'Payer edit reference', type: S, correctable: true },
  { key: 'modifiersOnClaim', label: 'Modifiers as billed', type: { kind: 'string_list' }, correctable: false },
];

export const EXTENDED_FACT_KEYS: readonly string[] = EXTENDED_FACTS.map((f) => f.key);

export function extendedFact(key: string): ExtendedFact | undefined {
  return EXTENDED_FACTS.find((f) => f.key === key);
}

export type ExtSourceClass = 'document' | 'structured';

// evidence kind → [factKey, path] read at fixed locations.
// claim_status also feeds the identity check (claimReference, eobPatientToken,
// eobServiceDate are the existing identity observation keys: "the source document's"
// claim, patient token and DOS).
export const EXTENDED_EXTRACTORS: Record<string, { sourceClass: ExtSourceClass; fields: [string, (string | number)[]][] }> = {
  claim_status: { sourceClass: 'document', fields: [
    ['claimReference', ['claimReference']], ['eobPatientToken', ['patientToken']], ['eobServiceDate', ['serviceDate']],
    ['claimStatus', ['status']], ['statusAsOf', ['asOf']], ['payerReceivedDate', ['receivedDate']], ['lastActivityDate', ['lastActivityDate']],
    ['requestedInformation', ['requestedInformation']],
  ] },
  payer_correspondence: { sourceClass: 'document', fields: [
    ['requestedDocument', ['requestedDocument']], ['requestReference', ['requestReference']], ['submissionDestination', ['responseDestination']],
  ] },
  attachment_manifest: { sourceClass: 'structured', fields: [
    ['attachmentPatientToken', ['patientToken']], ['attachmentClaimReference', ['claimReference']], ['attachmentDocumentType', ['documentType']],
    ['releaseAuthorized', ['releaseAuthorized']], ['priorSubmission', ['priorSubmission']],
  ] },
  claim_history: { sourceClass: 'structured', fields: [
    ['originalClaimReference', ['originalClaimReference']], ['claimFrequency', ['frequency']], ['linesMatchOriginal', ['linesMatchOriginal']],
    ['originalDisposition', ['originalDisposition']],
  ] },
  coverage_record: { sourceClass: 'structured', fields: [
    ['otherCoverageAtDos', ['otherCoverageAtDos']], ['primaryOrderSource', ['primaryOrderSource']], ['priorPayerAdjudication', ['priorPayerAdjudication']],
  ] },
  filing_record: { sourceClass: 'structured', fields: [
    ['originalSubmissionDate', ['originalSubmissionDate']], ['submissionReceiptRef', ['submissionReceiptRef']], ['payerReceivedDate', ['payerReceivedDate']],
    ['filingRuleReference', ['filingRuleReference']], ['filingTriggerDate', ['filingTriggerDate']],
  ] },
  auth_record: { sourceClass: 'structured', fields: [
    ['authRequired', ['authRequired']], ['authNumber', ['authNumber']], ['authSpanCoversDos', ['authSpanCoversDos']], ['authProviderMatches', ['authProviderMatches']],
  ] },
  clinical_packet: { sourceClass: 'structured', fields: [
    ['denialLetterOnFile', ['denialLetterOnFile']], ['payerPolicyReference', ['payerPolicyReference']], ['clinicalRecordsOnFile', ['clinicalRecordsOnFile']],
  ] },
  coding_packet: { sourceClass: 'structured', fields: [
    ['claimLinesOnFile', ['claimLinesOnFile']], ['payerEditReference', ['payerEditReference']], ['modifiersOnClaim', ['modifiersOnClaim']],
  ] },
};

export const EXTENDED_EVIDENCE_KINDS = Object.keys(EXTENDED_EXTRACTORS);

function at(obj: unknown, path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}

export interface ExtObservation { factKey: string; value: unknown; path: string; sourceClass: ExtSourceClass }

export function extractExtended(kind: string, content: unknown): ExtObservation[] {
  const spec = EXTENDED_EXTRACTORS[kind];
  if (!spec) return [];
  const out: ExtObservation[] = [];
  for (const [factKey, path] of spec.fields) {
    const value = at(content, path);
    if (value === undefined) continue; // absent stays absent
    out.push({ factKey, value, path: path.join('.'), sourceClass: spec.sourceClass });
  }
  return out;
}

// EOB/ERA: every line's adjustment group + CARC, and remark codes, for scenario selection.
export function extractEobSelection(content: unknown): ExtObservation[] {
  const lines = at(content, ['lines']);
  if (!Array.isArray(lines)) return [];
  const adjustments: { line: number; group: string; carc: string }[] = [];
  const remarks: string[] = [];
  let sawRemarks = false;
  lines.forEach((l, i) => {
    const adj = (l as { adjustments?: unknown })?.adjustments;
    if (Array.isArray(adj)) for (const a of adj) adjustments.push({ line: Number((l as { line?: number }).line ?? i + 1), group: String(a?.group ?? ''), carc: String(a?.carc ?? '') });
    const rem = (l as { remarks?: unknown })?.remarks;
    if (Array.isArray(rem)) { sawRemarks = true; for (const r of rem) if (typeof r === 'string' && !remarks.includes(r)) remarks.push(r); }
  });
  const out: ExtObservation[] = [{ factKey: 'lineAdjustments', value: adjustments, path: 'lines[*].adjustments[*].{group,carc}', sourceClass: 'document' }];
  if (sawRemarks) out.push({ factKey: 'remarkCodes', value: remarks, path: 'lines[*].remarks', sourceClass: 'document' });
  return out;
}

// Returns an error message, or null when the value fits the fact's declared type.
export function validateFactValue(f: ExtendedFact, value: unknown): string | null {
  const t = f.type;
  switch (t.kind) {
    case 'enum': return t.values.includes(value as string | boolean) ? null : `${f.key} must be one of ${t.values.join(', ')}`;
    case 'string': return typeof value === 'string' && value.trim() && value.length <= 300 ? null : `${f.key} must be a non-empty string (max 300 characters)`;
    case 'date': {
      const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T00:00:00Z') : null;
      return d && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? null : `${f.key} must be a date (YYYY-MM-DD)`;
    }
    case 'boolean': return typeof value === 'boolean' ? null : `${f.key} must be true or false`;
    case 'string_list': return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : `${f.key} must be a list of strings`;
    case 'adjustments': return `${f.key} cannot be corrected directly`;
  }
}
