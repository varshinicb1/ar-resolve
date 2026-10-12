// Specialist routes (build pack docs/05 additional playbooks): COB, timely filing,
// authorization, medical necessity, bundled service. These packs never propose a
// payer-facing or financial action. They evaluate an evidence checklist so the UI
// can show what is missing, and their only outcomes are collect_evidence,
// specialist_review, or an internal work item routing the packet to a specialist.
import type { RequiredFact, RuleDefinition } from '../catalog.ts';
import type { ChecklistItem, LogicModule } from '../types.ts';
import { conflictAmong, gate, isBlank, isIsoDate, makeReasonLabel, nonEmptyString, readAll, result } from './common.ts';

interface Item {
  key: string;
  label: string;
  accepted: RequiredFact['acceptedStatuses'];
  // Whether the value satisfies the checklist item; receives all inputs for conditional items.
  ok: (v: unknown, input: Record<string, unknown>) => boolean;
  hint: string;
}

interface Cfg {
  id: string;
  ruleId: string;
  title: string;
  summary: string;
  taskKind: string;
  taskLabel: string;
  specialist: string;
  items: Item[];
  hardStops: string[];
  prohibited: string[];
  sources: string[];
  fixtureFile: string;
}

const isBool = (v: unknown) => typeof v === 'boolean';
const isTrue = (v: unknown) => v === true;

const REASONS: Record<string, string> = {
  EVIDENCE_CHECKLIST_INCOMPLETE: 'The specialist evidence checklist is incomplete',
  EVIDENCE_CHECKLIST_COMPLETE: 'The specialist evidence checklist is complete',
  SPECIALIST_JUDGEMENT_REQUIRED: 'This scenario requires a qualified specialist decision; no automated action is proposed',
};

function make(cfg: Cfg): LogicModule {
  const def: RuleDefinition = {
    id: cfg.ruleId,
    version: 1,
    status: 'draft',
    logicModule: cfg.id,
    scope: { tenant: '*', client: '*', payer: 'demo-payer', plan: '*', claimType: 'professional' },
    effectiveFrom: '2026-01-01',
    effectiveThrough: '2026-12-31',
    owner: 'Business reviewer to be assigned',
    supportedAssumptions: [`Specialist route only: ${cfg.specialist} makes every substantive decision`],
    requiredFacts: [
      { key: 'identityVerified', label: 'Claim identity matches EOB', acceptedStatuses: ['verified'] },
      { key: 'claimReference', label: 'Payer claim reference', acceptedStatuses: ['verified'] },
      ...cfg.items.map((i) => ({ key: i.key, label: i.label, acceptedStatuses: i.accepted, optional: true })),
    ],
    actions: [
      { kind: 'collect_evidence', risk: 'abstain', connector: null, approveLabel: null },
      { kind: 'specialist_review', risk: 'abstain', connector: null, approveLabel: null },
      { kind: cfg.taskKind, risk: 'internal_work_item', connector: 'internal_worklist', approveLabel: `Approve routing to ${cfg.specialist}` },
    ],
    prohibitedActions: cfg.prohibited,
    sources: cfg.sources,
    followUpBusinessDays: null,
    followUpSource: `Set by the ${cfg.specialist}; no automated follow-up date`,
    hardStops: cfg.hardStops,
    noteTemplate: ['Evidence checklist with sources', 'Missing items', 'Specialist routed to'],
  };
  const checklist = (input: Record<string, unknown>): ChecklistItem[] => cfg.items.map((i) => {
    const v = input[i.key];
    const satisfied = !isBlank(v) ? i.ok(v, input) : i.ok(undefined, input);
    return { key: i.key, label: i.label, satisfied, status: isBlank(v) ? (satisfied ? 'not_applicable' : 'missing') : satisfied ? 'present' : 'invalid', note: satisfied ? undefined : i.hint };
  });
  return {
    id: cfg.id,
    ruleId: cfg.ruleId,
    title: cfg.title,
    kind: 'specialist_route',
    summary: cfg.summary,
    outcomeLabels: { collect_evidence: 'Evidence missing', specialist_review: 'Specialist review required', [cfg.taskKind]: cfg.taskLabel },
    reasonLabel: makeReasonLabel(REASONS),
    paramSpecs: [],
    branches: [
      { when: 'Identity unavailable or any checklist item missing', propose: 'collect_evidence' },
      { when: 'Source conflict', propose: 'specialist_review' },
      { when: 'Checklist complete', propose: cfg.taskKind },
    ],
    hardStops: cfg.hardStops,
    noteFacts: [['identityVerified', 'Identity matches EOB', false], ...cfg.items.map((i) => [i.key, i.label, false] as [string, string, boolean])],
    baseline: def,
    fixtureFile: cfg.fixtureFile,
    mapInput(ctx) {
      const input = readAll(ctx);
      input.conflict = conflictAmong(ctx, ctx.def.requiredFacts.map((f) => f.key));
      return input;
    },
    evaluate(input) {
      const list = checklist(input);
      const g = gate(input, ['identityVerified', 'claimReference']);
      if (g) return { ...g, checklist: list };
      const missing = list.filter((c) => !c.satisfied).map((c) => c.key);
      if (missing.length) return result('collect_evidence', ['EVIDENCE_CHECKLIST_INCOMPLETE'], missing, null, list);
      return result(cfg.taskKind, ['EVIDENCE_CHECKLIST_COMPLETE', 'SPECIALIST_JUDGEMENT_REQUIRED'], [], null, list);
    },
    request(kind, a, r) {
      if (kind !== cfg.taskKind) return { summary: kind };
      return { summary: `Create a worklist task routing ${a.claim_reference} to the ${cfg.specialist} with the completed evidence checklist. No payer contact, write-off or claim change is made by this action.`,
        specialist: cfg.specialist, checklist: (r.checklist ?? []).map((c) => ({ key: c.key, satisfied: c.satisfied })) };
    },
    noteExtras: (_def, r) => [`Checklist: ${(r.checklist ?? []).map((c) => `${c.label} ${c.satisfied ? 'present' : 'MISSING'}`).join('; ')}.`],
  };
}

