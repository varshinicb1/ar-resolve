// FR05 scenario selection: a small deterministic selector over a versioned mapping
// table (data, not code). Signals: line adjustment group + CARC, RARC, claim status
// and line context; the imported inventory scenario is only a fallback hint when no
// adjudication or status evidence exists. Unknown or multiple matches never guess:
// they route to the ROUTE00 pack (specialist review / collect evidence) with reasons.
//
// The table is designed to be replaced by a knowledge-base sourced table later:
// keep the shape (id, version, status, sources, entries, inventoryHints).

export interface ScenarioMapEntry {
  id: string;
  scenario: string;
  match: { carc?: string; group?: string; rarc?: string; claimStatus?: string };
  note: string;
}

export interface ScenarioMapSource { id: string; title: string; url?: string; retrievedAt?: string; status: 'verified' | 'unverified' | 'internal'; note: string }

export interface ScenarioMap {
  id: string;
  version: number;
  status: 'draft' | 'approved';
  effectiveFrom: string;
  labelStatus: string;
  sources: ScenarioMapSource[];
  entries: ScenarioMapEntry[];
  inventoryHints: Record<string, string>;
}

const X12 = 'x12-carc';

// CARC routing rows. Code meanings were checked against the X12 CARC page on the
// retrieval date below; descriptions are short paraphrases, not the licensed text.
// Which pack each code routes to is our synthetic proposal, not customer policy.
export const SCENARIO_MAP_V1: ScenarioMap = {
  id: 'SCENARIO_MAP',
  version: 1,
  status: 'draft',
  effectiveFrom: '2026-01-01',
  labelStatus: 'synthetic_proposed_not_customer_approved',
  sources: [
    { id: X12, title: 'X12 Claim Adjustment Reason Codes (S08)', url: 'https://x12.org/codes/claim-adjustment-reason-codes', retrievedAt: '2026-10-12', status: 'verified',
      note: 'Checked code meanings for 1, 16, 18, 22, 23, 29, 50, 97, 163, 197, 226, 234, 236 and group codes CO, PR, OA, PI, CR. Licensed code text is not bundled.' },
    { id: 'build-pack-05', title: 'Build pack docs/05 additional scenario starting playbooks', status: 'internal', note: 'Pack boundaries and hard stops' },
    { id: 'rarc', title: 'Remittance Advice Remark Codes', status: 'unverified',
      note: 'No RARC rows in v1: no maintained RARC source was reviewed. RARCs are recorded as context and passed to packs as data.' },
  ],
  entries: [
    { id: 'carc-1', scenario: 'DED01', match: { carc: '1' }, note: 'Deductible amount' },
    { id: 'carc-16', scenario: 'DOC01', match: { carc: '16' }, note: 'Claim lacks information or has submission/billing errors' },
    { id: 'carc-163', scenario: 'DOC01', match: { carc: '163' }, note: 'Referenced attachment/documentation not received' },
    { id: 'carc-226', scenario: 'DOC01', match: { carc: '226' }, note: 'Information requested from the billing/rendering provider not provided' },
    { id: 'carc-18', scenario: 'DUP01', match: { carc: '18' }, note: 'Exact duplicate claim/service' },
    { id: 'carc-22', scenario: 'COB01', match: { carc: '22' }, note: 'May be covered by another payer per coordination of benefits' },
    { id: 'carc-23', scenario: 'COB01', match: { carc: '23' }, note: 'Impact of prior payer adjudication' },
    { id: 'carc-29', scenario: 'TF01', match: { carc: '29' }, note: 'Time limit for filing has expired' },
    { id: 'carc-197', scenario: 'AUTH01', match: { carc: '197' }, note: 'Precertification/authorization/notification absent' },
    { id: 'carc-50', scenario: 'MN01', match: { carc: '50' }, note: 'Not deemed a medical necessity by the payer' },
    { id: 'carc-97', scenario: 'BUN01', match: { carc: '97' }, note: 'Benefit included in payment for another service' },
    { id: 'carc-234', scenario: 'BUN01', match: { carc: '234' }, note: 'Procedure not paid separately' },
    { id: 'carc-236', scenario: 'BUN01', match: { carc: '236' }, note: 'Procedure/modifier combination not compatible with another on the same day' },
    { id: 'status-pending', scenario: 'PEND01', match: { claimStatus: 'received_pending' }, note: 'Synthetic status value' },
    { id: 'status-info', scenario: 'PEND01', match: { claimStatus: 'pending_info_requested' }, note: 'Synthetic status value' },
    { id: 'status-notfound', scenario: 'PEND01', match: { claimStatus: 'not_on_file' }, note: 'Synthetic status value' },
    { id: 'status-final', scenario: 'PEND01', match: { claimStatus: 'finalized' }, note: 'Finalized but no adjudication evidence on file' },
  ],
  inventoryHints: { deductible: 'DED01', pending: 'PEND01', documentation: 'DOC01', duplicate: 'DUP01' },
};

