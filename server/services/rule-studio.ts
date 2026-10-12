// Rule studio lifecycle (FR06, build pack docs/05 "Rule studio workflow"):
//   draft (working copy, data-only edits)
//   → validate (rule.schema.json projection + module compatibility + all fixtures pass;
//     success freezes an immutable rule_versions row)
//   → submit for review → approve/reject (rule_approve permission, never the author)
//   → publish with activation time → (rollback = new activation of an earlier approved
//     compatible version) → retire.
// Every version is owned by one tenant/client scope (built-in baselines by '*'), and
// activations/retirements are per scope. Runs pin to their version (scenario.ts).
import { readFileSync } from 'node:fs';
import { type Db, all, one, run, tx } from '../db/db.ts';
import { AppError, conflict, forbidden, hashJson, invalid, newId, notFound, now, nowIso } from '../util.ts';
import type { RuleDefinition } from '../../shared/rules/catalog.ts';
import { MODULES, moduleForRule } from '../../shared/rules/registry.ts';
import { applyPatch, diffDefinitions, runFixtures, validateDefinition, EDITABLE_FIELDS, type ValidationReport } from '../../shared/rules/studio.ts';
import { SCENARIO_MAP_V1 } from '../../shared/rules/select.ts';
import type { Fixture, LogicModule } from '../../shared/rules/types.ts';
import { audit } from './audit.ts';
import { can, requirePerm, type Scope } from './auth.ts';
import { currentFacts } from './facts.ts';
import { evaluateAccount, loadRule, type LoadedRule } from './rules.ts';
import { currentActivation, draftsMayRun, isRetired, pinnedVersion, resolveRunnable, SCENARIO_MAP_SHA256, selectForAccount, PHASE0_ENVIRONMENT } from './scenario.ts';

const fixtureCache = new Map<string, Fixture[]>();
export function fixturesFor(mod: LogicModule): Fixture[] {
  if (!fixtureCache.has(mod.fixtureFile)) {
    fixtureCache.set(mod.fixtureFile, JSON.parse(readFileSync(new URL(`../../evaluation/${mod.fixtureFile}`, import.meta.url), 'utf8')) as Fixture[]);
  }
  return fixtureCache.get(mod.fixtureFile)!;
}

function mustModule(ruleId: string): LogicModule {
  const m = moduleForRule(ruleId);
  if (!m) throw notFound('Rule pack');
  return m;
}

interface LifecycleRow {
  rule_id: string; version: number; tenant_id: string; client_id: string; status: string; base_version: number | null; draft_id: string | null;
  author_id: string; validation: string | null; validation_sha256: string | null; submitted_by: string | null; submitted_at: string | null;
  reviewed_by: string | null; reviewed_at: string | null; review_rationale: string | null; created_at: string; updated_at: string;
}

interface DraftRow {
  tenant_id: string; client_id: string; draft_id: string; rule_id: string; base_version: number; definition: string; edit_seq: number;
  status: string; frozen_version: number | null; last_validation: string | null; author_id: string; created_at: string; updated_at: string;
}

const isBuiltIn = (l: LifecycleRow) => l.tenant_id === '*' && l.client_id === '*';
const ownedBy = (l: LifecycleRow, scope: Scope) => l.tenant_id === scope.tenantId && l.client_id === scope.clientId;

// A version is visible to a scope when it is a built-in baseline or owned by that scope.
function visibleLifecycle(db: Db, scope: Scope, ruleId: string, version: number): LifecycleRow {
  const l = one<LifecycleRow>(db, 'SELECT * FROM rule_lifecycle WHERE rule_id=? AND version=?', ruleId, version);
  if (!l || !(isBuiltIn(l) || ownedBy(l, scope))) throw notFound('Rule version');
  return l;
}

function ownedLifecycle(db: Db, scope: Scope, ruleId: string, version: number): LifecycleRow {
  const l = visibleLifecycle(db, scope, ruleId, version);
  if (!ownedBy(l, scope)) throw conflict('built_in_version', 'Built-in baselines cannot be reviewed or published; create a draft from it instead');
  return l;
}

function auditRule(db: Db, scope: Scope, objectId: string, eventType: string, details: Record<string, unknown>, objectType = 'rule_version') {
  audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType, objectId, eventType, details });
}

