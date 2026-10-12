// Evidence storage and deterministic extraction of observations.
// Source content is untrusted data: extractors read only typed fields at known
// paths and never interpret free text as instructions.
import { type Db, all, one, run } from '../db/db.ts';
import { canonicalJson, invalid, newId, nowIso, sha256 } from '../util.ts';
import { audit } from './audit.ts';
import type { Scope } from './auth.ts';
import { integrationObservations, isIntegrationKind, type IntegrationKind } from '../connectors/observations.ts';

export type EvidenceKind = 'eob' | 'eligibility' | 'clearinghouse_status' | 'pm_posting' | 'call_transcript' | 'reviewer_correction' | 'action_receipt' | 'import_row' | IntegrationKind;
export type SourceClass = 'document' | 'structured' | 'transcript' | 'reviewer';

export interface EvidenceRow {
  evidence_id: string; account_id: string; kind: EvidenceKind; title: string; source: string; content: string;
  sha256: string; observed_at: string; effective_at: string | null; created_by: string;
}

export interface Observation {
  factKey: string;
  value: unknown;
  unit?: string | null;
  locator: Record<string, unknown>;
  sourceClass: SourceClass;
}

interface TranscriptTurn { turn: number; speaker: 'agent' | 'rep'; text: string; extracts?: Record<string, unknown> }

const CENTS_KEYS = new Set(['allowedCents', 'appliedCents', 'limitCents', 'metBeforeCents']);

function at(obj: unknown, path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}

function pick(content: unknown, out: Observation[], factKey: string, path: (string | number)[], sourceClass: SourceClass) {
  const value = at(content, path);
  if (value === undefined) return; // absent stays absent: never default to zero/false
  out.push({ factKey, value, unit: CENTS_KEYS.has(factKey) ? 'USD_cents' : null, locator: { path: path.join('.') }, sourceClass });
}

export function extractObservations(kind: EvidenceKind, content: unknown): Observation[] {
  const out: Observation[] = [];
  switch (kind) {
    case 'eob': {
      pick(content, out, 'claimReference', ['claimReference'], 'document');
      pick(content, out, 'eobPatientToken', ['patientToken'], 'document');
      pick(content, out, 'eobServiceDate', ['serviceDate'], 'document');
      pick(content, out, 'allowedCents', ['lines', 0, 'allowedCents'], 'document');
      const adjustments = at(content, ['lines', 0, 'adjustments']);
      if (Array.isArray(adjustments)) {
        const idx = adjustments.findIndex((a) => a && a.carc === '1');
        if (idx >= 0) {
          pick(content, out, 'adjustmentGroup', ['lines', 0, 'adjustments', idx, 'group'], 'document');
          pick(content, out, 'appliedCents', ['lines', 0, 'adjustments', idx, 'amountCents'], 'document');
        }
      }
      break;
    }
    case 'eligibility':
      pick(content, out, 'planDesign', ['planDesign'], 'structured');
      pick(content, out, 'limitCents', ['deductibleLimitCents'], 'structured');
      pick(content, out, 'metBeforeCents', ['metBeforeThisClaimCents'], 'structured');
      pick(content, out, 'secondaryAtDos', ['secondaryAtDos'], 'structured');
      break;
    case 'clearinghouse_status':
      pick(content, out, 'crossoverStatus', ['crossoverStatus'], 'structured');
      break;
    case 'pm_posting':
      pick(content, out, 'postingVerified', ['matchesEob'], 'structured');
      break;
    case 'call_transcript': {
      // Only structured extracts attached to representative turns become observations.
      // In Phase 0 these are pre-scripted (mocked extraction, no model).
      const turns = at(content, ['turns']);
      if (Array.isArray(turns)) {
        for (const t of turns as TranscriptTurn[]) {
          if (t.speaker !== 'rep' || !t.extracts) continue;
          for (const [k, v] of Object.entries(t.extracts)) {
            out.push({ factKey: k, value: v, unit: CENTS_KEYS.has(k) ? 'USD_cents' : null, locator: { turn: t.turn, speaker: 'rep', quote: t.text }, sourceClass: 'transcript' });
          }
        }
      }
      break;
    }
    case 'reviewer_correction': {
      const c = content as { factKey: string; value: unknown };
      out.push({ factKey: c.factKey, value: c.value, unit: CENTS_KEYS.has(c.factKey) ? 'USD_cents' : null, locator: { path: 'value' }, sourceClass: 'reviewer' });
      break;
    }
    default:
      // Integration evidence (EDI 835/277/271, FHIR): see server/connectors/observations.ts.
      if (isIntegrationKind(kind)) out.push(...integrationObservations(kind, content));
  }
  return out;
}

export interface AddEvidenceInput {
  accountId: string;
  kind: EvidenceKind;
  title: string;
  source: string;
  content: unknown;
  effectiveAt?: string | null;
}

// Returns null when byte-identical content from the same source is already stored.
export function addEvidence(db: Db, scope: Scope, e: AddEvidenceInput): { evidenceId: string; observations: number } | null {
  const body = canonicalJson(e.content);
  const hash = sha256(body);
  const dup = one(db, 'SELECT 1 FROM evidence WHERE tenant_id=? AND client_id=? AND account_id=? AND sha256=? AND kind=?',
    scope.tenantId, scope.clientId, e.accountId, hash, e.kind);
  if (dup) return null;
  const evidenceId = newId('ev');
  const observedAt = nowIso();
  run(db, 'INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, e.accountId, evidenceId,
    e.kind, e.title, e.source, body, hash, observedAt, e.effectiveAt ?? null, scope.userId);
  const obs = extractObservations(e.kind, e.content);
  for (const o of obs) {
    run(db, 'INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, e.accountId, newId('ob'),
      o.factKey, JSON.stringify(o.value), o.unit ?? null, evidenceId, canonicalJson(o.locator), o.sourceClass, observedAt);
  }
  audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'evidence', objectId: evidenceId,
    accountId: e.accountId, eventType: 'evidence_collected', details: { kind: e.kind, sha256: hash, observations: obs.length } });
  return { evidenceId, observations: obs.length };
}

export function listEvidence(db: Db, scope: Scope, accountId: string) {
  return all<EvidenceRow>(db, 'SELECT * FROM evidence WHERE tenant_id=? AND client_id=? AND account_id=? ORDER BY observed_at, rowid',
    scope.tenantId, scope.clientId, accountId).map((r) => ({
    evidenceId: r.evidence_id, kind: r.kind, title: r.title, source: r.source, content: JSON.parse(r.content),
    sha256: r.sha256, observedAt: r.observed_at, effectiveAt: r.effective_at, createdBy: r.created_by,
  }));
}

export function validateCorrectionValue(factKey: string, value: unknown): void {
  if (CENTS_KEYS.has(factKey)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw invalid(`${factKey} must be a non-negative integer number of cents`);
    return;
  }
  const enums: Record<string, unknown[]> = {
    secondaryAtDos: ['active', 'none', 'unknown'],
    crossoverStatus: ['crossed', 'not_crossed', 'unknown'],
    adjustmentGroup: ['PR', 'CO', 'OA', 'PI', 'CR'],
    postingVerified: [true, false],
  };
  if (enums[factKey]) {
    if (!enums[factKey].includes(value)) throw invalid(`${factKey} must be one of ${enums[factKey].join(', ')}`);
    return;
  }
  if (factKey === 'planDesign' || factKey === 'claimReference') {
    if (typeof value !== 'string' || !value.trim()) throw invalid(`${factKey} must be a non-empty string`);
    return;
  }
  throw invalid(`${factKey} cannot be corrected directly`);
}