const CARC_SRC = 'X12 CARC list (S08) for routing codes only';

export const cob01Module = make({
  id: 'cob01.v1', ruleId: 'COB01', title: 'Coordination of benefits (specialist route)', fixtureFile: 'cob01-fixtures.json',
  summary: 'Assembles coverage-at-DOS, payer-order and prior-payer evidence for a COB specialist.',
  taskKind: 'cob_specialist_task', taskLabel: 'Route to COB specialist', specialist: 'COB specialist',
  items: [
    { key: 'otherCoverageAtDos', label: 'Other coverage at date of service', accepted: ['verified'], ok: (v) => v === 'active' || v === 'none', hint: 'Coverage at DOS, not today' },
    { key: 'primaryOrderSource', label: 'Primary/secondary order evidence', accepted: ['verified'], ok: nonEmptyString, hint: 'Documented order of benefits source' },
    { key: 'priorPayerAdjudication', label: 'Prior payer adjudication on file', accepted: ['verified'], ok: (v, i) => i.otherCoverageAtDos === 'none' || v === 'on_file', hint: 'Prior payer EOB/ERA when other coverage is active' },
  ],
  hardStops: ['Never change payer order from a generic adjustment code alone'],
  prohibited: ['payer_order_change', 'claim_resubmission', 'automatic_writeoff', 'automatic_patient_billing'],
  sources: ['Build pack docs/05 COB playbook', CARC_SRC, 'Client policy pending'],
});

export const tf01Module = make({
  id: 'tf01.v1', ruleId: 'TF01', title: 'Timely filing (specialist route)', fixtureFile: 'tf01-fixtures.json',
  summary: 'Assembles submission proof, payer receipt and the applicable filing rule for an appeal specialist. The engine never computes a filing deadline.',
  taskKind: 'timely_filing_review_task', taskLabel: 'Route to timely-filing appeal specialist', specialist: 'appeals specialist',
  items: [
    { key: 'originalSubmissionDate', label: 'Original submission date', accepted: ['verified'], ok: isIsoDate, hint: 'From the PM/clearinghouse record' },
    { key: 'submissionReceiptRef', label: 'Original submission receipt reference', accepted: ['verified'], ok: nonEmptyString, hint: 'Clearinghouse or payer acknowledgment reference' },
    { key: 'payerReceivedDate', label: 'Payer receipt date', accepted: ['verified'], ok: isIsoDate, hint: 'Payer-side receipt, not clearinghouse acceptance' },
    { key: 'filingRuleReference', label: 'Applicable filing/appeal rule reference', accepted: ['verified'], ok: nonEmptyString, hint: 'Contract or payer policy citation supplied by the client' },
    { key: 'filingTriggerDate', label: 'Filing clock trigger date', accepted: ['verified'], ok: isIsoDate, hint: 'Event that starts the filing clock under that rule' },
  ],
  hardStops: ['No automatic write-off when a date looks expired', 'No deadline is computed without a client-supplied rule'],
  prohibited: ['automatic_writeoff', 'claim_resubmission', 'automatic_patient_billing'],
  sources: ['Build pack docs/05 Timely filing playbook', CARC_SRC, 'Client policy pending'],
});

