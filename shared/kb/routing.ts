// Draft CARC/RARC/group -> scenario routing (FR05). Pure and deterministic so the
// server, the UI and other workstreams share one implementation.
//
// Every mapping here is a DRAFT that needs business sign-off (build pack doc 05:
// a rule is publishable only after tests pass and a domain owner signs off).
// Codes must exist in knowledge/x12/*.json; `npm run kb:verify` enforces that.
// Unknown, missing or conflicting signals always go to specialist review.

export type ScenarioId = 'DED01' | 'PEND01' | 'DOC01' | 'DUP01' | 'COB01' | 'TF01' | 'AUTH01' | 'MN01' | 'BUND01';
export type GroupCode = 'CO' | 'PR' | 'OA' | 'PI' | 'CR';
export const GROUP_CODES: readonly GroupCode[] = ['CO', 'PR', 'OA', 'PI', 'CR'];

export interface RouteRule {
  scenarioId: ScenarioId;
  /** CARCs that select this scenario. */
  carcs: string[];
  /** Group codes under which the CARC selects it; omitted = any known group. */
  groups?: GroupCode[];
  /** RARCs that corroborate (or, for requiresRarc, are required for) the route. */
  rarcs: string[];
  /** When true the CARC alone is too generic: a listed RARC must be present. */
  requiresRarc?: boolean;
  signoff: 'draft_requires_business_signoff';
  note: string;
}

export const ROUTING_VERSION = 'kb-routing/draft-1';

export const ROUTING_TABLE: readonly RouteRule[] = [
  { scenarioId: 'DED01', carcs: ['1'], groups: ['PR'], rarcs: [], signoff: 'draft_requires_business_signoff', note: 'Deductible under patient responsibility. Other groups with CARC 1 are unusual and go to review.' },
  { scenarioId: 'PEND01', carcs: ['133'], rarcs: [], signoff: 'draft_requires_business_signoff', note: 'Line disposition pending further review.' },
  { scenarioId: 'DOC01', carcs: ['252', '163', '226'], rarcs: ['M127', 'N4'], signoff: 'draft_requires_business_signoff', note: 'Attachment or requested information not received.' },
  { scenarioId: 'DOC01', carcs: ['16'], rarcs: ['M127'], requiresRarc: true, signoff: 'draft_requires_business_signoff', note: 'CARC 16 is generic; only a documentation RARC routes it here.' },
  { scenarioId: 'DUP01', carcs: ['18'], groups: ['OA', 'CO'], rarcs: ['M86', 'N111'], signoff: 'draft_requires_business_signoff', note: 'Exact duplicate. X12 usage note restricts CARC 18 to group OA except where state workers’ compensation rules require CO.' },
  { scenarioId: 'COB01', carcs: ['22', '23'], rarcs: ['MA04', 'N4'], signoff: 'draft_requires_business_signoff', note: 'Coordination of benefits / prior payer impact.' },
  { scenarioId: 'TF01', carcs: ['29'], rarcs: [], signoff: 'draft_requires_business_signoff', note: 'Time limit for filing expired.' },
  { scenarioId: 'AUTH01', carcs: ['197'], rarcs: ['N54'], signoff: 'draft_requires_business_signoff', note: 'Precertification/authorization absent.' },
  { scenarioId: 'MN01', carcs: ['50', '150', '151'], rarcs: ['N115'], signoff: 'draft_requires_business_signoff', note: 'Medical necessity / level or frequency of service.' },
  { scenarioId: 'BUND01', carcs: ['97', '234', '236'], rarcs: ['M15', 'N19', 'N20', 'M80'], signoff: 'draft_requires_business_signoff', note: 'Included in another service / not paid separately / NCCI incompatibility.' },
];

export interface RouteCandidate { scenarioId: ScenarioId; reasons: string[] }
export interface RouteResult {
  decision: 'scenario' | 'specialist_review';
  scenarioId: ScenarioId | null;
  candidates: RouteCandidate[];
  reasons: string[];
  input: { group: string; carc: string; rarcs: string[] };
  routingVersion: string;
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
      add(rule.scenarioId, `CARC ${c} with group ${g} (draft mapping)`);
      for (const r of hitRarcs) add(rule.scenarioId, `RARC ${r} corroborates`);
    } else {
      // A RARC pointing at a different scenario is a competing signal, never a route on its own.
      for (const r of hitRarcs) add(rule.scenarioId, `RARC ${r} suggests this scenario`);
    }
  }
  if (c && !carcMatched && !reasons.some((x) => x.startsWith(`CARC ${c}`))) reasons.push(`No draft routing exists for CARC ${c}.`);

  const candidates = [...byScenario.entries()].map(([scenarioId, why]) => ({ scenarioId, reasons: why }));
  const base = { candidates, input: { group: g, carc: c, rarcs: rs }, routingVersion: ROUTING_VERSION, mappingStatus: 'draft_requires_business_signoff' as const };
  if (carcMatched && candidates.length === 1) {
    return { ...base, decision: 'scenario', scenarioId: candidates[0].scenarioId, reasons: [...reasons, `Single candidate ${candidates[0].scenarioId}.`] };
  }
  if (candidates.length > 1) reasons.push(`Multiple candidate scenarios (${candidates.map((x) => x.scenarioId).join(', ')}).`);
  else if (candidates.length === 1) reasons.push(`Only a RARC suggests ${candidates[0].scenarioId}; the CARC does not route there.`);
  return { ...base, decision: 'specialist_review', scenarioId: null, reasons };
}

/** Every code referenced by the routing table, for integrity checks. */
export function routingCodeRefs(): { type: 'carc' | 'rarc'; code: string; scenarioId: ScenarioId }[] {
  return ROUTING_TABLE.flatMap((r) => [
    ...r.carcs.map((code) => ({ type: 'carc' as const, code, scenarioId: r.scenarioId })),
    ...r.rarcs.map((code) => ({ type: 'rarc' as const, code, scenarioId: r.scenarioId })),
  ]);
}