export interface Signal<T> { status: string; value: T | null }

export interface SelectionSignals {
  adjustments: Signal<{ line?: number; group?: string; carc?: string }[]>;
  remarkCodes: Signal<string[]>;
  claimStatus: Signal<string>;
  inventoryScenario: string | null;
}

export type SelectionStatus = 'selected' | 'ambiguous' | 'unknown' | 'no_evidence' | 'conflict' | 'not_runnable';

export interface SelectionReason { code: string; detail?: string }

export interface SelectionResult {
  mapId: string;
  mapVersion: number;
  status: SelectionStatus;
  scenario: string | null;
  candidates: string[];
  via: 'adjustment' | 'remark' | 'claim_status' | 'inventory_hint' | null;
  matchedEntries: string[];
  reasons: SelectionReason[];
}

const USABLE = new Set(['verified']);

export const SELECTION_REASON_LABELS: Record<string, string> = {
  MATCHED: 'Matched the scenario mapping table',
  UNMAPPED_CARC: 'Adjustment reason not in the mapping table (ignored when another code maps)',
  UNMAPPED_RARC: 'Remark code recorded as context only (no RARC rows in this table version)',
  MULTIPLE_SCENARIOS_MATCHED: 'Codes on this claim map to more than one scenario',
  NO_SCENARIO_MATCH: 'No mapped code or status on this claim',
  SIGNAL_CONFLICT: 'Sources disagree on adjudication codes or claim status',
  SIGNAL_NOT_VERIFIED: 'Signal is not from a verified source and was not used',
  NO_ADJUDICATION_OR_STATUS: 'No EOB/ERA adjustments and no claim status on file',
  SELECTED_FROM_INVENTORY_HINT: 'Selected from the imported inventory scenario because no adjudication or status evidence exists yet',
  INVENTORY_HINT_DIFFERS: 'The imported inventory scenario differs from the evidence; evidence wins',
  STATUS_UNMAPPED: 'Claim status value is not in the mapping table',
  ADJUDICATION_TAKES_PRECEDENCE: 'Adjudication codes take precedence over claim status',
  RULE_NOT_RUNNABLE: 'The selected pack has no runnable version in this scope',
};

export function selectionReasonLabel(r: SelectionReason): string {
  const base = SELECTION_REASON_LABELS[r.code] ?? r.code;
  return r.detail ? `${base} (${r.detail})` : base;
}

