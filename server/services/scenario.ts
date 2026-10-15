// FR05 + FR06 runtime: which pack and which version evaluates an account.
//   1. selectScenario (shared/rules/select.ts) picks a pack from evidence signals.
//   2. resolveRunnable picks the version: the version an in-flight case is pinned
//      to, else the scope's active activation, else (synthetic only) the built-in
//      draft baseline. Anything else routes to ROUTE00, which only abstains.
import { type Db, all, one } from '../db/db.ts';
import { hashJson, nowIso } from '../util.ts';
import { moduleForRule, ROUTER_RULE_ID } from '../../shared/rules/registry.ts';
import { SCENARIO_MAP_V1, selectScenario, selectionReasonLabel, type SelectionResult, type SelectionSignals } from '../../shared/rules/select.ts';
import type { Scope } from './auth.ts';
import type { FactRow } from './facts.ts';
import { loadRule, type AccountForRule, type LoadedRule } from './rules.ts';
import { deploymentEnv } from '../config.ts';

// Must equal ENVIRONMENT in server/http/app.ts (asserted in tests/rule-studio.test.ts).
export const PHASE0_ENVIRONMENT: string = deploymentEnv(); // AR_ENV, ADR 0090: drafts never run outside synthetic

// Phase 0 rule: a draft (unapproved) version may run ONLY because every environment
// is synthetic. Shadow / assisted-live environments must run approved activations.
export function draftsMayRun(env: string = PHASE0_ENVIRONMENT): boolean {
  return env === 'synthetic';
}

export const SCENARIO_MAP_SHA256 = hashJson(SCENARIO_MAP_V1);

const IN_FLIGHT = ['awaiting_review', 'approved', 'dispatching', 'uncertain', 'accepted'];

export type ResolutionVia = 'pinned' | 'activation' | 'synthetic_draft_baseline' | 'router_fallback';
export type Resolution =
  | { ok: true; rule: LoadedRule; via: ResolutionVia; version: number; activationId: string | null; note: string }
  | { ok: false; reason: string; detail: string };

export function isRetired(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, ruleId: string, version: number): boolean {
  if (one(db, 'SELECT 1 FROM rule_retirements WHERE tenant_id=? AND client_id=? AND rule_id=? AND version=?', scope.tenantId, scope.clientId, ruleId, version)) return true;
  const lc = one<{ status: string }>(db, 'SELECT status FROM rule_lifecycle WHERE rule_id=? AND version=?', ruleId, version);
  return lc?.status === 'retired';
}

export interface ActivationRow { activation_id: string; rule_id: string; version: number; kind: string; active_from: string; reason: string; previous_version: number | null; activated_by: string; created_at: string; seq: number }

export function currentActivation(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, ruleId: string, at = nowIso()): ActivationRow | undefined {
  return one<ActivationRow>(db, `SELECT * FROM rule_activations WHERE tenant_id=? AND client_id=? AND rule_id=? AND active_from <= ?
    ORDER BY active_from DESC, seq DESC LIMIT 1`, scope.tenantId, scope.clientId, ruleId, at);
}

export function pinnedVersion(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, accountId: string, ruleId: string): { version: number; actionId: string; state: string } | null {
  const r = one<{ rule_version: number; action_id: string; state: string }>(db,
    `SELECT w.rule_version, p.action_id, p.state FROM proposed_actions p JOIN workflow_runs w ON w.tenant_id=p.tenant_id AND w.client_id=p.client_id AND w.run_id=p.run_id
     WHERE p.tenant_id=? AND p.client_id=? AND p.account_id=? AND w.rule_id=? AND p.state IN (${IN_FLIGHT.map(() => '?').join(',')})
     ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1`, scope.tenantId, scope.clientId, accountId, ruleId, ...IN_FLIGHT);
  return r ? { version: r.rule_version, actionId: r.action_id, state: r.state } : null;
}

