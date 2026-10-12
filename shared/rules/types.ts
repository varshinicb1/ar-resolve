// Contract every scenario logic module implements (see ADR 0020).
// A rule pack = versioned definition DATA (shared/rules/catalog.ts RuleDefinition,
// hashed and stored in rule_versions) + one reviewed deterministic LOGIC MODULE
// named by definition.logicModule. Editors change data only; logic is code review.
import type { ActionSpec, RuleDefinition } from './catalog.ts';
import type { SelectionResult } from './select.ts';

export interface ChecklistItem {
  key: string;
  label: string;
  satisfied: boolean;
  status: string; // fact status as seen by the rule (missing, verified, reported, conflicting, invalid)
  note?: string;
}

export interface RuleResult {
  outcome: string;
  abstained: boolean;
  reasonCodes: string[];
  missing: string[];
  calculation: unknown;
  // Evidence checklist for specialist routes (and any pack that wants one).
  checklist?: ChecklistItem[];
}

export interface AccountContext {
  payer_id: string;
  claim_type: string;
  service_date: string;
  tenant_id?: string;
  client_id?: string;
  patient_token?: string;
  claim_reference?: string;
  external_id?: string;
  scenario?: string;
}

export interface FactLike { value: unknown; status: string; evidenceId: string | null }

export interface MapContext {
  // Returns the fact value when its status is accepted by the definition, else null.
  // Every call is recorded as a fact reference (used / unusable) for the audit trail.
  usable: (key: string) => unknown;
  fact: (key: string) => FactLike | undefined;
  allFacts: () => FactLike[];
  account: AccountContext;
  def: RuleDefinition;
  asOf: string; // YYYY-MM-DD evaluation date supplied by the caller (deterministic in tests)
  selection?: SelectionResult;
}

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  unit: string;
  description: string;
}

export interface Branch { when: string; propose: string }

export interface Fixture {
  id: string;
  name: string;
  category?: 'positive' | 'negative' | 'ambiguous' | 'adversarial';
  input: Record<string, unknown>;
  expected: string;
  expectedReasons?: string[];
  severity: string;
  labelStatus: string;
  params?: Record<string, number>;
}

export type PackKind = 'executable' | 'specialist_route' | 'router';

export interface LogicModule {
  id: string; // e.g. 'pend01.v1'
  ruleId: string; // e.g. 'PEND01'
  title: string;
  kind: PackKind;
  summary: string;
  outcomeLabels: Record<string, string>;
  reasonLabel: (code: string) => string;
  paramSpecs: ParamSpec[];
  branches: Branch[];
  hardStops: string[];
  // [factKey, label, isMoney] rows printed in the deterministic note.
  noteFacts: [string, string, boolean][];
  baseline: RuleDefinition;
  fixtureFile: string; // under evaluation/
  mapInput: (ctx: MapContext) => Record<string, unknown>;
  evaluate: (input: Record<string, unknown>, params: Record<string, number>) => RuleResult;
  request: (kind: string, account: AccountContext, result: RuleResult, def: RuleDefinition) => Record<string, unknown>;
  calculationText?: (result: RuleResult) => string | null;
  noteExtras?: (def: RuleDefinition, result: RuleResult) => string[];
}

export function paramsOf(def: RuleDefinition, mod: LogicModule): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of mod.paramSpecs) {
    const v = def.params?.[p.key];
    if (typeof v === 'number') out[p.key] = v;
  }
  return out;
}

export function labelFor(def: RuleDefinition | null, mod: LogicModule, kind: string): string {
  return def?.outcomeLabels?.[kind] ?? mod.outcomeLabels[kind] ?? kind;
}

export type { ActionSpec };
