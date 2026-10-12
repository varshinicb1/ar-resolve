// Resolves observations into versioned facts with explicit status.
// Unknown is never represented as false or zero; disagreement is 'conflicting'
// even when one source is newer.
import { type Db, all, one, run } from '../db/db.ts';
import { canonicalJson, nowIso } from '../util.ts';
import type { FactStatus } from '../../shared/rules/catalog.ts';
import type { Scope } from './auth.ts';
import { emitConflicts } from './analytics.ts';

export const FACT_KEYS = [
  'identityVerified', 'planDesign', 'claimReference', 'adjustmentGroup', 'allowedCents', 'appliedCents',
  'limitCents', 'metBeforeCents', 'secondaryAtDos', 'crossoverStatus', 'postingVerified',
] as const;

export interface Candidate { value: unknown; evidenceId: string; sourceClass: string; locator: unknown; observedAt: string }

export interface ResolvedFact {
  factKey: string;
  value: unknown;
  status: FactStatus;
  evidenceId: string | null;
  locator: unknown;
  candidates: Candidate[];
}

export interface FactRow extends ResolvedFact { version: number; accountRevision: number; createdAt: string; unit: string | null }

interface ObsRow { fact_key: string; value: string; unit: string | null; evidence_id: string; locator: string; source_class: string; observed_at: string }

interface AccountIdentity { claim_reference: string; patient_token: string; service_date: string }

function same(a: unknown, b: unknown) {
  return canonicalJson(a) === canonicalJson(b);
}

function resolveKey(key: string, obs: ObsRow[]): ResolvedFact {
  const candidates: Candidate[] = obs.map((o) => ({ value: JSON.parse(o.value), evidenceId: o.evidence_id, sourceClass: o.source_class, locator: JSON.parse(o.locator), observedAt: o.observed_at }));
  if (!candidates.length) return { factKey: key, value: null, status: 'missing', evidenceId: null, locator: null, candidates };
  const reviewerIdx = candidates.map((c) => c.sourceClass).lastIndexOf('reviewer');
  if (reviewerIdx >= 0) {
    const decided = candidates[reviewerIdx];
    // A later non-reviewer source that disagrees reopens the conflict.
    const laterDisagree = candidates.slice(reviewerIdx + 1).some((c) => !same(c.value, decided.value));
    if (laterDisagree) return { factKey: key, value: null, status: 'conflicting', evidenceId: null, locator: null, candidates };
    return { factKey: key, value: decided.value, status: 'verified', evidenceId: decided.evidenceId, locator: decided.locator, candidates };
  }
  const distinct = candidates.filter((c, i) => candidates.findIndex((d) => same(d.value, c.value)) === i);
  if (distinct.length > 1) return { factKey: key, value: null, status: 'conflicting', evidenceId: null, locator: null, candidates };
  const documentary = candidates.find((c) => c.sourceClass === 'document' || c.sourceClass === 'structured');
  if (documentary) return { factKey: key, value: documentary.value, status: 'verified', evidenceId: documentary.evidenceId, locator: documentary.locator, candidates };
  const reported = candidates[candidates.length - 1];
  return { factKey: key, value: reported.value, status: 'reported', evidenceId: reported.evidenceId, locator: reported.locator, candidates };
}

// Identity is a control, not a model judgement: the EOB must name the same claim,
// patient token and date of service as the imported account.
function resolveIdentity(account: AccountIdentity, byKey: Map<string, ObsRow[]>): ResolvedFact {
  const pairs: [string, string, keyof AccountIdentity][] = [
    ['claimReference', 'claim reference', 'claim_reference'],
    ['eobPatientToken', 'patient token', 'patient_token'],
    ['eobServiceDate', 'date of service', 'service_date'],
  ];
  const checks: { field: string; account: string; source: unknown; match: boolean; evidenceId: string }[] = [];
  for (const [key, label, col] of pairs) {
    for (const o of byKey.get(key) ?? []) {
      if (o.source_class !== 'document') continue;
      const v = JSON.parse(o.value);
      checks.push({ field: label, account: account[col], source: v, match: v === account[col], evidenceId: o.evidence_id });
    }
  }
  const fields = new Set(checks.map((c) => c.field));
  if (fields.size < pairs.length) {
    return { factKey: 'identityVerified', value: null, status: 'missing', evidenceId: null, locator: { checks }, candidates: [] };
  }
  const ok = checks.every((c) => c.match);
  const evidenceId = (checks.find((c) => !c.match) ?? checks[0]).evidenceId;
  return { factKey: 'identityVerified', value: ok, status: 'verified', evidenceId, locator: { checks }, candidates: [] };
}

