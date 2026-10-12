// CARC/RARC/group -> scenario routing for the knowledge base (FR05), DERIVED from the
// rule packs' versioned selection map (shared/rules/select.ts), which is the single
// source of truth for which CARC selects which pack (ADR 0060).
//
// The KB adds only *guards* on top of the map: group restrictions, a required RARC for a
// generic CARC, and corroborating RARCs. A guard can only send an input to specialist
// review; it can never create a route the selection map does not have. Rows the KB would
// like to add are kept as PROPOSED_ROUTES: data for the next map version, never routed.
//
// Every mapping is a DRAFT that needs business sign-off (build pack doc 05). Codes must
// exist in knowledge/x12/*.json and be active; `npm run kb:verify` enforces that for the
// selection map, the guards and the proposals. Unknown, missing or conflicting signals
// always go to specialist review.
import { SCENARIO_MAP_V1, selectScenario, type ScenarioMap } from '../rules/select.ts';

export type ScenarioId = 'DED01' | 'PEND01' | 'DOC01' | 'DUP01' | 'COB01' | 'TF01' | 'AUTH01' | 'MN01' | 'BUN01';
export type GroupCode = 'CO' | 'PR' | 'OA' | 'PI' | 'CR';
export const GROUP_CODES: readonly GroupCode[] = ['CO', 'PR', 'OA', 'PI', 'CR'];

/** The selection map version the KB routing derives from. */
export const ROUTING_SOURCE_MAP: ScenarioMap = SCENARIO_MAP_V1;
export const ROUTING_VERSION = `kb-routing/draft-2+${ROUTING_SOURCE_MAP.id}@${ROUTING_SOURCE_MAP.version}`;

export interface RouteGuard {
  scenarioId: ScenarioId;
  carcs: string[];
  /** Group codes under which the CARC routes; omitted = any known group. */
  groups?: GroupCode[];
  /** RARCs that corroborate (or, for requiresRarc, are required for) the route. */
  rarcs: string[];
  /** When true the CARC alone is too generic: a listed RARC must be present. */
  requiresRarc?: boolean;
  note: string;
}

// Stricter-only constraints over selection-map rows. Each (scenarioId, carc) must be routed
// to that scenario by the map; kb:verify and tests/routing-consistency.test.ts check this.
export const ROUTE_GUARDS: readonly RouteGuard[] = [
  { scenarioId: 'DED01', carcs: ['1'], groups: ['PR'], rarcs: [], note: 'Deductible under patient responsibility. Other groups with CARC 1 are unusual and go to review.' },
  { scenarioId: 'DOC01', carcs: ['163', '226'], rarcs: ['M127', 'N4'], note: 'Attachment or requested information not received.' },
  { scenarioId: 'DOC01', carcs: ['16'], rarcs: ['M127'], requiresRarc: true, note: 'CARC 16 is generic; only a documentation RARC routes it here.' },
  { scenarioId: 'DUP01', carcs: ['18'], groups: ['OA', 'CO'], rarcs: ['M86', 'N111'], note: 'Exact duplicate. X12 usage note restricts CARC 18 to group OA except where state workers’ compensation rules require CO.' },
  { scenarioId: 'COB01', carcs: ['22', '23'], rarcs: ['MA04', 'N4'], note: 'Coordination of benefits / prior payer impact.' },
  { scenarioId: 'AUTH01', carcs: ['197'], rarcs: ['N54'], note: 'Precertification/authorization absent.' },
  { scenarioId: 'MN01', carcs: ['50'], rarcs: ['N115'], note: 'Medical necessity.' },
  { scenarioId: 'BUN01', carcs: ['97', '234', '236'], rarcs: ['M15', 'N19', 'N20', 'M80'], note: 'Included in another service / not paid separately / NCCI incompatibility.' },
];