export function selectScenario(signals: SelectionSignals, map: ScenarioMap = SCENARIO_MAP_V1): SelectionResult {
  const reasons: SelectionReason[] = [];
  const out = (status: SelectionStatus, scenario: string | null, candidates: string[], via: SelectionResult['via'], matched: string[]): SelectionResult => {
    if (scenario && via !== 'inventory_hint' && signals.inventoryScenario) {
      const hinted = map.inventoryHints[signals.inventoryScenario];
      if (hinted && hinted !== scenario) reasons.push({ code: 'INVENTORY_HINT_DIFFERS', detail: `${signals.inventoryScenario} → ${hinted}` });
    }
    return { mapId: map.id, mapVersion: map.version, status, scenario, candidates, via, matchedEntries: matched, reasons };
  };

  const sigs = [['adjustments', signals.adjustments], ['remarkCodes', signals.remarkCodes], ['claimStatus', signals.claimStatus]] as const;
  const conflicting = sigs.filter(([, s]) => s.status === 'conflicting').map(([k]) => k);
  if (conflicting.length) {
    reasons.push({ code: 'SIGNAL_CONFLICT', detail: conflicting.join(', ') });
    return out('conflict', null, [], null, []);
  }
  for (const [k, s] of sigs) if (s.value !== null && s.status !== 'missing' && !USABLE.has(s.status)) reasons.push({ code: 'SIGNAL_NOT_VERIFIED', detail: `${k} (${s.status})` });

  const adjustments = USABLE.has(signals.adjustments.status) && Array.isArray(signals.adjustments.value) ? signals.adjustments.value : [];
  const remarks = USABLE.has(signals.remarkCodes.status) && Array.isArray(signals.remarkCodes.value) ? signals.remarkCodes.value : [];
  const status = USABLE.has(signals.claimStatus.status) && typeof signals.claimStatus.value === 'string' ? signals.claimStatus.value : null;

  if (adjustments.length || remarks.length) {
    const matched: ScenarioMapEntry[] = [];
    for (const adj of adjustments) {
      const hits = map.entries.filter((e) => e.match.carc !== undefined && e.match.carc === String(adj?.carc ?? '') && (e.match.group === undefined || e.match.group === adj?.group));
      if (!hits.length) reasons.push({ code: 'UNMAPPED_CARC', detail: `${adj?.group ?? '?'}-${adj?.carc ?? '?'}${adj?.line !== undefined ? ` line ${adj.line}` : ''}` });
      matched.push(...hits);
    }
    for (const rarc of remarks) {
      const hits = map.entries.filter((e) => e.match.rarc !== undefined && e.match.rarc === rarc);
      if (!hits.length) reasons.push({ code: 'UNMAPPED_RARC', detail: String(rarc) });
      matched.push(...hits);
    }
    const scenarios = [...new Set(matched.map((m) => m.scenario))].sort();
    const ids = [...new Set(matched.map((m) => m.id))];
    if (status) reasons.push({ code: 'ADJUDICATION_TAKES_PRECEDENCE', detail: `claim status ${status}` });
    if (scenarios.length === 1) {
      reasons.unshift({ code: 'MATCHED', detail: `${ids.join(', ')} → ${scenarios[0]}` });
      return out('selected', scenarios[0], scenarios, matched.some((m) => m.match.carc) ? 'adjustment' : 'remark', ids);
    }
    if (scenarios.length > 1) {
      reasons.unshift({ code: 'MULTIPLE_SCENARIOS_MATCHED', detail: scenarios.join(', ') });
      return out('ambiguous', null, scenarios, null, ids);
    }
    reasons.unshift({ code: 'NO_SCENARIO_MATCH' });
    return out('unknown', null, [], null, []);
  }

  if (status) {
    const hits = map.entries.filter((e) => e.match.claimStatus === status);
    const scenarios = [...new Set(hits.map((h) => h.scenario))];
    if (scenarios.length === 1) {
      reasons.unshift({ code: 'MATCHED', detail: `${hits.map((h) => h.id).join(', ')} → ${scenarios[0]}` });
      return out('selected', scenarios[0], scenarios, 'claim_status', hits.map((h) => h.id));
    }
    if (scenarios.length > 1) {
      reasons.unshift({ code: 'MULTIPLE_SCENARIOS_MATCHED', detail: scenarios.join(', ') });
      return out('ambiguous', null, scenarios, null, hits.map((h) => h.id));
    }
    reasons.unshift({ code: 'STATUS_UNMAPPED', detail: status });
    return out('unknown', null, [], null, []);
  }

  const hinted = signals.inventoryScenario ? map.inventoryHints[signals.inventoryScenario] : undefined;
  if (hinted) {
    reasons.push({ code: 'SELECTED_FROM_INVENTORY_HINT', detail: `${signals.inventoryScenario} → ${hinted}` });
    return out('selected', hinted, [hinted], 'inventory_hint', []);
  }
  reasons.push({ code: 'NO_ADJUDICATION_OR_STATUS' });
  return out('no_evidence', null, [], null, []);
}
