// Rule storage and the generic fact-to-input evaluation for every registered
// scenario pack (shared/rules/registry.ts). Which pack and version runs for an
// account is decided in ./scenario.ts.
import { type Db, one, run } from '../db/db.ts';
import { hashJson, nowIso } from '../util.ts';
import type { RuleDefinition } from '../../shared/rules/catalog.ts';
import { baselines, moduleFor } from '../../shared/rules/registry.ts';
import type { SelectionResult } from '../../shared/rules/select.ts';
import { paramsOf, type RuleResult } from '../../shared/rules/types.ts';
import type { FactRow } from './facts.ts';

export interface LoadedRule { definition: RuleDefinition; sha256: string; state: string }

// Seeds every built-in pack baseline (draft v1) and its lifecycle row. Idempotent.
export function seedRules(db: Db): void {
  for (const def of baselines()) {
    const exists = one(db, 'SELECT 1 FROM rule_versions WHERE rule_id=? AND version=?', def.id, def.version);
    if (!exists) {
      run(db, 'INSERT INTO rule_versions VALUES (?,?,?,?,?,?,?)', def.id, def.version, def.status, JSON.stringify(def), hashJson(def), null, nowIso());
    }
    if (!one(db, 'SELECT 1 FROM rule_lifecycle WHERE rule_id=? AND version=?', def.id, def.version)) {
      run(db, `INSERT INTO rule_lifecycle (rule_id, version, tenant_id, client_id, status, author_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
        def.id, def.version, '*', '*', 'draft', 'system', nowIso(), nowIso());
    }
  }
}

export function loadRule(db: Db, id: string, version: number): LoadedRule {
  const row = one<{ definition: string; sha256: string; state: string }>(db, 'SELECT definition, sha256, state FROM rule_versions WHERE rule_id=? AND version=?', id, version)!;
  const definition = JSON.parse(row.definition) as RuleDefinition;
  if (hashJson(definition) !== row.sha256) throw new Error(`Rule ${id} v${version} failed integrity check`);
  return { definition, sha256: row.sha256, state: row.state };
}

export interface AccountForRule {
  payer_id: string; claim_type: string; service_date: string;
  tenant_id?: string; client_id?: string; patient_token?: string; claim_reference?: string; external_id?: string; scenario?: string;
}

export interface FactRef { key: string; version: number | null; status: string; evidenceId: string | null; used: boolean; optional?: boolean }

export interface RuleEvaluation {
  ruleId: string;
  ruleVersion: number;
  ruleSha256: string;
  ruleState: string;
  scopeMatch: { ok: boolean; reasons: string[] };
  input: Record<string, unknown>;
  factRefs: FactRef[];
  unusableFacts: { key: string; status: string; accepted: string[]; optional?: boolean }[];
  result: RuleResult;
}

export interface EvaluateOptions { asOf?: string; selection?: SelectionResult }

// Pure: reads only its arguments. Draft-vs-approved runnability is decided by the
// caller (scenario.ts); in Phase 0 drafts may run because every environment is synthetic.
export function evaluateAccount(rule: LoadedRule, account: AccountForRule, facts: Map<string, FactRow>, opts: EvaluateOptions = {}): RuleEvaluation {
  const def = rule.definition;
  const mod = moduleFor(def);
  const reasons: string[] = [];
  if (account.tenant_id && def.scope.tenant !== '*' && def.scope.tenant !== account.tenant_id) reasons.push('Tenant is outside rule scope');
  if (account.client_id && def.scope.client !== '*' && def.scope.client !== account.client_id) reasons.push('Client is outside rule scope');
  if (def.scope.payer !== '*' && def.scope.payer !== account.payer_id) reasons.push(`Payer ${account.payer_id} is outside rule scope ${def.scope.payer}`);
  if (def.scope.claimType !== '*' && def.scope.claimType !== account.claim_type) reasons.push(`Claim type ${account.claim_type} is outside rule scope`);
  if (account.service_date < def.effectiveFrom || account.service_date > def.effectiveThrough) reasons.push('Date of service is outside the rule effective dates');

  const factRefs: FactRef[] = [];
  const unusableFacts: RuleEvaluation['unusableFacts'] = [];
  const usable = (key: string): unknown => {
    const spec = def.requiredFacts.find((r) => r.key === key);
    if (!spec) throw new Error(`${def.id} reads undeclared fact ${key}`);
    const f = facts.get(key);
    const ok = !!f && (spec.acceptedStatuses as string[]).includes(f.status);
    const ref: FactRef = { key, version: f?.version ?? null, status: f?.status ?? 'missing', evidenceId: f?.evidenceId ?? null, used: ok };
    if (spec.optional) ref.optional = true;
    factRefs.push(ref);
    if (!ok) unusableFacts.push(spec.optional ? { key, status: ref.status, accepted: spec.acceptedStatuses, optional: true } : { key, status: ref.status, accepted: spec.acceptedStatuses });
    return ok ? f!.value : null;
  };
  const input = mod.mapInput({
    usable,
    fact: (k) => facts.get(k),
    allFacts: () => [...facts.values()],
    account,
    def,
    asOf: opts.asOf ?? nowIso().slice(0, 10),
    selection: opts.selection,
  });

  const result: RuleResult = reasons.length
    ? { outcome: 'specialist_review', abstained: true, reasonCodes: ['RULE_SCOPE_MISMATCH'], missing: [], calculation: null }
    : mod.evaluate(input, paramsOf(def, mod));
  return {
    ruleId: def.id, ruleVersion: def.version, ruleSha256: rule.sha256, ruleState: rule.state,
    scopeMatch: { ok: !reasons.length, reasons }, input, factRefs, unusableFacts, result,
  };
}