export function currentFacts(db: Db, scope: Scope, accountId: string): Map<string, FactRow> {
  const rows = all<{ fact_key: string; version: number; value: string | null; unit: string | null; status: FactStatus; evidence_id: string | null; locator: string | null; candidates: string; account_revision: number; created_at: string }>(db,
    `SELECT f.* FROM facts f WHERE f.tenant_id=? AND f.client_id=? AND f.account_id=?
     AND f.version = (SELECT MAX(version) FROM facts g WHERE g.tenant_id=f.tenant_id AND g.client_id=f.client_id AND g.account_id=f.account_id AND g.fact_key=f.fact_key)`,
    scope.tenantId, scope.clientId, accountId);
  const map = new Map<string, FactRow>();
  for (const r of rows) {
    map.set(r.fact_key, {
      factKey: r.fact_key, version: r.version, value: r.value === null ? null : JSON.parse(r.value), unit: r.unit, status: r.status,
      evidenceId: r.evidence_id, locator: r.locator ? JSON.parse(r.locator) : null, candidates: JSON.parse(r.candidates),
      accountRevision: r.account_revision, createdAt: r.created_at,
    });
  }
  return map;
}

export function factHistory(db: Db, scope: Scope, accountId: string) {
  return all<{ fact_key: string; version: number; value: string | null; status: string; evidence_id: string | null; account_revision: number; created_at: string }>(db,
    'SELECT fact_key, version, value, status, evidence_id, account_revision, created_at FROM facts WHERE tenant_id=? AND client_id=? AND account_id=? ORDER BY fact_key, version',
    scope.tenantId, scope.clientId, accountId).map((r) => ({ ...r, value: r.value === null ? null : JSON.parse(r.value) }));
}

// Recomputes every fact from observations. Writes a new version only for facts
// whose resolution changed, then bumps the account revision if anything changed.
export function resolveFacts(db: Db, scope: Scope, accountId: string): { changed: string[]; revision: number } {
  const account = one<AccountIdentity & { revision: number }>(db,
    'SELECT claim_reference, patient_token, service_date, revision FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?',
    scope.tenantId, scope.clientId, accountId)!;
  const obs = all<ObsRow>(db, 'SELECT fact_key, value, unit, evidence_id, locator, source_class, observed_at FROM observations WHERE tenant_id=? AND client_id=? AND account_id=? ORDER BY observed_at, rowid',
    scope.tenantId, scope.clientId, accountId);
  const byKey = new Map<string, ObsRow[]>();
  for (const o of obs) byKey.set(o.fact_key, [...(byKey.get(o.fact_key) ?? []), o]);
  const current = currentFacts(db, scope, accountId);
  const resolved = FACT_KEYS.map((k) => (k === 'identityVerified' ? resolveIdentity(account, byKey) : resolveKey(k, byKey.get(k) ?? [])));
  const changed = resolved.filter((r) => {
    const c = current.get(r.factKey);
    return !c || c.status !== r.status || !same(c.value, r.value) || c.evidenceId !== r.evidenceId || !same(c.candidates, r.candidates);
  });
  if (!changed.length) return { changed: [], revision: account.revision };
  const revision = account.revision + 1;
  run(db, 'UPDATE accounts SET revision=?, updated_at=? WHERE tenant_id=? AND client_id=? AND account_id=?', revision, nowIso(), scope.tenantId, scope.clientId, accountId);
  for (const r of changed) {
    const version = (current.get(r.factKey)?.version ?? 0) + 1;
    const unit = (byKey.get(r.factKey) ?? [])[0]?.unit ?? null;
    run(db, 'INSERT INTO facts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, accountId, r.factKey, version,
      r.value === null ? null : JSON.stringify(r.value), unit, r.status, r.evidenceId, r.locator ? canonicalJson(r.locator) : null,
      canonicalJson(r.candidates), revision, nowIso());
  }
  emitConflicts(db, scope, accountId, changed);
  return { changed: changed.map((c) => c.factKey), revision };
}