export function resolveRunnable(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, ruleId: string, opts: { accountId?: string; env?: string; at?: string } = {}): Resolution {
  const env = opts.env ?? PHASE0_ENVIRONMENT;
  const mod = moduleForRule(ruleId);
  if (!mod) return { ok: false, reason: 'UNKNOWN_PACK', detail: `No logic module registered for ${ruleId}` };
  if (opts.accountId) {
    const pin = pinnedVersion(db, scope, opts.accountId, ruleId);
    if (pin && !isRetired(db, scope, ruleId, pin.version)) {
      const lc = one<{ status: string }>(db, 'SELECT status FROM rule_lifecycle WHERE rule_id=? AND version=?', ruleId, pin.version);
      if (lc?.status === 'approved' || draftsMayRun(env)) {
        return { ok: true, rule: loadRule(db, ruleId, pin.version), via: 'pinned', version: pin.version, activationId: null,
          note: `Pinned to v${pin.version} while action ${pin.actionId} is ${pin.state}` };
      }
    }
  }
  const act = currentActivation(db, scope, ruleId, opts.at);
  if (act) {
    if (isRetired(db, scope, ruleId, act.version)) return { ok: false, reason: 'RULE_VERSION_RETIRED', detail: `${ruleId} v${act.version} is active in this scope but retired; publish or roll back a version` };
    return { ok: true, rule: loadRule(db, ruleId, act.version), via: 'activation', version: act.version, activationId: act.activation_id,
      note: `${act.kind === 'rollback' ? 'Rolled back' : 'Published'} v${act.version} active from ${act.active_from}` };
  }
  const base = mod.baseline;
  if (!draftsMayRun(env)) return { ok: false, reason: 'DRAFT_NOT_RUNNABLE', detail: `${ruleId} has no approved activation; drafts run only in the synthetic environment` };
  if (isRetired(db, scope, ruleId, base.version)) return { ok: false, reason: 'RULE_VERSION_RETIRED', detail: `${ruleId} draft baseline is retired in this scope` };
  return { ok: true, rule: loadRule(db, ruleId, base.version), via: 'synthetic_draft_baseline', version: base.version, activationId: null,
    note: `No published version; draft baseline v${base.version} runs only because the environment is synthetic` };
}

function signal<T>(facts: Map<string, FactRow>, key: string): { status: string; value: T | null } {
  const f = facts.get(key);
  return f ? { status: f.status, value: (f.value ?? null) as T | null } : { status: 'missing', value: null };
}

export function selectionSignals(facts: Map<string, FactRow>, account: AccountForRule): SelectionSignals {
  return {
    adjustments: signal(facts, 'lineAdjustments'),
    remarkCodes: signal(facts, 'remarkCodes'),
    claimStatus: signal(facts, 'claimStatus'),
    inventoryScenario: account.scenario ?? null,
  };
}

export interface ScenarioChoice {
  rule: LoadedRule;
  selection: SelectionResult;
  resolution: { ruleId: string; version: number; via: ResolutionVia; activationId: string | null; note: string; notRunnable?: { ruleId: string; reason: string; detail: string } };
  map: { id: string; version: number; sha256: string };
}

export function selectForAccount(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, account: AccountForRule & { account_id?: string }, facts: Map<string, FactRow>, env?: string): ScenarioChoice {
  let selection = selectScenario(selectionSignals(facts, account));
  const map = { id: SCENARIO_MAP_V1.id, version: SCENARIO_MAP_V1.version, sha256: SCENARIO_MAP_SHA256 };
  let notRunnable: ScenarioChoice['resolution']['notRunnable'];
  if (selection.status === 'selected' && selection.scenario) {
    const r = resolveRunnable(db, scope, selection.scenario, { accountId: account.account_id, env });
    if (r.ok) return { rule: r.rule, selection, map, resolution: { ruleId: selection.scenario, version: r.version, via: r.via, activationId: r.activationId, note: r.note } };
    notRunnable = { ruleId: selection.scenario, reason: r.reason, detail: r.detail };
    selection = { ...selection, status: 'not_runnable', reasons: [...selection.reasons, { code: 'RULE_NOT_RUNNABLE', detail: `${selection.scenario}: ${r.reason}` }] };
  }
  // The router only ever abstains, so it may always run (falls back to its baseline).
  const rr = resolveRunnable(db, scope, ROUTER_RULE_ID, { env });
  const routerRule = rr.ok ? rr.rule : loadRule(db, ROUTER_RULE_ID, 1);
  return { rule: routerRule, selection, map, resolution: { ruleId: ROUTER_RULE_ID, version: routerRule.definition.version, via: rr.ok ? rr.via : 'router_fallback',
    activationId: rr.ok ? rr.activationId : null, note: rr.ok ? rr.note : 'Router baseline (abstains only)', notRunnable } };
}