/** KB proposals not in the active selection map. They never route; they await a new map version and sign-off. */
export const PROPOSED_ROUTES: readonly { scenarioId: ScenarioId; carcs: string[]; note: string }[] = [
  { scenarioId: 'PEND01', carcs: ['133'], note: 'Line disposition pending further review.' },
  { scenarioId: 'DOC01', carcs: ['252'], note: 'An attachment/other documentation is required.' },
  { scenarioId: 'MN01', carcs: ['150', '151'], note: 'Level or frequency of service not supported.' },
];

export interface RouteRule {
  scenarioId: ScenarioId;
  carcs: string[];
  groups?: GroupCode[];
  rarcs: string[];
  requiresRarc?: boolean;
  signoff: 'draft_requires_business_signoff';
  note: string;
  /** Selection-map entry ids this row derives from. */
  mapEntries: string[];
}

/** Map entries that route by CARC, as (scenario, carc, entry id). */
export function mapCarcRows(map: ScenarioMap = ROUTING_SOURCE_MAP): { scenarioId: string; carc: string; entryId: string; group?: string }[] {
  return map.entries.filter((e) => e.match.carc !== undefined).map((e) => ({ scenarioId: e.scenario, carc: e.match.carc!, entryId: e.id, group: e.match.group }));
}

/** Guard rows that do not correspond to a selection-map route (must be empty). */
export function guardViolations(map: ScenarioMap = ROUTING_SOURCE_MAP): string[] {
  const routed = new Set(mapCarcRows(map).map((r) => `${r.scenarioId}:${r.carc}`));
  return ROUTE_GUARDS.flatMap((g) => g.carcs.filter((c) => !routed.has(`${g.scenarioId}:${c}`)).map((c) => `guard ${g.scenarioId} CARC ${c} is not routed to ${g.scenarioId} by ${map.id} v${map.version}`));
}

function deriveTable(map: ScenarioMap): RouteRule[] {
  const rows = new Map<string, RouteRule>();
  for (const r of mapCarcRows(map)) {
    const guard = ROUTE_GUARDS.find((g) => g.scenarioId === r.scenarioId && g.carcs.includes(r.carc));
    const key = guard ? `g:${ROUTE_GUARDS.indexOf(guard)}` : `s:${r.scenarioId}`;
    const row = rows.get(key) ?? { scenarioId: r.scenarioId as ScenarioId, carcs: [], rarcs: guard?.rarcs ?? [], signoff: 'draft_requires_business_signoff' as const,
      note: guard?.note ?? `Selection map ${map.id} v${map.version}.`, mapEntries: [],
      ...(guard?.groups ? { groups: guard.groups } : {}), ...(guard?.requiresRarc ? { requiresRarc: true } : {}) };
    row.carcs.push(r.carc);
    row.mapEntries.push(r.entryId);
    rows.set(key, row);
  }
  return [...rows.values()];
}

export const ROUTING_TABLE: readonly RouteRule[] = deriveTable(ROUTING_SOURCE_MAP);

export interface RouteCandidate { scenarioId: ScenarioId; reasons: string[] }
export interface RouteResult {
  decision: 'scenario' | 'specialist_review';
  scenarioId: ScenarioId | null;
  candidates: RouteCandidate[];
  reasons: string[];
  input: { group: string; carc: string; rarcs: string[] };
  routingVersion: string;
  selectionMap: { id: string; version: number; status: string };
  mappingStatus: 'draft_requires_business_signoff';
}

const norm = (s: unknown) => String(s ?? '').trim().toUpperCase();

