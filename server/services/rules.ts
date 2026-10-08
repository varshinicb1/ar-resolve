// Rule selection and fact-to-input mapping for the consolidated DED01 engine.
import { type Db, one, run } from '../db/db.ts';
import { hashJson, nowIso } from '../util.ts';
import { DED01_V1, type RuleDefinition } from '../../shared/rules/catalog.ts';
import { evaluateDed01, type Ded01Input, type Ded01Result } from '../../shared/rules/ded01.ts';
import type { FactRow } from './facts.ts';

export interface LoadedRule { definition: RuleDefinition; sha256: string; state: string }

export function seedRules(db: Db): void {
  const exists = one(db, 'SELECT 1 FROM rule_versions WHERE rule_id=? AND version=?', DED01_V1.id, DED01_V1.version);
  if (exists) return;
  run(db, 'INSERT INTO rule_versions VALUES (?,?,?,?,?,?,?)', DED01_V1.id, DED01_V1.version, DED01_V1.status,
    JSON.stringify(DED01_V1), hashJson(DED01_V1), null, nowIso());
}

export function loadRule(db: Db, id: string, version: number): LoadedRule {
  const row = one<{ definition: string; sha256: string; state: string }>(db, 'SELECT definition, sha256, state FROM rule_versions WHERE rule_id=? AND version=?', id, version)!;
  const definition = JSON.parse(row.definition) as RuleDefinition;
  if (hashJson(definition) !== row.sha256) throw new Error(`Rule ${id} v${version} failed integrity check`);
  return { definition, sha256: row.sha256, state: row.state };
}

export interface AccountForRule { payer_id: string; claim_type: string; service_date: string }

export interface FactRef { key: string; version: number | null; status: string; evidenceId: string | null; used: boolean }

export interface RuleEvaluation {
  ruleId: string;
  ruleVersion: number;
  ruleSha256: string;
  ruleState: string;
  scopeMatch: { ok: boolean; reasons: string[] };
  input: Ded01Input;
  factRefs: FactRef[];
  unusableFacts: { key: string; status: string; accepted: string[] }[];
  result: Ded01Result;
}

// In Phase 0 the draft DED01 is allowed to run because every environment is synthetic.
// An assisted-live environment must refuse draft rules (see ADR 0001).
export function evaluateAccount(rule: LoadedRule, account: AccountForRule, facts: Map<string, FactRow>): RuleEvaluation {
  const def = rule.definition;
  const reasons: string[] = [];
  if (def.scope.payer !== '*' && def.scope.payer !== account.payer_id) reasons.push(`Payer ${account.payer_id} is outside rule scope ${def.scope.payer}`);
  if (def.scope.claimType !== account.claim_type) reasons.push(`Claim type ${account.claim_type} is outside rule scope`);
  if (account.service_date < def.effectiveFrom || account.service_date > def.effectiveThrough) reasons.push('Date of service is outside the rule effective dates');

  const factRefs: FactRef[] = [];
  const unusableFacts: RuleEvaluation['unusableFacts'] = [];
  const usable = (key: string): unknown => {
    const spec = def.requiredFacts.find((r) => r.key === key)!;
    const f = facts.get(key);
    const ok = !!f && (spec.acceptedStatuses as string[]).includes(f.status);
    factRefs.push({ key, version: f?.version ?? null, status: f?.status ?? 'missing', evidenceId: f?.evidenceId ?? null, used: ok });
    if (!ok) unusableFacts.push({ key, status: f?.status ?? 'missing', accepted: spec.acceptedStatuses });
    return ok ? f!.value : null;
  };

  const plan = usable('planDesign');
  const input: Ded01Input = {
    identityVerified: usable('identityVerified'),
    planSupported: plan === null ? null : plan === def.scope.plan,
    claimReference: usable('claimReference'),
    adjustmentGroup: usable('adjustmentGroup'),
    allowedCents: usable('allowedCents'),
    appliedCents: usable('appliedCents'),
    limitCents: usable('limitCents'),
    metBeforeCents: usable('metBeforeCents'),
    secondaryAtDos: usable('secondaryAtDos'),
    crossoverStatus: usable('crossoverStatus'),
    postingVerified: usable('postingVerified'),
  };
  const eobKeys = ['claimReference', 'adjustmentGroup', 'allowedCents', 'appliedCents'];
  input.eobVerified = eobKeys.every((k) => facts.get(k)?.status === 'verified') ? true : eobKeys.some((k) => facts.get(k)) ? false : null;
  input.conflict = [...facts.values()].some((f) => f.status === 'conflicting');

  let result: Ded01Result;
  if (reasons.length) {
    result = { outcome: 'specialist_review', abstained: true, reasonCodes: ['RULE_SCOPE_MISMATCH'], missing: [], calculation: null };
  } else {
    result = evaluateDed01(input);
  }
  return {
    ruleId: def.id, ruleVersion: def.version, ruleSha256: rule.sha256, ruleState: rule.state,
    scopeMatch: { ok: !reasons.length, reasons }, input, factRefs, unusableFacts, result,
  };
}
