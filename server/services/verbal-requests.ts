// Cross-channel duplicate guard (ADR 0060). A representative who verbally accepts a
// request on a payer call has the request; the same request must not be approved and
// sent again through the outbox until the acceptance is reconciled. Reconciled means:
//   - a payer receipt (action_receipt evidence) recorded after the acceptance,
//   - an adjudication change or reversal in the outcome ledger after the acceptance,
//   - a later call on which the payer reported no such request on file, or
//   - an explicit reviewer release with a reason (append-only, audited).
// The guard is versioned data; it is checked at approval (review.ts) and again at
// dispatch (outbox.ts).
import { type Db, all, one, run, tx } from '../db/db.ts';
import { conflict, invalid, newId, notFound, nowIso } from '../util.ts';
import { audit } from './audit.ts';
import { requirePerm, type Scope } from './auth.ts';

export const VERBAL_GUARD = {
  id: 'VERBAL01', version: 1,
  // Verbal commitment kind (voice_answers.reprocessingCommitment value.kind) -> external action kinds of the same class.
  classes: { reprocessing_request: ['clarify_allocation'] } as Record<string, string[]>,
  reconciledBy: ['action_receipt evidence after the acceptance', 'adjudication_changed or reversal ledger entry after the acceptance',
    'a later call found no request on file', 'reviewer release with reason'],
} as const;

const guardedKinds = new Set(Object.values(VERBAL_GUARD.classes).flat());
export const isGuardedKind = (kind: string) => guardedKinds.has(kind);

export interface VerbalRequest {
  answerId: string; callId: string; acceptedAt: string; kind: string; actionKinds: string[];
  reconciled: boolean; reconciledBy: { type: 'receipt' | 'adjudication' | 'no_request_on_file' | 'reviewer_override'; ref: string; at: string; by?: string; reason?: string } | null;
}

type Ids = { tenantId: string; clientId: string };

export function verbalRequests(db: Db, s: Ids, accountId: string): VerbalRequest[] {
  const rows = all<{ answer_id: string; call_id: string; created_at: string; value: string }>(db, `SELECT a.answer_id, a.call_id, a.created_at, a.value FROM voice_answers a
    JOIN voice_calls c ON c.tenant_id=a.tenant_id AND c.client_id=a.client_id AND c.call_id=a.call_id
    WHERE a.tenant_id=? AND a.client_id=? AND c.account_id=? AND a.answer_key='reprocessingCommitment' ORDER BY a.created_at`, s.tenantId, s.clientId, accountId);
  const out: VerbalRequest[] = [];
  for (const r of rows) {
    const v = JSON.parse(r.value ?? 'null') as { kind?: string; status?: string } | null;
    if (!v || v.status !== 'accepted_by_rep' || !v.kind || !VERBAL_GUARD.classes[v.kind]) continue;
    const at = r.created_at;
    let by: VerbalRequest['reconciledBy'] = null;
    const o = one<{ override_id: string; created_at: string; created_by: string; reason: string }>(db,
      'SELECT override_id, created_at, created_by, reason FROM verbal_request_overrides WHERE tenant_id=? AND client_id=? AND answer_id=?', s.tenantId, s.clientId, r.answer_id);
    if (o) by = { type: 'reviewer_override', ref: o.override_id, at: o.created_at, by: o.created_by, reason: o.reason };
    const rc = by ? null : one<{ evidence_id: string; observed_at: string }>(db, `SELECT evidence_id, observed_at FROM evidence WHERE tenant_id=? AND client_id=? AND account_id=? AND kind='action_receipt' AND observed_at > ?
      ORDER BY observed_at LIMIT 1`, s.tenantId, s.clientId, accountId, at);
    if (rc) by = { type: 'receipt', ref: rc.evidence_id, at: rc.observed_at };
    const adj = by ? null : one<{ entry_id: string; recorded_at: string }>(db, `SELECT entry_id, recorded_at FROM outcome_ledger WHERE tenant_id=? AND client_id=? AND account_id=?
      AND entry_type IN ('adjudication_changed','reversal') AND recorded_at > ? ORDER BY seq LIMIT 1`, s.tenantId, s.clientId, accountId, at);
    if (adj) by = { type: 'adjudication', ref: adj.entry_id, at: adj.recorded_at };
    const none = by ? null : one<{ event_id: string; created_at: string }>(db, `SELECT event_id, event_at AS created_at FROM audit_events WHERE tenant_id=? AND client_id=? AND object_type='voice_call' AND object_id=?
      AND event_type='voice_call_reconciled' AND json_extract(details, '$.outcome')='no_request_at_payer' LIMIT 1`, s.tenantId, s.clientId, r.call_id);
    if (none) by = { type: 'no_request_on_file', ref: none.event_id, at: none.created_at };
    out.push({ answerId: r.answer_id, callId: r.call_id, acceptedAt: at, kind: v.kind, actionKinds: VERBAL_GUARD.classes[v.kind], reconciled: !!by, reconciledBy: by });
  }
  return out;
}

/** Unreconciled verbal acceptances that block a new external request of `actionKind`. */
export function openVerbalRequests(db: Db, s: Ids, accountId: string, actionKind: string): VerbalRequest[] {
  if (!isGuardedKind(actionKind)) return [];
  return verbalRequests(db, s, accountId).filter((v) => !v.reconciled && v.actionKinds.includes(actionKind));
}

export function listVerbalRequests(db: Db, scope: Scope, accountId: string) {
  requirePerm(scope, 'view');
  if (!one(db, 'SELECT 1 FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', scope.tenantId, scope.clientId, accountId)) throw notFound('Account');
  return { guard: VERBAL_GUARD, requests: verbalRequests(db, scope, accountId) };
}

export function releaseVerbalRequest(db: Db, scope: Scope, answerId: string, reason: string) {
  requirePerm(scope, 'review');
  const text = String(reason ?? '').trim();
  if (text.length < 15) throw invalid('A reason of at least 15 characters is required to release a verbal request');
  return tx(db, () => {
    const a = one<{ account_id: string; call_id: string }>(db, `SELECT c.account_id, a.call_id FROM voice_answers a JOIN voice_calls c ON c.tenant_id=a.tenant_id AND c.client_id=a.client_id AND c.call_id=a.call_id
      WHERE a.tenant_id=? AND a.client_id=? AND a.answer_id=?`, scope.tenantId, scope.clientId, answerId);
    if (!a) throw notFound('Verbal request');
    const v = verbalRequests(db, scope, a.account_id).find((x) => x.answerId === answerId);
    if (!v) throw notFound('Verbal request');
    if (v.reconciled) throw conflict('already_reconciled', `This verbal request is already reconciled (${v.reconciledBy!.type})`, v.reconciledBy);
    const overrideId = newId('vro');
    run(db, 'INSERT INTO verbal_request_overrides VALUES (?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, overrideId, a.account_id, a.call_id, answerId,
      VERBAL_GUARD.version, text, scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'voice_call', objectId: a.call_id, accountId: a.account_id,
      eventType: 'verbal_request_released', details: { answerId, overrideId, reason: text, guard: `${VERBAL_GUARD.id}@${VERBAL_GUARD.version}` } });
    return { overrideId, answerId, accountId: a.account_id };
  });
}