export function routeScenario(group: string | null | undefined, carc: string | null | undefined, rarcs: readonly string[] = []): RouteResult {
  const g = norm(group);
  const c = norm(carc);
  const rs = [...new Set(rarcs.map(norm).filter(Boolean))];
  const reasons: string[] = [];
  const byScenario = new Map<ScenarioId, string[]>();
  const add = (id: ScenarioId, why: string) => { const list = byScenario.get(id) ?? []; list.push(why); byScenario.set(id, list); };

  const groupKnown = (GROUP_CODES as readonly string[]).includes(g);
  if (!g) reasons.push('No adjustment group supplied.');
  else if (!groupKnown) reasons.push(`Unknown adjustment group "${g}".`);
  if (!c) reasons.push('No CARC supplied.');

  let carcMatched = false;
  for (const rule of ROUTING_TABLE) {
    const hitRarcs = rule.rarcs.filter((r) => rs.includes(r));
    if (c && rule.carcs.includes(c)) {
      if (!groupKnown) continue;
      if (rule.groups && !rule.groups.includes(g as GroupCode)) {
        reasons.push(`CARC ${c} maps to ${rule.scenarioId} only under group ${rule.groups.join('/')}; got ${g}.`);
        continue;
      }
      if (rule.requiresRarc && hitRarcs.length === 0) {
        reasons.push(`CARC ${c} is generic; ${rule.scenarioId} needs one of RARC ${rule.rarcs.join(', ')}.`);
        continue;
      }
      carcMatched = true;
      add(rule.scenarioId, `CARC ${c} with group ${g} (selection map ${rule.mapEntries.join(', ')})`);
      for (const r of hitRarcs) add(rule.scenarioId, `RARC ${r} corroborates`);
    } else {
      // A RARC pointing at a different scenario is a competing signal, never a route on its own.
      for (const r of hitRarcs) add(rule.scenarioId, `RARC ${r} suggests this scenario`);
    }
  }
  const proposed = PROPOSED_ROUTES.find((p) => p.carcs.includes(c));
  if (c && !carcMatched && !reasons.some((x) => x.startsWith(`CARC ${c}`))) {
    reasons.push(proposed ? `No draft routing exists for CARC ${c} in the selection map (proposed for ${proposed.scenarioId}; awaiting a new map version and sign-off).` : `No draft routing exists for CARC ${c}.`);
  }

  const candidates = [...byScenario.entries()].map(([scenarioId, why]) => ({ scenarioId, reasons: why }));
  const map = ROUTING_SOURCE_MAP;
  const base = { candidates, input: { group: g, carc: c, rarcs: rs }, routingVersion: ROUTING_VERSION, selectionMap: { id: map.id, version: map.version, status: map.status },
    mappingStatus: 'draft_requires_business_signoff' as const };
  if (carcMatched && candidates.length === 1) {
    // Cross-check against the selection function itself: the KB never routes where selection would not.
    const sel = selectScenario({ adjustments: { status: 'verified', value: [{ group: g, carc: c }] }, remarkCodes: { status: 'missing', value: null },
      claimStatus: { status: 'missing', value: null }, inventoryScenario: null }, map);
    if (sel.status !== 'selected' || sel.scenario !== candidates[0].scenarioId) {
      return { ...base, decision: 'specialist_review', scenarioId: null, reasons: [...reasons, `Selection map ${map.id} v${map.version} gives ${sel.scenario ?? sel.status}; KB routing disagrees, so a specialist decides.`] };
    }
    return { ...base, decision: 'scenario', scenarioId: candidates[0].scenarioId, reasons: [...reasons, `Single candidate ${candidates[0].scenarioId}.`] };
  }
  if (candidates.length > 1) reasons.push(`Multiple candidate scenarios (${candidates.map((x) => x.scenarioId).join(', ')}).`);
  else if (candidates.length === 1) reasons.push(`Only a RARC suggests ${candidates[0].scenarioId}; the CARC does not route there.`);
  return { ...base, decision: 'specialist_review', scenarioId: null, reasons };
}

/** Every code referenced by the routing table, guards and proposals, for integrity checks. */
export function routingCodeRefs(): { type: 'carc' | 'rarc'; code: string; scenarioId: ScenarioId }[] {
  return [
    ...ROUTING_TABLE.flatMap((r) => [
      ...r.carcs.map((code) => ({ type: 'carc' as const, code, scenarioId: r.scenarioId })),
      ...r.rarcs.map((code) => ({ type: 'rarc' as const, code, scenarioId: r.scenarioId })),
    ]),
    ...PROPOSED_ROUTES.flatMap((p) => p.carcs.map((code) => ({ type: 'carc' as const, code, scenarioId: p.scenarioId }))),
  ];
}