function versionSummary(db: Db, scope: Scope, l: LifecycleRow) {
  const sha = one<{ sha256: string }>(db, 'SELECT sha256 FROM rule_versions WHERE rule_id=? AND version=?', l.rule_id, l.version)!.sha256;
  const retiredHere = !!one(db, 'SELECT 1 FROM rule_retirements WHERE tenant_id=? AND client_id=? AND rule_id=? AND version=?', scope.tenantId, scope.clientId, l.rule_id, l.version);
  const report = l.validation ? (JSON.parse(l.validation) as ValidationReport) : null;
  return {
    version: l.version, status: retiredHere ? 'retired' : l.status, builtIn: isBuiltIn(l), baseVersion: l.base_version, author: l.author_id,
    submittedBy: l.submitted_by, submittedAt: l.submitted_at, reviewedBy: l.reviewed_by, reviewedAt: l.reviewed_at, reviewRationale: l.review_rationale,
    sha256: sha, createdAt: l.created_at, validation: report ? { ok: report.ok, fixtures: report.fixtures, sha256: l.validation_sha256 } : null,
  };
}

function activeInfo(db: Db, scope: Scope, ruleId: string) {
  const r = resolveRunnable(db, scope, ruleId);
  const act = currentActivation(db, scope, ruleId);
  const pending = all<{ version: number; active_from: string; kind: string }>(db, 'SELECT version, active_from, kind FROM rule_activations WHERE tenant_id=? AND client_id=? AND rule_id=? AND active_from > ? ORDER BY active_from',
    scope.tenantId, scope.clientId, ruleId, nowIso());
  return r.ok ? { runnable: true, version: r.version, via: r.via, note: r.note, activationId: act?.activation_id ?? null, scheduled: pending }
    : { runnable: false, version: act?.version ?? null, via: null, note: r.detail, reason: r.reason, activationId: act?.activation_id ?? null, scheduled: pending };
}

export function permissions(scope: Scope) {
  return { author: can(scope, 'rule_author'), approve: can(scope, 'rule_approve'), view: can(scope, 'view') };
}

// ---------------------------------------------------------------- read models

export function listPacks(db: Db, scope: Scope) {
  requirePerm(scope, 'view');
  return {
    environment: PHASE0_ENVIRONMENT,
    draftsMayRun: draftsMayRun(),
    permissions: permissions(scope),
    selectionMap: { id: SCENARIO_MAP_V1.id, version: SCENARIO_MAP_V1.version, status: SCENARIO_MAP_V1.status, sha256: SCENARIO_MAP_SHA256 },
    packs: MODULES.map((m) => {
      const versions = all<LifecycleRow>(db, `SELECT * FROM rule_lifecycle WHERE rule_id=? AND ((tenant_id='*' AND client_id='*') OR (tenant_id=? AND client_id=?)) ORDER BY version`,
        m.ruleId, scope.tenantId, scope.clientId).map((l) => versionSummary(db, scope, l));
      const drafts = one<{ n: number }>(db, `SELECT COUNT(*) n FROM rule_drafts WHERE tenant_id=? AND client_id=? AND rule_id=? AND status='editing'`, scope.tenantId, scope.clientId, m.ruleId)!.n;
      return { ruleId: m.ruleId, title: m.title, kind: m.kind, summary: m.summary, logicModule: m.id, fixtureFile: m.fixtureFile,
        fixtureCount: fixturesFor(m).length, active: activeInfo(db, scope, m.ruleId), versions, openDrafts: drafts };
    }),
  };
}

export function packDetail(db: Db, scope: Scope, ruleId: string) {
  requirePerm(scope, 'view');
  const m = mustModule(ruleId);
  const versions = all<LifecycleRow>(db, `SELECT * FROM rule_lifecycle WHERE rule_id=? AND ((tenant_id='*' AND client_id='*') OR (tenant_id=? AND client_id=?)) ORDER BY version`,
    ruleId, scope.tenantId, scope.clientId).map((l) => ({ ...versionSummary(db, scope, l), definition: loadRule(db, ruleId, l.version).definition }));
  return {
    ruleId: m.ruleId, title: m.title, kind: m.kind, summary: m.summary, logicModule: m.id,
    outcomeLabels: m.outcomeLabels, paramSpecs: m.paramSpecs, branches: m.branches, hardStops: m.hardStops, fixtureFile: m.fixtureFile,
    editableFields: EDITABLE_FIELDS,
    active: activeInfo(db, scope, ruleId),
    versions,
    activations: all(db, 'SELECT activation_id, version, kind, active_from, reason, previous_version, definition_sha256, activated_by, created_at FROM rule_activations WHERE tenant_id=? AND client_id=? AND rule_id=? ORDER BY seq DESC',
      scope.tenantId, scope.clientId, ruleId),
    retirements: all(db, 'SELECT version, reason, retired_by, retired_at FROM rule_retirements WHERE tenant_id=? AND client_id=? AND rule_id=? ORDER BY retired_at DESC', scope.tenantId, scope.clientId, ruleId),
    drafts: all<DraftRow>(db, `SELECT * FROM rule_drafts WHERE tenant_id=? AND client_id=? AND rule_id=? ORDER BY created_at DESC`, scope.tenantId, scope.clientId, ruleId).map(draftView),
    permissions: permissions(scope),
    environment: PHASE0_ENVIRONMENT,
  };
}

