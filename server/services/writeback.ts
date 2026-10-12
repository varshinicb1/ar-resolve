// Note write-back (FR12). A write-back is its own action class ('note_writeback',
// risk class 'administrative_note') with its own permissions, separate from
// financial requests. It travels the same proposal -> hash-bound review -> outbox
// path. The preview names the exact PM record, record version and field. The
// executor re-checks the account revision; the simulated PM rejects a stale record
// version; and a write is reported only after read-back matches the approved text.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { canonicalJson, conflict, forbidden, hashJson, invalid, newId, notFound, now, nowIso, sha256, AppError } from '../util.ts';
import { audit } from './audit.ts';
import { open as openSealed, seal } from './phi.ts';
import { can, requirePerm, type Scope } from './auth.ts';
import { getAccountRow, PROPOSAL_TTL_HOURS } from './workflow.ts';
import { reconcile, type OutboxRow } from './outbox.ts';
import { ensurePmRecord, pmRecord, PM_FIELDS, readBack } from '../connectors/sim-pm.ts';
import { commitmentsFor, listFollowups } from './followup.ts';
import { listLedger } from './outcomes.ts';

const FIELD = 'account_notes';
const NOTE_TYPE = 'ar_followup';
const MAX_NOTE = 4000;

interface ActionRow { action_id: string; account_id: string; run_id: string; kind: string; state: string; note_draft: string; payload: string; payload_sha256: string; expected_revision: number; created_by: string; created_at: string; expires_at: string }

function latestSource(db: Db, scope: Scope, accountId: string, sourceActionId?: string): ActionRow {
  const r = sourceActionId
    ? one<ActionRow>(db, `SELECT * FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND action_id=? AND kind <> 'note_writeback'`, scope.tenantId, scope.clientId, accountId, sourceActionId)
    : one<ActionRow>(db, `SELECT * FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND kind <> 'note_writeback' ORDER BY created_at DESC, rowid DESC LIMIT 1`, scope.tenantId, scope.clientId, accountId);
  if (!r) throw conflict('no_draft', 'There is no system-drafted note for this account yet. Run an investigation first.');
  return r;
}

// What a write-back would touch, before anything is proposed.
export function writebackTarget(db: Db, scope: Scope, accountId: string) {
  requirePerm(scope, 'view');
  const a = getAccountRow(db, scope, accountId);
  const rec = tx(db, () => ensurePmRecord(db, scope.tenantId, scope.clientId, accountId, a.external_id));
  const src = one<ActionRow>(db, `SELECT * FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND kind <> 'note_writeback' ORDER BY created_at DESC, rowid DESC LIMIT 1`, scope.tenantId, scope.clientId, accountId);
  return {
    system: 'Simulated PM (synthetic)', record: rec, field: FIELD, fieldLabel: PM_FIELDS[FIELD], noteType: NOTE_TYPE, mode: 'append',
    accountRevision: a.revision, draft: src ? { sourceActionId: src.action_id, text: src.note_draft, sha256: sha256(src.note_draft) } : null,
    permissions: { propose: can(scope, 'propose_writeback'), approve: can(scope, 'approve_writeback') },
  };
}

export function proposeWriteback(db: Db, scope: Scope, accountId: string, body: { sourceActionId?: string; text?: string; editReason?: string; expectedRevision?: number }) {
  requirePerm(scope, 'propose_writeback');
  return tx(db, () => {
    const a = getAccountRow(db, scope, accountId);
    if (typeof body.expectedRevision === 'number' && body.expectedRevision !== a.revision) throw conflict('stale_revision', 'The account changed since you opened it. Refresh before drafting a write-back.', { currentRevision: a.revision });
    if (a.state === 'blocked') throw conflict('identity_blocked', 'Identity conflict: no write-back to the PM record until identity is resolved');
    const src = latestSource(db, scope, accountId, body.sourceActionId);
    const original = src.note_draft;
    const text = (body.text ?? original).replace(/\r\n/g, '\n');
    if (!text.trim()) throw invalid('Note text is empty');
    if (text.length > MAX_NOTE) throw invalid(`Note text exceeds ${MAX_NOTE} characters`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw invalid('Note text contains control characters');
    const edited = text !== original;
    const editReason = String(body.editReason ?? '').trim();
    if (edited && editReason.length < 5) throw invalid('Edited notes need a reason for the edit');
    const rec = ensurePmRecord(db, scope.tenantId, scope.clientId, accountId, a.external_id);
    const payload = {
      schema: 'ar-resolve.writeback.v1', environment: 'synthetic', actionKind: 'note_writeback', riskClass: 'administrative_note',
      account: { tenantId: scope.tenantId, clientId: scope.clientId, accountId, externalId: a.external_id, claimReference: a.claim_reference, payerId: a.payer_id },
      destination: { connector: 'sim_pm', system: 'Simulated PM (synthetic)', recordId: rec.pmRecordId, recordVersion: rec.recordVersion, field: FIELD, noteType: NOTE_TYPE, mode: 'append' },
      note: { text, sha256: sha256(text), originalDraftSha256: sha256(original), edited, sourceActionId: src.action_id },
      basis: { accountRevision: a.revision },
    };
    const actionId = newId('act');
    const expires = new Date(now().getTime() + PROPOSAL_TTL_HOURS * 3600_000).toISOString();
    // Any earlier write-back still awaiting review for this account is superseded.
    for (const prev of all<{ action_id: string }>(db, `SELECT action_id FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND kind='note_writeback' AND state='awaiting_review'`, scope.tenantId, scope.clientId, accountId)) {
      run(db, `UPDATE proposed_actions SET state='superseded', updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=?`, nowIso(), scope.tenantId, scope.clientId, prev.action_id);
      audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'action', objectId: prev.action_id, accountId, eventType: 'proposal_superseded', details: { by: actionId, kind: 'note_writeback' } });
    }
    run(db, 'INSERT INTO proposed_actions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, actionId, accountId, src.run_id, a.revision,
      'note_writeback', 'administrative_note', 'sim_pm', canonicalJson(payload), hashJson(payload), text, 'awaiting_review', expires, scope.userId, nowIso(), nowIso());
    run(db, 'INSERT INTO note_writebacks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, actionId, accountId, src.action_id, seal(original), sha256(original),
      seal(text), sha256(text), edited ? 1 : 0, edited ? editReason : null, edited ? scope.userId : null, scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'action', objectId: actionId, accountId,
      eventType: 'writeback_proposed', details: { payloadSha256: hashJson(payload), pmRecordId: rec.pmRecordId, recordVersion: rec.recordVersion, field: FIELD, edited, editReason: edited ? editReason : null, expectedRevision: a.revision } });
    return { actionId, payloadSha256: hashJson(payload), accountRevision: a.revision, edited };
  });
}