export const auth01Module = make({
  id: 'auth01.v1', ruleId: 'AUTH01', title: 'Authorization absent (specialist route)', fixtureFile: 'auth01-fixtures.json',
  summary: 'Assembles authorization requirement, number, span and provider match for an authorization specialist.',
  taskKind: 'auth_verification_task', taskLabel: 'Route to authorization specialist', specialist: 'authorization specialist',
  items: [
    { key: 'authRequired', label: 'Authorization requirement for the service', accepted: ['verified'], ok: isBool, hint: 'From the client payer-requirement record' },
    { key: 'authNumber', label: 'Authorization number on file', accepted: ['verified'], ok: (v, i) => i.authRequired === false || nonEmptyString(v), hint: 'Never invented; from the authorization record' },
    { key: 'authSpanCoversDos', label: 'Authorization span covers DOS', accepted: ['verified'], ok: (v, i) => i.authRequired === false || isBool(v), hint: 'Effective span compared with DOS' },
    { key: 'authProviderMatches', label: 'Authorized provider matches rendering provider', accepted: ['verified'], ok: (v, i) => i.authRequired === false || isBool(v), hint: 'Rendering provider comparison' },
  ],
  hardStops: ['No invented authorization numbers', 'No guarantee of retro-authorization'],
  prohibited: ['claim_resubmission', 'automatic_writeoff', 'automatic_patient_billing'],
  sources: ['Build pack docs/05 Authorization absent playbook', CARC_SRC, 'Client policy pending'],
});

export const mn01Module = make({
  id: 'mn01.v1', ruleId: 'MN01', title: 'Medical necessity (specialist route)', fixtureFile: 'mn01-fixtures.json',
  summary: 'Assembles the denial letter, payer policy version and clinical records for a qualified clinical/coding reviewer. No clinical rationale is generated.',
  taskKind: 'clinical_review_task', taskLabel: 'Route to qualified clinical reviewer', specialist: 'qualified clinical reviewer',
  items: [
    { key: 'denialLetterOnFile', label: 'Denial letter on file', accepted: ['verified'], ok: isTrue, hint: 'Payer denial letter' },
    { key: 'payerPolicyReference', label: 'Payer policy and version cited', accepted: ['verified'], ok: nonEmptyString, hint: 'Policy identifier and version effective at DOS' },
    { key: 'clinicalRecordsOnFile', label: 'Clinical records on file', accepted: ['verified'], ok: isTrue, hint: 'Records for the DOS' },
  ],
  hardStops: ['No unsupported clinical rationale; only a qualified clinician writes one'],
  prohibited: ['automatic_appeal', 'clinical_rationale_generation', 'automatic_code_change', 'automatic_writeoff'],
  sources: ['Build pack docs/05 Medical necessity playbook', CARC_SRC, 'Client policy pending'],
});

export const bun01Module = make({
  id: 'bun01.v1', ruleId: 'BUN01', title: 'Bundled service (specialist route)', fixtureFile: 'bun01-fixtures.json',
  summary: 'Assembles claim lines, the payer edit and modifier facts for a coding reviewer. Modifiers are never added to obtain payment.',
  taskKind: 'coding_review_task', taskLabel: 'Route to coding reviewer', specialist: 'coding reviewer',
  items: [
    { key: 'claimLinesOnFile', label: 'Claim lines on file', accepted: ['verified'], ok: isTrue, hint: 'All lines of the claim version' },
    { key: 'payerEditReference', label: 'Payer edit cited', accepted: ['verified', 'reported'], ok: nonEmptyString, hint: 'Edit identifier from the payer' },
    { key: 'modifiersOnClaim', label: 'Modifiers as billed', accepted: ['verified'], ok: (v) => Array.isArray(v) && v.every((m) => typeof m === 'string'), hint: 'As billed; an empty list is a valid answer' },
  ],
  hardStops: ['Never add or change modifiers merely to obtain payment'],
  prohibited: ['automatic_code_change', 'modifier_change', 'claim_resubmission', 'automatic_writeoff'],
  sources: ['Build pack docs/05 Bundled service playbook', CARC_SRC, 'Client policy pending'],
});

export const SPECIALIST_MODULES = [cob01Module, tf01Module, auth01Module, mn01Module, bun01Module];