function draftView(d: DraftRow) {
  return { draftId: d.draft_id, ruleId: d.rule_id, baseVersion: d.base_version, definition: JSON.parse(d.definition) as RuleDefinition, editSeq: d.edit_seq,
    status: d.status, frozenVersion: d.frozen_version, lastValidation: d.last_validation ? JSON.parse(d.last_validation) : null, author: d.author_id,
    createdAt: d.created_at, updatedAt: d.updated_at };
}

function getDraftRow(db: Db, scope: Scope, draftId: string): DraftRow {
  const d = one<DraftRow>(db, 'SELECT * FROM rule_drafts WHERE tenant_id=? AND client_id=? AND draft_id=?', scope.tenantId, scope.clientId, draftId);
  if (!d) throw notFound('Draft');
  return d;
}

export function getDraft(db: Db, scope: Scope, draftId: string) {
  requirePerm(scope, 'view');
  const d = getDraftRow(db, scope, draftId);
  const base = loadRule(db, d.rule_id, d.base_version).definition;
  const def = JSON.parse(d.definition) as RuleDefinition;
  return { ...draftView(d), diff: definitionDiff(base, def) };
}

const IGNORED_DIFF = new Set(['version', 'status']);
function definitionDiff(before: RuleDefinition, after: RuleDefinition) {
  return diffDefinitions(before, after).filter((x) => !IGNORED_DIFF.has(x.path));
}

export function getVersion(db: Db, scope: Scope, ruleId: string, version: number) {
  requirePerm(scope, 'view');
  const l = visibleLifecycle(db, scope, ruleId, version);
  const rule = loadRule(db, ruleId, version);
  const base = l.base_version ? loadRule(db, ruleId, l.base_version).definition : null;
  return { ...versionSummary(db, scope, l), definition: rule.definition, validationReport: l.validation ? JSON.parse(l.validation) : null,
    diffFromBase: base ? definitionDiff(base, rule.definition) : [] };
}

// ---------------------------------------------------------------- draft → validate