export interface WritebackReview { decision: 'approved' | 'rejected'; rationale: string; payloadSha256: string; accountRevision: number }

export function reviewWriteback(db: Db, scope: Scope, actionId: string, input: WritebackReview) {
  requirePerm(scope, 'approve_writeback');
  if (input.decision !== 'approved' && input.decision !== 'rejected') throw invalid('decision must be approved or rejected');
  if (!input.rationale || input.rationale.trim().length < 5) throw invalid('A rationale is required for every decision');
  if (typeof input.payloadSha256 !== 'string' || typeof input.accountRevision !== 'number') throw invalid('payloadSha256 and accountRevision are required');
  return tx(db, () => {
    const act = one<ActionRow>(db, `SELECT * FROM proposed_actions WHERE tenant_id=? AND client_id=? AND action_id=? AND kind='note_writeback'`, scope.tenantId, scope.clientId, actionId);
    if (!act) throw notFound('Write-back');
    const account = getAccountRow(db, scope, act.account_id);
    if (input.payloadSha256 !== act.payload_sha256) throw conflict('payload_mismatch', 'The note you reviewed is not the stored write-back. Refresh before deciding.');
    if (input.accountRevision !== account.revision || act.expected_revision !== account.revision) {
      throw conflict('stale_review', 'The account changed after this write-back was drafted. Draft it again from current evidence.', { proposalRevision: act.expected_revision, accountRevision: account.revision });
    }
    if (act.state !== 'awaiting_review') throw conflict('not_reviewable', `This write-back is already ${act.state}`);
    if (act.created_by === scope.userId) throw forbidden('Separation of duties: the person who drafted or edited the note cannot approve it');
    if (input.decision === 'approved') {
      if (act.expires_at <= nowIso()) throw new AppError(422, 'prerequisites_failed', 'This write-back draft has expired');
      const payload = JSON.parse(act.payload);
      if (hashJson(payload) !== act.payload_sha256) throw new AppError(422, 'prerequisites_failed', 'Payload integrity check failed');
      const rec = pmRecord(db, scope.tenantId, scope.clientId, act.account_id);
      if (!rec || rec.recordVersion !== payload.destination.recordVersion) {
        throw conflict('pm_record_changed', `The PM record changed since the preview (version ${payload.destination.recordVersion} -> ${rec?.recordVersion ?? 'missing'}). Draft the write-back again.`);
      }
    }
    const changed = run(db, `UPDATE proposed_actions SET state=?, updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=? AND state='awaiting_review' AND expected_revision=?`,
      input.decision, nowIso(), scope.tenantId, scope.clientId, actionId, account.revision);
    if (changed !== 1) throw conflict('not_reviewable', 'Another decision was recorded first');
    const decisionId = newId('dec');
    run(db, 'INSERT INTO review_decisions VALUES (?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, decisionId, actionId, input.decision, scope.userId, input.rationale.trim(),
      act.payload_sha256, account.revision, nowIso());
    let idempotencyKey: string | null = null;
    if (input.decision === 'approved') {
      idempotencyKey = `${scope.tenantId}:${scope.clientId}:${actionId}:${act.payload_sha256.slice(0, 16)}`;
      run(db, 'INSERT INTO action_outbox (tenant_id, client_id, action_id, idempotency_key, connector, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        scope.tenantId, scope.clientId, actionId, idempotencyKey, 'sim_pm', 'pending', nowIso(), nowIso());
    }
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'action', objectId: actionId, accountId: act.account_id,
      eventType: `proposal_${input.decision}`, details: { decisionId, kind: 'note_writeback', payloadSha256: act.payload_sha256, accountRevision: account.revision, rationale: input.rationale.trim(), idempotencyKey } });
    return { decisionId, decision: input.decision, idempotencyKey };
  });
}

