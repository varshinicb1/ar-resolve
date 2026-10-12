// Scenario registry: every executable pack, specialist route and the router.
// Imported by the API, worker, evaluation script and browser rule studio, so the
// same deterministic code runs everywhere. Adding a pack = one module file plus a
// line here plus its fixtures; see ADR 0020 for the contract.
import type { RuleDefinition } from './catalog.ts';
import { ded01Module } from './packs/ded01.ts';
import { pend01Module } from './packs/pend01.ts';
import { doc01Module } from './packs/doc01.ts';
import { dup01Module } from './packs/dup01.ts';
import { SPECIALIST_MODULES } from './packs/specialist.ts';
import { route00Module } from './packs/route00.ts';
import type { LogicModule } from './types.ts';

export const MODULES: readonly LogicModule[] = [ded01Module, pend01Module, doc01Module, dup01Module, ...SPECIALIST_MODULES, route00Module];

const byId = new Map(MODULES.map((m) => [m.id, m]));
const byRule = new Map(MODULES.map((m) => [m.ruleId, m]));

export const ROUTER_RULE_ID = route00Module.ruleId;

export function moduleById(id: string): LogicModule | undefined {
  return byId.get(id);
}

export function moduleForRule(ruleId: string): LogicModule | undefined {
  return byRule.get(ruleId);
}

export function moduleFor(def: RuleDefinition): LogicModule {
  const m = byId.get(def.logicModule);
  if (!m) throw new Error(`Unknown logic module ${def.logicModule}`);
  return m;
}

export function baselines(): RuleDefinition[] {
  return MODULES.map((m) => m.baseline);
}

// Outcome kinds are unique per pack except the shared abstentions, so a global
// lookup is unambiguous for display.
export function outcomeLabel(kind: string, ruleId?: string): string {
  if (ruleId) {
    const m = byRule.get(ruleId);
    if (m?.outcomeLabels[kind]) return m.outcomeLabels[kind];
  }
  for (const m of MODULES) if (m.outcomeLabels[kind]) return m.outcomeLabels[kind];
  return kind;
}

export function reasonText(code: string, ruleId?: string): string {
  const m = ruleId ? byRule.get(ruleId) : undefined;
  if (m) return m.reasonLabel(code);
  for (const mod of MODULES) {
    const t = mod.reasonLabel(code);
    if (t !== code) return t;
  }
  return code;
}