export function createDraft(db: Db, scope: Scope, ruleId: string, body: { baseVersion?: number }) {
  requirePerm(scope, 'rule_author');
  const m = mustModule(ruleId);
  const baseVersion = Number(body.baseVersion ?? m.baseline.version);
  if (!Number.isInteger(baseVersion)) throw invalid('baseVersion must be a version number');
  return tx(db, () => {
    visibleLifecycle(db, scope, ruleId, baseVersion);
    const base = loadRule(db, ruleId, baseVersion).definition;
    if (base.logicModule !== m.id) throw conflict('incompatible_base', 'Base version uses a different logic module');
    const def: RuleDefinition = { ...JSON.parse(JSON.stringify(base)), status: 'draft', scope: { ...base.scope, tenant: scope.tenantId, client: scope.clientId } };
    const draftId = newId('rdraft');
    run(db, 'INSERT INTO rule_drafts (tenant_id, client_id, draft_id, rule_id, base_version, definition, edit_seq, status, author_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      scope.tenantId, scope.clientId, draftId, ruleId, baseVersion, JSON.stringify(def), 1, 'editing', scope.userId, nowIso(), nowIso());
    auditRule(db, scope, draftId, 'rule_draft_created', { ruleId, baseVersion }, 'rule_draft');
    return getDraft(db, scope, draftId);
  });
}

export function editDraft(db: Db, scope: Scope, draftId: string, body: { patch?: unknown; expectedEditSeq?: number }) {
  requirePerm(scope, 'rule_author');
  return tx(db, () => {
    const d = getDraftRow(db, scope, draftId);
    if (d.status !== 'editing') throw conflict('draft_frozen', `This draft is ${d.status}; create a new draft to change it`);
    if (body.expectedEditSeq !== d.edit_seq) throw conflict('stale_draft', 'The draft changed since you opened it. Refresh before editing.', { editSeq: d.edit_seq });
    const mod = mustModule(d.rule_id);
    const { def, errors } = applyPatch(JSON.parse(d.definition), body.patch, mod);
    if (errors.length) throw invalid('Edit rejected', { errors });
    const before = JSON.parse(d.definition) as RuleDefinition;
    const changed = diffDefinitions(before, def).map((x) => x.path);
    run(db, 'UPDATE rule_drafts SET definition=?, edit_seq=edit_seq+1, last_validation=NULL, updated_at=? WHERE tenant_id=? AND client_id=? AND draft_id=? AND edit_seq=?',
      JSON.stringify(def), nowIso(), scope.tenantId, scope.clientId, draftId, d.edit_seq);
    auditRule(db, scope, draftId, 'rule_draft_edited', { ruleId: d.rule_id, changed }, 'rule_draft');
    return getDraft(db, scope, draftId);
  });
}

export function withdrawDraft(db: Db, scope: Scope, draftId: string) {
  requirePerm(scope, 'rule_author');
  return tx(db, () => {
    const d = getDraftRow(db, scope, draftId);
    if (d.status !== 'editing') throw conflict('draft_frozen', `This draft is ${d.status}`);
    run(db, `UPDATE rule_drafts SET status='withdrawn', updated_at=? WHERE tenant_id=? AND client_id=? AND draft_id=?`, nowIso(), scope.tenantId, scope.clientId, draftId);
    auditRule(db, scope, draftId, 'rule_draft_withdrawn', { ruleId: d.rule_id }, 'rule_draft');
    return getDraft(db, scope, draftId);
  });
}

function owner(scope: Scope) {
  return { tenant: scope.tenantId, client: scope.clientId };
}

export function validateDraft(db: Db, scope: Scope, draftId: string) {
  requirePerm(scope, 'rule_author');
  return tx(db, () => {
    const d = getDraftRow(db, scope, draftId);
    if (d.status !== 'editing') throw conflict('draft_frozen', `This draft is ${d.status}`);
    const mod = mustModule(d.rule_id);
    const next = one<{ v: number }>(db, 'SELECT MAX(version) v FROM rule_versions WHERE rule_id=?', d.rule_id)!.v + 1;
    const def: RuleDefinition = { ...(JSON.parse(d.definition) as RuleDefinition), version: next, status: 'draft' };
    const report = validateDefinition(def, mod, fixturesFor(mod), owner(scope));
    run(db, 'UPDATE rule_drafts SET last_validation=?, updated_at=? WHERE tenant_id=? AND client_id=? AND draft_id=?', JSON.stringify(report), nowIso(), scope.tenantId, scope.clientId, draftId);
    if (!report.ok) {
      auditRule(db, scope, draftId, 'rule_validation_failed', { ruleId: d.rule_id, schemaErrors: report.schema.errors.length, compatibility: report.compatibility.errors, fixtureFailures: report.fixtures.failures.map((f) => f.id) }, 'rule_draft');
      return { ok: false, report, version: null, draft: getDraft(db, scope, draftId) };
    }
    const sha = hashJson(def);
    run(db, 'INSERT INTO rule_versions VALUES (?,?,?,?,?,?,?)', d.rule_id, next, 'draft', JSON.stringify(def), sha, null, nowIso());
    run(db, `INSERT INTO rule_lifecycle (rule_id, version, tenant_id, client_id, status, base_version, draft_id, author_id, validation, validation_sha256, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, d.rule_id, next, scope.tenantId, scope.clientId, 'validated', d.base_version, draftId, d.author_id, JSON.stringify(report), hashJson(report), nowIso(), nowIso());
    run(db, `UPDATE rule_drafts SET status='frozen', frozen_version=?, updated_at=? WHERE tenant_id=? AND client_id=? AND draft_id=?`, next, nowIso(), scope.tenantId, scope.clientId, draftId);
    auditRule(db, scope, `${d.rule_id}@${next}`, 'rule_version_validated', { ruleId: d.rule_id, version: next, definitionSha256: sha, fixtures: `${report.fixtures.passed}/${report.fixtures.total}`, draftId });
    return { ok: true, report, version: next, draft: getDraft(db, scope, draftId) };
  });
}

// Re-runs validation on a frozen version (fixtures may have been extended since).
function revalidate(db: Db, scope: Scope, ruleId: string, version: number): ValidationReport {
  const mod = mustModule(ruleId);
  return validateDefinition(loadRule(db, ruleId, version).definition, mod, fixturesFor(mod), owner(scope));
}

// ---------------------------------------------------------------- review → publish → rollback → retire

export function submitVersion(db: Db, scope: Scope, ruleId: string, version: number) {
  requirePerm(scope, 'rule_author');
  return tx(db, () => {
    const l = ownedLifecycle(db, scope, ruleId, version);
    if (l.status !== 'validated') throw conflict('not_submittable', `Version is ${l.status}; only a validated version can be submitted for review`);
    run(db, `UPDATE rule_lifecycle SET status='in_review', submitted_by=?, submitted_at=?, updated_at=? WHERE rule_id=? AND version=? AND status='validated'`,
      scope.userId, nowIso(), nowIso(), ruleId, version);
    auditRule(db, scope, `${ruleId}@${version}`, 'rule_submitted', { ruleId, version });
    return getVersion(db, scope, ruleId, version);
  });
}

export function reviewVersion(db: Db, scope: Scope, ruleId: string, version: number, body: { decision?: string; rationale?: string }) {
  requirePerm(scope, 'rule_approve');
  const rationale = String(body.rationale ?? '').trim();
  if (body.decision !== 'approve' && body.decision !== 'reject') throw invalid('decision must be approve or reject');
  if (rationale.length < 5) throw invalid('A review rationale is required');
  return tx(db, () => {
    const l = ownedLifecycle(db, scope, ruleId, version);
    if (l.status !== 'in_review') throw conflict('not_in_review', `Version is ${l.status}`);
    if (l.author_id === scope.userId || l.submitted_by === scope.userId) throw forbidden('Separation of duties: the author or submitter of a rule version cannot review it');
    if (body.decision === 'approve') {
      const report = revalidate(db, scope, ruleId, version);
      if (!report.ok) throw new AppError(422, 'invalid_rule', 'The version no longer passes validation', report);
      run(db, `UPDATE rule_lifecycle SET status='approved', reviewed_by=?, reviewed_at=?, review_rationale=?, updated_at=? WHERE rule_id=? AND version=? AND status='in_review'`,
        scope.userId, nowIso(), rationale, nowIso(), ruleId, version);
      run(db, `UPDATE rule_versions SET state='approved', approved_by=? WHERE rule_id=? AND version=?`, scope.userId, ruleId, version);
    } else {
      run(db, `UPDATE rule_lifecycle SET status='rejected', reviewed_by=?, reviewed_at=?, review_rationale=?, updated_at=? WHERE rule_id=? AND version=? AND status='in_review'`,
        scope.userId, nowIso(), rationale, nowIso(), ruleId, version);
    }
    auditRule(db, scope, `${ruleId}@${version}`, body.decision === 'approve' ? 'rule_approved' : 'rule_rejected', { ruleId, version, rationale });
    return getVersion(db, scope, ruleId, version);
  });
}

function parseActiveFrom(v: unknown): string {
  if (v === undefined || v === null || v === '') return nowIso();
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw invalid('activeFrom must be an ISO date-time');
  const t = new Date(v);
  if (t.getTime() < now().getTime() - 5 * 60_000) throw invalid('activeFrom cannot be in the past (no back-dated activations)');
  return t.toISOString();
}

export function publishVersion(db: Db, scope: Scope, ruleId: string, version: number, body: { activeFrom?: string; reason?: string }) {
  requirePerm(scope, 'rule_approve');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 5) throw invalid('A publication reason is required');
  const activeFrom = parseActiveFrom(body.activeFrom);
  return tx(db, () => {
    const l = ownedLifecycle(db, scope, ruleId, version);
    if (isRetired(db, scope, ruleId, version)) throw conflict('retired', 'A retired version cannot be published');
    if (l.status !== 'approved') throw conflict('not_approved', `Version is ${l.status}; only an approved version can be published`);
    const report = revalidate(db, scope, ruleId, version);
    if (!report.ok) throw new AppError(422, 'invalid_rule', 'The version does not pass validation and cannot be published', report);
    const prev = currentActivation(db, scope, ruleId);
    const activationId = newId('ract');
    const sha = loadRule(db, ruleId, version).sha256;
    run(db, `INSERT INTO rule_activations (activation_id, tenant_id, client_id, rule_id, version, kind, active_from, reason, previous_version, definition_sha256, activated_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, activationId, scope.tenantId, scope.clientId, ruleId, version, 'publish', activeFrom, reason, prev?.version ?? null, sha, scope.userId, nowIso());
    auditRule(db, scope, `${ruleId}@${version}`, 'rule_published', { ruleId, version, activeFrom, previousVersion: prev?.version ?? null, activationId, reason });
    return { activationId, activeFrom, previousVersion: prev?.version ?? null, active: activeInfo(db, scope, ruleId) };
  });
}

export function rollbackTo(db: Db, scope: Scope, ruleId: string, version: number, body: { reason?: string }) {
  requirePerm(scope, 'rule_approve');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 5) throw invalid('A rollback reason is required');
  return tx(db, () => {
    const l = ownedLifecycle(db, scope, ruleId, version);
    if (l.status !== 'approved' || isRetired(db, scope, ruleId, version)) throw conflict('not_rollback_target', 'Only an approved, non-retired version can be restored');
    if (!one(db, 'SELECT 1 FROM rule_activations WHERE tenant_id=? AND client_id=? AND rule_id=? AND version=?', scope.tenantId, scope.clientId, ruleId, version)) {
      throw conflict('not_rollback_target', 'Rollback restores a version that was previously active in this scope; publish it instead');
    }
    const cur = currentActivation(db, scope, ruleId);
    if (cur?.version === version) throw conflict('already_active', `v${version} is already active`);
    const target = loadRule(db, ruleId, version);
    if (cur) {
      const curDef = loadRule(db, ruleId, cur.version).definition;
      if (curDef.logicModule !== target.definition.logicModule) throw conflict('incompatible', 'The target uses a different logic module than the active version');
    }
    const report = revalidate(db, scope, ruleId, version);
    if (!report.ok) throw new AppError(422, 'invalid_rule', 'The target version no longer passes validation', report);
    const activationId = newId('ract');
    const activeFrom = nowIso();
    run(db, `INSERT INTO rule_activations (activation_id, tenant_id, client_id, rule_id, version, kind, active_from, reason, previous_version, definition_sha256, activated_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, activationId, scope.tenantId, scope.clientId, ruleId, version, 'rollback', activeFrom, reason, cur?.version ?? null, target.sha256, scope.userId, nowIso());
    auditRule(db, scope, `${ruleId}@${version}`, 'rule_rolled_back', { ruleId, version, previousVersion: cur?.version ?? null, activationId, reason });
    return { activationId, activeFrom, previousVersion: cur?.version ?? null, active: activeInfo(db, scope, ruleId) };
  });
}

export function retireVersion(db: Db, scope: Scope, ruleId: string, version: number, body: { reason?: string }) {
  requirePerm(scope, 'rule_approve');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 5) throw invalid('A retirement reason is required');
  return tx(db, () => {
    const l = visibleLifecycle(db, scope, ruleId, version);
    if (isRetired(db, scope, ruleId, version)) throw conflict('already_retired', 'Version already retired');
    run(db, 'INSERT INTO rule_retirements VALUES (?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, ruleId, version, reason, scope.userId, nowIso());
    if (ownedBy(l, scope)) {
      run(db, `UPDATE rule_lifecycle SET status='retired', updated_at=? WHERE rule_id=? AND version=?`, nowIso(), ruleId, version);
      run(db, `UPDATE rule_versions SET state='retired' WHERE rule_id=? AND version=?`, ruleId, version);
    }
    auditRule(db, scope, `${ruleId}@${version}`, 'rule_retired', { ruleId, version, reason, builtIn: isBuiltIn(l) });
    return { retired: true, active: activeInfo(db, scope, ruleId) };
  });
}

// ---------------------------------------------------------------- before/after impact

const abstains = (o: string) => o === 'collect_evidence' || o === 'specialist_review';

function classify(before: string | null, after: string): string {
  if (before === null) return 'newly_runnable';
  if (before === after) return 'unchanged';
  if (abstains(before) && !abstains(after)) return 'newly_automated';
  if (!abstains(before) && abstains(after)) return 'newly_blocked';
  if (abstains(before) && abstains(after)) return 'routing_changed';
  return 'action_changed';
}

export function impactOf(db: Db, scope: Scope, ruleId: string, candidate: RuleDefinition, label: string) {
  const mod = mustModule(ruleId);
  const res = resolveRunnable(db, scope, ruleId);
  const current: LoadedRule | null = res.ok ? res.rule : null;
  const cand: LoadedRule = { definition: candidate, sha256: hashJson(candidate), state: 'candidate' };
  const fx = fixturesFor(mod);
  const beforeRows = current ? runFixtures(mod, fx, current.definition) : null;
  const afterRows = runFixtures(mod, fx, candidate);
  const fixtures = afterRows.map((a, i) => ({ id: a.id, name: a.name, category: a.category, expected: a.expected, before: beforeRows?.[i].actual ?? null, after: a.actual, pass: a.pass }))
    .filter((r) => r.before !== r.after || !r.pass);

  const accounts = all<{ account_id: string; external_id: string; payer_id: string; claim_type: string; service_date: string; tenant_id: string; client_id: string;
    patient_token: string; claim_reference: string; scenario: string; state: string }>(db,
    'SELECT account_id, external_id, payer_id, claim_type, service_date, tenant_id, client_id, patient_token, claim_reference, scenario, state FROM accounts WHERE tenant_id=? AND client_id=? ORDER BY external_id',
    scope.tenantId, scope.clientId);
  const asOf = nowIso().slice(0, 10);
  const rows: { accountId: string; externalId: string; before: string | null; after: string; change: string; beforeReasons: string[]; afterReasons: string[];
    pinned: { version: number; actionState: string } | null }[] = [];
  let considered = 0;
  for (const a of accounts) {
    if (a.state === 'ready') continue; // not investigated: no evidence to evaluate
    const facts = currentFacts(db, scope, a.account_id);
    const sel = selectForAccount(db, scope, a, facts);
    if (sel.selection.scenario !== ruleId) continue;
    considered++;
    const before = current ? evaluateAccount(current, a, facts, { asOf }).result : null;
    const after = evaluateAccount(cand, a, facts, { asOf }).result;
    const change = classify(before?.outcome ?? null, after.outcome);
    const reasonsChanged = JSON.stringify(before?.reasonCodes ?? []) !== JSON.stringify(after.reasonCodes);
    if (change === 'unchanged' && !reasonsChanged) continue;
    const pin = pinnedVersion(db, scope, a.account_id, ruleId);
    rows.push({ accountId: a.account_id, externalId: a.external_id, before: before?.outcome ?? null, after: after.outcome, change: change === 'unchanged' ? 'reasons_changed' : change,
      beforeReasons: before?.reasonCodes ?? [], afterReasons: after.reasonCodes, pinned: pin ? { version: pin.version, actionState: pin.state } : null });
  }
  const count = (k: string) => rows.filter((r) => r.change === k).length;
  return {
    ruleId, candidate: label, candidateSha256: cand.sha256,
    current: current ? { version: current.definition.version, via: res.ok ? res.via : null } : { version: null, via: null, note: res.ok ? '' : res.detail },
    fixtures: { total: afterRows.length, changed: fixtures.filter((f) => f.before !== f.after).length, failing: fixtures.filter((f) => !f.pass).length, rows: fixtures },
    accounts: { considered, changed: rows.length, newlyAutomated: count('newly_automated'), newlyBlocked: count('newly_blocked'), actionChanged: count('action_changed'),
      routingChanged: count('routing_changed'), rows },
    note: 'Accounts pinned to an in-flight version keep that version until the action completes; others pick up the new version on their next evaluation.',
  };
}

export function draftImpact(db: Db, scope: Scope, draftId: string) {
  requirePerm(scope, 'view');
  const d = getDraftRow(db, scope, draftId);
  return impactOf(db, scope, d.rule_id, JSON.parse(d.definition) as RuleDefinition, `draft ${draftId}`);
}

export function versionImpact(db: Db, scope: Scope, ruleId: string, version: number) {
  requirePerm(scope, 'view');
  visibleLifecycle(db, scope, ruleId, version);
  return impactOf(db, scope, ruleId, loadRule(db, ruleId, version).definition, `v${version}`);
}