// Supervisor-triggered read-back for an uncertain write-back (no resubmission).
export function readBackNow(db: Db, scope: Scope, actionId: string) {
  requirePerm(scope, 'operate');
  const o = one<OutboxRow>(db, `SELECT * FROM action_outbox WHERE tenant_id=? AND client_id=? AND action_id=? AND connector='sim_pm'`, scope.tenantId, scope.clientId, actionId);
  if (!o) throw notFound('Write-back dispatch');
  if (o.state !== 'uncertain') throw conflict('not_uncertain', `This write-back is ${o.state}; read-back reconciliation applies only to uncertain write-backs`);
  reconcile(db, o);
  return one<{ state: string; last_error: string | null }>(db, 'SELECT state, last_error FROM action_outbox WHERE tenant_id=? AND client_id=? AND action_id=?', scope.tenantId, scope.clientId, actionId);
}

// Write-back state shown to people. Nothing is "written" until read-back matched.
function displayState(actionState: string, outbox: { state: string; held_at: string | null } | null | undefined): string {
  if (!outbox) return actionState;
  if (outbox.state === 'pending') return outbox.held_at ? 'held' : 'queued';
  if (outbox.state === 'uncertain') return 'writeback_uncertain';
  if (outbox.state === 'confirmed') return 'written_verified';
  return outbox.state; // dispatching, blocked, failed
}

function lineDiff(a: string, b: string) {
  const A = a.split('\n'), B = b.split('\n');
  return { removed: A.filter((l) => !B.includes(l)), added: B.filter((l) => !A.includes(l)) };
}

export function listWritebacks(db: Db, scope: Scope, accountId: string) {
  requirePerm(scope, 'view');
  getAccountRow(db, scope, accountId);
  const rows = all<ActionRow & { original_draft: string; final_text: string; edited: number; edit_reason: string | null; edited_by: string | null; source_action_id: string }>(db,
    `SELECT p.*, w.original_draft, w.final_text, w.edited, w.edit_reason, w.edited_by, w.source_action_id FROM proposed_actions p
     JOIN note_writebacks w ON w.tenant_id=p.tenant_id AND w.client_id=p.client_id AND w.action_id=p.action_id
     WHERE p.tenant_id=? AND p.client_id=? AND p.account_id=? ORDER BY p.created_at DESC, p.rowid DESC`, scope.tenantId, scope.clientId, accountId);
  return rows.map((raw) => {
    const r = { ...raw, original_draft: openSealed(raw.original_draft), final_text: openSealed(raw.final_text) };
    const outbox = one<{ state: string; attempts: number; external_reference: string | null; last_error: string | null; idempotency_key: string; held_at: string | null; hold_reason: string | null; receipt_evidence_id: string | null }>(db,
      'SELECT state, attempts, external_reference, last_error, idempotency_key, held_at, hold_reason, receipt_evidence_id FROM action_outbox WHERE tenant_id=? AND client_id=? AND action_id=?', scope.tenantId, scope.clientId, r.action_id);
    const decisions = all<{ decision: string; actor_id: string; rationale: string; created_at: string }>(db,
      'SELECT decision, actor_id, rationale, created_at FROM review_decisions WHERE tenant_id=? AND client_id=? AND action_id=? ORDER BY created_at', scope.tenantId, scope.clientId, r.action_id);
    const payload = JSON.parse(r.payload);
    const rb = outbox && outbox.state !== 'pending' ? readBack(db, outbox.idempotency_key, payload) : null;
    return {
      actionId: r.action_id, state: r.state, displayState: displayState(r.state, outbox), payload, payloadSha256: r.payload_sha256, expectedRevision: r.expected_revision,
      destination: payload.destination, originalDraft: r.original_draft, finalText: r.final_text, edited: !!r.edited, editReason: r.edit_reason, editedBy: r.edited_by,
      diff: r.edited ? lineDiff(r.original_draft, r.final_text) : null, sourceActionId: r.source_action_id, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at,
      approver: decisions.find((d) => d.decision === 'approved')?.actor_id ?? null, decisions, outbox,
      readBack: rb ? { found: rb.found, matched: rb.matched, problems: rb.problems } : null,
    };
  });
}

export function accountOperationsExport(db: Db, scope: Scope, accountId: string) {
  return {
    writebacks: listWritebacks(db, scope, accountId),
    commitments: commitmentsFor(db, scope, accountId),
    followups: listFollowups(db, scope, { accountId }).items,
    outcomeLedger: listLedger(db, scope, accountId).entries,
  };
}