// Review-time check (review.ts): a proposal may be approved only while its rule
// version is still runnable in this scope.
export function ruleRunnableForApproval(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, ruleId: string, version: number, env = PHASE0_ENVIRONMENT): { pass: boolean; detail: string } {
  if (isRetired(db, scope, ruleId, version)) return { pass: false, detail: `${ruleId} v${version} has been retired in this scope` };
  const lc = one<{ status: string }>(db, 'SELECT status FROM rule_lifecycle WHERE rule_id=? AND version=?', ruleId, version);
  if (lc?.status === 'approved') return { pass: true, detail: `${ruleId} v${version} is approved` };
  if (draftsMayRun(env)) return { pass: true, detail: 'Draft allowed only because the environment is synthetic; assisted-live requires an approved version' };
  return { pass: false, detail: `${ruleId} v${version} is not approved` };
}

interface RunRow { rule_id: string; rule_version: number; inputs: string; result: string; state: string }

function latestRun(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, accountId: string): RunRow | undefined {
  return one<RunRow>(db, 'SELECT rule_id, rule_version, inputs, result, state FROM workflow_runs WHERE tenant_id=? AND client_id=? AND account_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    scope.tenantId, scope.clientId, accountId);
}

// Count of non-optional required facts that are missing for the account's latest pack.
export function missingRequiredCount(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, accountId: string, cache = new Map<string, string[]>()): number {
  const run = latestRun(db, scope, accountId);
  if (!run) return 0;
  const key = `${run.rule_id}@${run.rule_version}`;
  if (!cache.has(key)) cache.set(key, loadRule(db, run.rule_id, run.rule_version).definition.requiredFacts.filter((f) => !f.optional).map((f) => f.key));
  const keys = cache.get(key)!;
  if (!keys.length) return 0;
  const rows = all<{ fact_key: string; status: string }>(db, `SELECT f.fact_key, f.status FROM facts f WHERE tenant_id=? AND client_id=? AND account_id=?
    AND version=(SELECT MAX(version) FROM facts g WHERE g.tenant_id=f.tenant_id AND g.client_id=f.client_id AND g.account_id=f.account_id AND g.fact_key=f.fact_key)`,
  scope.tenantId, scope.clientId, accountId);
  const status = new Map(rows.map((r) => [r.fact_key, r.status]));
  // Phase 0 semantics: only materialized facts in status 'missing' count (no facts yet = not collected).
  return keys.filter((k) => status.get(k) === 'missing').length;
}

// Account workspace read model: which scenario applies now, and why.
export function scenarioView(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, account: AccountForRule & { account_id: string }, facts: Map<string, FactRow>) {
  const choice = selectForAccount(db, scope, account, facts);
  const run = latestRun(db, scope, account.account_id);
  const recorded = run ? (JSON.parse(run.inputs) as { selection?: SelectionResult; resolution?: ScenarioChoice['resolution'] }) : null;
  const factRule = run ? loadRule(db, run.rule_id, run.rule_version) : choice.rule;
  const mod = moduleForRule(factRule.definition.id);
  const describe = (s: SelectionResult) => ({ ...s, reasonText: s.reasons.map(selectionReasonLabel) });
  return {
    current: { selection: describe(choice.selection), resolution: choice.resolution, map: choice.map },
    lastRun: run ? { ruleId: run.rule_id, ruleVersion: run.rule_version, selection: recorded?.selection ? describe(recorded.selection) : null, resolution: recorded?.resolution ?? null } : null,
    pack: { ruleId: factRule.definition.id, version: factRule.definition.version, title: mod?.title ?? factRule.definition.id, kind: mod?.kind ?? 'executable',
      hardStops: factRule.definition.hardStops ?? mod?.hardStops ?? [], actions: factRule.definition.actions, outcomeLabels: { ...(mod?.outcomeLabels ?? {}), ...(factRule.definition.outcomeLabels ?? {}) } },
    factRule,
  };
}
