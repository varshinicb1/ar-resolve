// Ported from clinic-receptionist src/governance.ts (purgeExpired, deletePatientData), same owner.
//
// The origin purged transcripts, session snapshots and expired memory on a daily cron with fixed
// periods (30 / 7 days), kept the audit log ("it must outlive the data it describes") and deleted
// one patient's memory, preferences and transcripts on request. Adapted for AR Resolve (ADR 0080):
//
//   - Retention periods are versioned policy data per tenant/client (retention_policies), changed
//     only by manage_retention with a reason and audited. The built-in defaults are PLACEHOLDERS
//     pending the customer contract and counsel; they are not legal requirements and the code says so
//     wherever they are shown.
//   - Nothing hash-bound is deleted. Free text and raw content are replaced by tombstones that carry
//     the SHA-256 of what was removed (sealed-store.ts); rows, hashes, ids and the audit chain stay,
//     so evidence provenance, approvals and the audit log remain verifiable. Mutable copies with no
//     provenance role (the simulated notification sink, expired sessions) are deleted outright.
//   - Account deletion is a two-person flow: a supervisor requests, a different person with
//     approve_data_deletion approves, and approval executes it in one transaction.
//   - audit_events, outcome_ledger and analytics_events are never modified (their triggers are
//     unchanged). Structured facts and observations (amounts, dates, codes) are kept as the
//     client's financial record, like the origin kept appointments.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { AppError, canonicalJson, conflict, forbidden, hashJson, invalid, newId, notFound, now, nowIso, sha256 } from '../util.ts';
import { audit } from './audit.ts';
import { can, requirePerm, type Scope } from './auth.ts';
import { open } from './phi.ts';
import { isTombstone, openPayload, parseTombstone, rewrite, sealedColumn, tombstoneFor, tombstonePayload, type TombstoneReason } from './sealed-store.ts';
import { ACTIVE_CALL_STATES } from './voice/policy.ts';

export const RETENTION_VERSION = 'retention.v1';
export const PLACEHOLDER_BASIS = 'Placeholder pending customer contract/counsel. Not a legal requirement; set per customer agreement.';

export const RETENTION_CLASSES = ['transcripts', 'call_events', 'evidence_raw', 'notifications', 'sessions', 'recordings'] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export const CLASS_INFO: Record<RetentionClass, { label: string; action: string }> = {
  transcripts: { label: 'Call transcripts (evidence of kind call_transcript)', action: 'Content replaced by a tombstone; evidence row, hash and observations kept' },
  call_events: { label: 'Call event text and hand-off packets', action: 'Text replaced by a tombstone; event rows, sequence and timing kept' },
  evidence_raw: { label: 'Raw content of other evidence and EDI files', action: 'Content replaced by a tombstone; hashes and extracted observations kept' },
  notifications: { label: 'Notification payloads and simulated sink messages', action: 'Sent payloads tombstoned; sink copies deleted' },
  sessions: { label: 'Expired sign-in sessions (deployment-wide; shortest period of any client applies)', action: 'Deleted' },
  recordings: { label: 'Call recordings (simulated metadata and storage reference)', action: 'Storage reference tombstoned; recording marked purged' },
};

export interface RetentionPolicy {
  schema: 'ar-resolve.retention.v1';
  basis: string;
  classes: Record<RetentionClass, { days: number }>;
}

export function defaultRetention(): RetentionPolicy {
  return { schema: 'ar-resolve.retention.v1', basis: PLACEHOLDER_BASIS,
    classes: { transcripts: { days: 90 }, call_events: { days: 90 }, evidence_raw: { days: 365 }, notifications: { days: 30 }, sessions: { days: 7 }, recordings: { days: 30 } } };
}

export interface RetentionRecord { version: number; sha256: string; definition: RetentionPolicy; reason: string; createdBy: string; createdAt: string | null; placeholder: boolean }

export function currentRetention(db: Db, tenantId: string, clientId: string): RetentionRecord {
  const r = one<{ version: number; definition: string; sha256: string; reason: string; created_by: string; created_at: string }>(db,
    'SELECT * FROM retention_policies WHERE tenant_id=? AND client_id=? ORDER BY version DESC LIMIT 1', tenantId, clientId);
  if (r) { const d = JSON.parse(r.definition) as RetentionPolicy; return { version: r.version, sha256: r.sha256, definition: d, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at, placeholder: d.basis === PLACEHOLDER_BASIS }; }
  const d = defaultRetention();
  return { version: 0, sha256: hashJson(d), definition: d, reason: 'Built-in placeholder default', createdBy: 'system', createdAt: null, placeholder: true };
}

export function retentionView(db: Db, scope: Scope) {
  requirePerm(scope, 'view');
  const cur = currentRetention(db, scope.tenantId, scope.clientId);
  return {
    version: RETENTION_VERSION, current: cur, classes: RETENTION_CLASSES.map((c) => ({ id: c, ...CLASS_INFO[c], days: cur.definition.classes[c].days })),
    history: all<{ version: number; sha256: string; reason: string; created_by: string; created_at: string }>(db,
      'SELECT version, sha256, reason, created_by, created_at FROM retention_policies WHERE tenant_id=? AND client_id=? ORDER BY version DESC', scope.tenantId, scope.clientId),
    runs: all<{ run_id: string; policy_version: number; dry_run: number; counts: string; started_by: string; finished_at: string }>(db,
      'SELECT run_id, policy_version, dry_run, counts, started_by, finished_at FROM retention_runs WHERE tenant_id=? AND client_id=? ORDER BY rowid DESC LIMIT 20', scope.tenantId, scope.clientId)
      .map((r) => ({ runId: r.run_id, policyVersion: r.policy_version, dryRun: !!r.dry_run, counts: JSON.parse(r.counts), startedBy: r.started_by, finishedAt: r.finished_at })),
  };
}

/** New immutable policy version. `basis` must be stated; leaving the placeholder text keeps it labelled a placeholder. */
export function setRetention(db: Db, scope: Scope, body: { classes?: Record<string, { days?: unknown }>; basis?: unknown; reason?: unknown }): RetentionRecord {
  requirePerm(scope, 'manage_retention');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 10) throw invalid('A reason of at least 10 characters is required');
  const cur = currentRetention(db, scope.tenantId, scope.clientId);
  const classes = { ...cur.definition.classes };
  for (const [k, v] of Object.entries(body.classes ?? {})) {
    if (!(RETENTION_CLASSES as readonly string[]).includes(k)) throw invalid(`Unknown retention class ${k}`);
    const days = Number(v?.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw invalid(`${k}: days must be a whole number from 1 to 3650`);
    classes[k as RetentionClass] = { days };
  }
  const basis = body.basis === undefined ? cur.definition.basis : String(body.basis).trim();
  if (basis.length < 10) throw invalid('basis must say where the periods come from (contract, counsel memo) or keep the placeholder text');
  const def: RetentionPolicy = { schema: 'ar-resolve.retention.v1', basis, classes };
  return tx(db, () => {
    const version = cur.version + 1;
    const hash = hashJson(def);
    run(db, 'INSERT INTO retention_policies VALUES (?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, version, canonicalJson(def), hash, reason, scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'retention_policy', objectId: `v${version}`, eventType: 'retention_policy_changed',
      details: { version, sha256: hash, reason, placeholder: basis === PLACEHOLDER_BASIS, days: Object.fromEntries(RETENTION_CLASSES.map((c) => [c, classes[c].days])) } });
    return currentRetention(db, scope.tenantId, scope.clientId);
  });
}

// ---------------------------------------------------------------- tombstoning helpers

const JSON_TOMBSTONE = (t: string) => canonicalJson({ tombstone: t });

function tombstoneColumn(db: Db, colId: string, row: Record<string, unknown>, value: string, reason: TombstoneReason, at: string, digests: string[]): boolean {
  const col = sealedColumn(colId);
  const t = tombstoneFor(value, reason, at);
  const ok = rewrite(db, col, row, value, t, 'tombstone');
  if (ok) digests.push(t);
  return ok;
}

function tombstonePlain(db: Db, table: string, column: string, key: string[], row: Record<string, unknown>, value: string, reason: TombstoneReason, at: string, digests: string[], permit: boolean, json = false): boolean {
  const t = tombstoneFor(value, reason, at);
  const ok = rewrite(db, { table, column, key, permit }, row, value, json ? JSON_TOMBSTONE(t) : t, 'tombstone');
  if (ok) digests.push(t);
  return ok;
}

const NOT_TOMB = (c: string) => `${c} IS NOT NULL AND ${c} NOT LIKE 'tombstone:%' AND ${c} NOT LIKE '{"tombstone":%'`;

// ---------------------------------------------------------------- purge

export const PURGE_BATCH = 500;

/** Retention purge for one scope. dryRun counts what would change and writes nothing but the run record. */
export function purgeExpired(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId' | 'userId'>, o: { dryRun?: boolean; at?: Date } = {}) {
  const at = o.at ?? now();
  const atIso = at.toISOString();
  const pol = currentRetention(db, scope.tenantId, scope.clientId);
  const cutoff = (c: RetentionClass) => new Date(at.getTime() - pol.definition.classes[c].days * 86_400_000).toISOString();
  const S = [scope.tenantId, scope.clientId];
  const counts: Record<string, number> = {};
  const digests: string[] = [];
  const bump = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
  return tx(db, () => {
    const evidence = (kindSql: string, cls: RetentionClass) => {
      for (const r of all<Record<string, string>>(db, `SELECT tenant_id, client_id, evidence_id, content FROM evidence WHERE tenant_id=? AND client_id=? AND ${kindSql} AND observed_at < ? AND ${NOT_TOMB('content')} LIMIT ?`, ...S, cutoff(cls), PURGE_BATCH)) {
        if (o.dryRun || tombstoneColumn(db, 'evidence.content', r, r.content, 'retention', atIso, digests)) bump(`${cls}.evidence`);
      }
    };
    evidence("kind = 'call_transcript'", 'transcripts');
    evidence("kind <> 'call_transcript'", 'evidence_raw');
    for (const r of all<Record<string, string>>(db, `SELECT tenant_id, client_id, file_id, raw FROM edi_files WHERE tenant_id=? AND client_id=? AND created_at < ? AND ${NOT_TOMB('raw')} LIMIT ?`, ...S, cutoff('evidence_raw'), PURGE_BATCH)) {
      if (o.dryRun || tombstonePlain(db, 'edi_files', 'raw', ['tenant_id', 'client_id', 'file_id'], r, r.raw, 'retention', atIso, digests, true)) bump('evidence_raw.edi_files');
    }
    for (const r of all<Record<string, string>>(db, `SELECT tenant_id, client_id, call_id, seq, text FROM voice_call_events WHERE tenant_id=? AND client_id=? AND created_at < ? AND ${NOT_TOMB('text')} LIMIT ?`, ...S, cutoff('call_events'), PURGE_BATCH)) {
      if (o.dryRun || tombstoneColumn(db, 'voice_call_events.text', r, r.text, 'retention', atIso, digests)) bump('call_events.text');
    }
    for (const r of all<Record<string, string>>(db, `SELECT tenant_id, client_id, call_id, handoff FROM voice_calls WHERE tenant_id=? AND client_id=? AND ended_at IS NOT NULL AND ended_at < ? AND ${NOT_TOMB('handoff')} LIMIT ?`, ...S, cutoff('call_events'), PURGE_BATCH)) {
      if (o.dryRun || tombstonePlain(db, 'voice_calls', 'handoff', ['tenant_id', 'client_id', 'call_id'], r, r.handoff, 'retention', atIso, digests, false, true)) bump('call_events.handoff');
    }
    for (const r of all<Record<string, string>>(db, `SELECT tenant_id, client_id, delivery_id, payload FROM notification_deliveries WHERE tenant_id=? AND client_id=? AND status <> 'pending' AND created_at < ? AND ${NOT_TOMB('payload')} LIMIT ?`, ...S, cutoff('notifications'), PURGE_BATCH)) {
      if (o.dryRun || tombstonePlain(db, 'notification_deliveries', 'payload', ['tenant_id', 'client_id', 'delivery_id'], r, r.payload, 'retention', atIso, digests, false, true)) bump('notifications.payload');
    }
    const sink = one<{ n: number }>(db, 'SELECT COUNT(*) n FROM notification_sink WHERE tenant_id=? AND client_id=? AND received_at < ?', ...S, cutoff('notifications'))!.n;
    if (sink) { if (!o.dryRun) run(db, 'DELETE FROM notification_sink WHERE tenant_id=? AND client_id=? AND received_at < ?', ...S, cutoff('notifications')); bump('notifications.sink_deleted', sink); }
    for (const r of all<Record<string, string>>(db, `SELECT tenant_id, client_id, recording_id, storage_ref FROM call_recordings WHERE tenant_id=? AND client_id=? AND created_at < ? AND state IN ('recording','available') LIMIT ?`, ...S, cutoff('recordings'), PURGE_BATCH)) {
      if (o.dryRun) { bump('recordings.purged'); continue; }
      if (tombstonePlain(db, 'call_recordings', 'storage_ref', ['tenant_id', 'client_id', 'recording_id'], r, r.storage_ref, 'retention', atIso, digests, false)) {
        run(db, "UPDATE call_recordings SET state='purged', updated_at=? WHERE tenant_id=? AND client_id=? AND recording_id=?", atIso, ...S, r.recording_id);
        bump('recordings.purged');
      }
    }
    const runId = newId('ret');
    const digest = sha256(digests.sort().join('\n'));
    run(db, 'INSERT INTO retention_runs VALUES (?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, runId, pol.version, pol.sha256, o.dryRun ? 1 : 0, canonicalJson(counts), scope.userId, atIso, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'retention_run', objectId: runId, eventType: o.dryRun ? 'retention_purge_previewed' : 'retention_purge_run',
      details: { policyVersion: pol.version, policySha256: pol.sha256, placeholder: pol.placeholder, counts, tombstoneDigest: digest } });
    return { runId, dryRun: !!o.dryRun, policyVersion: pol.version, placeholder: pol.placeholder, counts, tombstoneDigest: digest, batchLimit: PURGE_BATCH };
  });
}

/** Sessions are not tenant data; the shortest sessions period configured by any client applies. */
export function purgeSessions(db: Db, at = now()): number {
  const days = Math.min(...all<{ tenant_id: string; client_id: string }>(db, 'SELECT tenant_id, client_id FROM clients').map((c) => currentRetention(db, c.tenant_id, c.client_id).definition.classes.sessions.days), defaultRetention().classes.sessions.days);
  return run(db, 'DELETE FROM sessions WHERE expires_at < ?', new Date(at.getTime() - days * 86_400_000).toISOString());
}

let lastSweep = 0;
/** Worker entry: purge every scope at most once per AR_RETENTION_INTERVAL_MS (default one hour). */
export function retentionTick(db: Db, force = false): { scopes: number; changed: number } {
  const interval = Number(process.env.AR_RETENTION_INTERVAL_MS ?? 3_600_000);
  if (!force && Date.now() - lastSweep < interval) return { scopes: 0, changed: 0 };
  lastSweep = Date.now();
  let changed = purgeSessions(db);
  const scopes = all<{ tenant_id: string; client_id: string }>(db, 'SELECT tenant_id, client_id FROM clients');
  for (const c of scopes) {
    const r = purgeExpired(db, { tenantId: c.tenant_id, clientId: c.client_id, userId: 'system:retention' });
    changed += Object.values(r.counts).reduce((a, b) => a + b, 0);
  }
  return { scopes: scopes.length, changed };
}

// ---------------------------------------------------------------- account deletion (two people)

interface DeletionRow { tenant_id: string; client_id: string; request_id: string; account_id: string; state: string; reason: string; requested_by: string; requested_at: string;
  decided_by: string | null; decided_at: string | null; decision_reason: string | null; summary: string | null; summary_sha256: string | null; executed_at: string | null }

const deletionView = (r: DeletionRow) => ({ requestId: r.request_id, accountId: r.account_id, state: r.state, reason: r.reason, requestedBy: r.requested_by, requestedAt: r.requested_at,
  decidedBy: r.decided_by, decidedAt: r.decided_at, decisionReason: r.decision_reason, summary: r.summary ? JSON.parse(r.summary) : null, summarySha256: r.summary_sha256, executedAt: r.executed_at });

export function listDeletions(db: Db, scope: Scope) {
  if (!can(scope, 'request_data_deletion') && !can(scope, 'approve_data_deletion') && !can(scope, 'audit_export')) requirePerm(scope, 'request_data_deletion');
  return all<DeletionRow>(db, 'SELECT * FROM account_deletion_requests WHERE tenant_id=? AND client_id=? ORDER BY requested_at DESC', scope.tenantId, scope.clientId).map(deletionView);
}

export function requestDeletion(db: Db, scope: Scope, accountId: string, body: { reason?: unknown }) {
  requirePerm(scope, 'request_data_deletion');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 10) throw invalid('A reason of at least 10 characters is required (for example the request reference)');
  return tx(db, () => {
    const a = one<{ deleted_at: string | null }>(db, 'SELECT deleted_at FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', scope.tenantId, scope.clientId, accountId);
    if (!a) throw notFound('Account');
    if (a.deleted_at) throw conflict('already_deleted', 'This account was already deleted');
    if (one(db, "SELECT 1 FROM account_deletion_requests WHERE tenant_id=? AND client_id=? AND account_id=? AND state='requested'", scope.tenantId, scope.clientId, accountId)) throw conflict('request_open', 'A deletion request for this account is already waiting for approval');
    const requestId = newId('del');
    run(db, `INSERT INTO account_deletion_requests (tenant_id, client_id, request_id, account_id, state, reason, requested_by, requested_at) VALUES (?,?,?,?,?,?,?,?)`,
      scope.tenantId, scope.clientId, requestId, accountId, 'requested', reason, scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'deletion_request', objectId: requestId, accountId, eventType: 'account_deletion_requested', details: { reason } });
    return deletionView(one<DeletionRow>(db, 'SELECT * FROM account_deletion_requests WHERE tenant_id=? AND client_id=? AND request_id=?', scope.tenantId, scope.clientId, requestId)!);
  });
}

export function cancelDeletion(db: Db, scope: Scope, requestId: string, body: { reason?: unknown }) {
  requirePerm(scope, 'request_data_deletion');
  return tx(db, () => {
    const r = one<DeletionRow>(db, 'SELECT * FROM account_deletion_requests WHERE tenant_id=? AND client_id=? AND request_id=?', scope.tenantId, scope.clientId, requestId);
    if (!r) throw notFound('Deletion request');
    if (r.state !== 'requested') throw conflict('not_open', `This request is already ${r.state}`);
    run(db, "UPDATE account_deletion_requests SET state='cancelled', decided_at=?, decision_reason=? WHERE tenant_id=? AND client_id=? AND request_id=?", nowIso(), String(body.reason ?? 'cancelled by requester').slice(0, 500), scope.tenantId, scope.clientId, requestId);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'deletion_request', objectId: requestId, accountId: r.account_id, eventType: 'account_deletion_cancelled', details: {} });
    return deletionView(one<DeletionRow>(db, 'SELECT * FROM account_deletion_requests WHERE tenant_id=? AND client_id=? AND request_id=?', scope.tenantId, scope.clientId, requestId)!);
  });
}

export function decideDeletion(db: Db, scope: Scope, requestId: string, body: { decision?: unknown; reason?: unknown }) {
  requirePerm(scope, 'approve_data_deletion');
  const decision = String(body.decision ?? '');
  if (decision !== 'approve' && decision !== 'reject') throw invalid('decision must be approve or reject');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 10) throw invalid('A reason of at least 10 characters is required');
  return tx(db, () => {
    const r = one<DeletionRow>(db, 'SELECT * FROM account_deletion_requests WHERE tenant_id=? AND client_id=? AND request_id=?', scope.tenantId, scope.clientId, requestId);
    if (!r) throw notFound('Deletion request');
    if (r.state !== 'requested') throw conflict('not_open', `This request is already ${r.state}`);
    if (r.requested_by === scope.userId) throw forbidden('Two people are required: the person who requested a deletion cannot approve or reject it');
    if (decision === 'reject') {
      run(db, "UPDATE account_deletion_requests SET state='rejected', decided_by=?, decided_at=?, decision_reason=? WHERE tenant_id=? AND client_id=? AND request_id=?", scope.userId, nowIso(), reason, scope.tenantId, scope.clientId, requestId);
      audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'deletion_request', objectId: requestId, accountId: r.account_id, eventType: 'account_deletion_rejected', details: { reason } });
    } else {
      const summary = executeDeletion(db, scope, r.account_id, requestId);
      const text = canonicalJson(summary);
      run(db, "UPDATE account_deletion_requests SET state='executed', decided_by=?, decided_at=?, decision_reason=?, summary=?, summary_sha256=?, executed_at=? WHERE tenant_id=? AND client_id=? AND request_id=?",
        scope.userId, nowIso(), reason, text, sha256(text), nowIso(), scope.tenantId, scope.clientId, requestId);
      audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'deletion_request', objectId: requestId, accountId: r.account_id, eventType: 'account_deletion_executed',
        details: { requestedBy: r.requested_by, reason, counts: summary.counts, tombstoneDigest: summary.tombstoneDigest, summarySha256: sha256(text) } });
    }
    return deletionView(one<DeletionRow>(db, 'SELECT * FROM account_deletion_requests WHERE tenant_id=? AND client_id=? AND request_id=?', scope.tenantId, scope.clientId, requestId)!);
  });
}

/** Everything this system holds for one account, tombstoned or deleted. Runs inside the approval transaction. */
function executeDeletion(db: Db, scope: Scope, accountId: string, requestId: string) {
  const S = [scope.tenantId, scope.clientId];
  const at = nowIso();
  const counts: Record<string, number> = {};
  const digests: string[] = [];
  const bump = (k: string, ok = true) => { if (ok) counts[k] = (counts[k] ?? 0) + 1; };
  const inflight = one<{ action_id: string; state: string }>(db, "SELECT action_id, state FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND state IN ('dispatching','uncertain')", ...S, accountId);
  if (inflight) throw conflict('action_in_flight', `Action ${inflight.action_id} is ${inflight.state}; reconcile it before deleting the account`);
  const ph = ACTIVE_CALL_STATES.map(() => '?').join(',');
  const call = one<{ call_id: string }>(db, `SELECT call_id FROM voice_calls WHERE tenant_id=? AND client_id=? AND account_id=? AND state IN (${ph})`, ...S, accountId, ...ACTIVE_CALL_STATES);
  if (call) throw conflict('call_active', `Call ${call.call_id} is active on this account; end it before deleting the account`);

  // Open proposals can never execute after deletion.
  for (const p of all<{ action_id: string }>(db, "SELECT action_id FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND state IN ('awaiting_review','approved','needs_evidence','stale_blocked')", ...S, accountId)) {
    run(db, "UPDATE proposed_actions SET state='cancelled', updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=?", at, ...S, p.action_id);
    run(db, "UPDATE action_outbox SET state='blocked', last_error='Account deleted at the owner''s request', updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=? AND state='pending'", at, ...S, p.action_id);
    bump('proposed_actions.cancelled');
  }
  for (const r of all<Record<string, string>>(db, `SELECT tenant_id, client_id, evidence_id, content FROM evidence WHERE tenant_id=? AND client_id=? AND account_id=? AND ${NOT_TOMB('content')}`, ...S, accountId)) {
    bump('evidence.content', tombstoneColumn(db, 'evidence.content', r, r.content, 'account_deletion', at, digests));
  }
  const calls = all<{ call_id: string }>(db, 'SELECT call_id FROM voice_calls WHERE tenant_id=? AND client_id=? AND account_id=?', ...S, accountId).map((c) => c.call_id);
  for (const callId of calls) {
    for (const r of all<Record<string, string>>(db, `SELECT tenant_id, client_id, call_id, seq, text FROM voice_call_events WHERE tenant_id=? AND client_id=? AND call_id=? AND ${NOT_TOMB('text')}`, ...S, callId)) {
      bump('voice_call_events.text', tombstoneColumn(db, 'voice_call_events.text', r, r.text, 'account_deletion', at, digests));
    }
    for (const r of all<Record<string, string>>(db, `SELECT tenant_id, client_id, answer_id, value FROM voice_answers WHERE tenant_id=? AND client_id=? AND call_id=? AND value IS NOT NULL AND value NOT LIKE '"tombstone:%'`, ...S, callId)) {
      const t = tombstoneFor(r.value, 'account_deletion', at);
      bump('voice_answers.value', rewrite(db, { table: 'voice_answers', column: 'value', key: ['tenant_id', 'client_id', 'answer_id'], permit: false }, r, r.value, JSON.stringify(t), 'tombstone'));
      digests.push(t);
    }
  }
  for (const r of all<Record<string, string>>(db, `SELECT tenant_id, client_id, call_id, handoff FROM voice_calls WHERE tenant_id=? AND client_id=? AND account_id=? AND ${NOT_TOMB('handoff')}`, ...S, accountId)) {
    bump('voice_calls.handoff', tombstonePlain(db, 'voice_calls', 'handoff', ['tenant_id', 'client_id', 'call_id'], r, r.handoff, 'account_deletion', at, digests, false, true));
  }
  for (const r of all<Record<string, string | null>>(db, 'SELECT tenant_id, client_id, action_id, original_draft, final_text, edit_reason FROM note_writebacks WHERE tenant_id=? AND client_id=? AND account_id=?', ...S, accountId)) {
    for (const c of ['original_draft', 'final_text'] as const) if (r[c] && !isTombstone(r[c])) bump(`note_writebacks.${c}`, tombstoneColumn(db, `note_writebacks.${c}`, r, r[c]!, 'account_deletion', at, digests));
    if (r.edit_reason && !isTombstone(r.edit_reason)) bump('note_writebacks.edit_reason', tombstonePlain(db, 'note_writebacks', 'edit_reason', ['tenant_id', 'client_id', 'action_id'], r, r.edit_reason, 'account_deletion', at, digests, true));
  }
  for (const r of all<Record<string, string>>(db, 'SELECT tenant_id, client_id, action_id, payload, note_draft FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=?', ...S, accountId)) {
    const t = tombstonePayload(r.payload, 'account_deletion', at);
    if (t.fields.length) { bump('proposed_actions.payload', rewrite(db, sealedColumn('proposed_actions.payload'), r, r.payload, t.payload, 'tombstone')); digests.push(...t.fields.map((f) => f.tombstone)); }
    if (!isTombstone(r.note_draft)) bump('proposed_actions.note_draft', tombstoneColumn(db, 'proposed_actions.note_draft', r, r.note_draft, 'account_deletion', at, digests));
  }
  for (const r of all<Record<string, string>>(db, `SELECT d.tenant_id, d.client_id, d.decision_id, d.rationale FROM review_decisions d JOIN proposed_actions p USING (tenant_id, client_id, action_id)
      WHERE d.tenant_id=? AND d.client_id=? AND p.account_id=? AND d.rationale NOT LIKE 'tombstone:%'`, ...S, accountId)) {
    bump('review_decisions.rationale', tombstonePlain(db, 'review_decisions', 'rationale', ['tenant_id', 'client_id', 'decision_id'], r, r.rationale, 'account_deletion', at, digests, true));
  }
  for (const r of all<Record<string, string>>(db, "SELECT tenant_id, client_id, work_item_id, summary FROM work_items WHERE tenant_id=? AND client_id=? AND account_id=? AND summary NOT LIKE 'tombstone:%'", ...S, accountId)) {
    bump('work_items.summary', tombstonePlain(db, 'work_items', 'summary', ['tenant_id', 'client_id', 'work_item_id'], r, r.summary, 'account_deletion', at, digests, false));
  }
  // Notification payloads are sealed JSON; open each in this scope to find the account's.
  for (const r of all<Record<string, string>>(db, `SELECT tenant_id, client_id, delivery_id, payload, status FROM notification_deliveries WHERE tenant_id=? AND client_id=? AND ${NOT_TOMB('payload')}`, ...S)) {
    let acct: unknown = null;
    try { acct = JSON.parse(open(r.payload)).accountId; } catch { continue; }
    if (acct !== accountId) continue;
    if (tombstonePlain(db, 'notification_deliveries', 'payload', ['tenant_id', 'client_id', 'delivery_id'], r, r.payload, 'account_deletion', at, digests, false, true)) {
      bump('notification_deliveries.payload');
      if (r.status === 'pending') run(db, "UPDATE notification_deliveries SET status='refused', last_error='Account deleted', next_attempt_at=NULL WHERE tenant_id=? AND client_id=? AND delivery_id=?", ...S, r.delivery_id);
      const n = run(db, 'DELETE FROM notification_sink WHERE tenant_id=? AND client_id=? AND delivery_id=?', ...S, r.delivery_id);
      if (n) counts['notification_sink.deleted'] = (counts['notification_sink.deleted'] ?? 0) + n;
    }
  }
  for (const r of all<Record<string, string>>(db, "SELECT tenant_id, client_id, recording_id, storage_ref FROM call_recordings WHERE tenant_id=? AND client_id=? AND account_id=? AND storage_ref NOT LIKE 'tombstone:%'", ...S, accountId)) {
    if (tombstonePlain(db, 'call_recordings', 'storage_ref', ['tenant_id', 'client_id', 'recording_id'], r, r.storage_ref, 'account_deletion', at, digests, false)) {
      run(db, "UPDATE call_recordings SET state='deleted', updated_at=? WHERE tenant_id=? AND client_id=? AND recording_id=?", at, ...S, r.recording_id);
      bump('call_recordings.storage_ref');
    }
  }
  run(db, "UPDATE accounts SET patient_token='PT-DELETED', deleted_at=?, updated_at=? WHERE tenant_id=? AND client_id=? AND account_id=?", at, at, ...S, accountId);
  bump('accounts.patient_token');
  return {
    requestId, accountId, executedAt: at, counts, tombstoneDigest: sha256(digests.sort().join('\n')), tombstones: digests.length,
    kept: ['audit_events (append-only; the record of what happened)', 'facts and observations (structured financial values, no free text)', 'outcome_ledger (append-only financial ledger)',
      'review_decisions rows, payload hashes and account revisions (approvals stay verifiable)', 'evidence rows and hashes (provenance stays verifiable)',
      'systems outside AR Resolve (the simulated PM keeps its own copy; a real deployment must route the request to the system of record)'],
  };
}

export function isDeleted(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, accountId: string): boolean {
  return !!one<{ deleted_at: string | null }>(db, 'SELECT deleted_at FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', scope.tenantId, scope.clientId, accountId)?.deleted_at;
}

/**
 * Approval binding after redaction. The decision still names the payload hash it approved and the
 * proposal still carries it; whether the payload content can be re-hashed depends on redaction.
 */
export function approvalBinding(db: Db, scope: Scope, actionId: string) {
  requirePerm(scope, 'view');
  const a = one<{ payload: string; payload_sha256: string; expected_revision: number; account_id: string }>(db, 'SELECT payload, payload_sha256, expected_revision, account_id FROM proposed_actions WHERE tenant_id=? AND client_id=? AND action_id=?', scope.tenantId, scope.clientId, actionId);
  if (!a) throw notFound('Action');
  const decisions = all<{ decision_id: string; decision: string; payload_sha256: string; account_revision: number }>(db, 'SELECT decision_id, decision, payload_sha256, account_revision FROM review_decisions WHERE tenant_id=? AND client_id=? AND action_id=?', scope.tenantId, scope.clientId, actionId);
  const stored = JSON.parse(a.payload);
  const redacted = ['request.summary', 'note.text'].map((p) => ({ path: p, v: p.split('.').reduce((x: any, k) => x?.[k], stored) }))
    .filter((x) => isTombstone(x.v)).map((x) => ({ path: x.path, tombstone: parseTombstone(x.v as string) }));
  let contentMatches: boolean | null = null;
  let error: string | null = null;
  if (!redacted.length) { try { contentMatches = hashJson(openPayload(a.payload)) === a.payload_sha256; } catch (e) { error = (e as Error).message; contentMatches = false; } }
  return { actionId, payloadSha256: a.payload_sha256, expectedRevision: a.expected_revision,
    decisions: decisions.map((d) => ({ decisionId: d.decision_id, decision: d.decision, boundToPayload: d.payload_sha256 === a.payload_sha256, accountRevision: d.account_revision })),
    redacted, contentMatches, error,
    note: redacted.length ? 'Free text was removed under retention or deletion; each removed field keeps the SHA-256 of its plaintext. Decisions remain bound to the recorded payload hash.' : null };
}

export class DeletedAccount extends AppError { constructor() { super(409, 'account_deleted', 'This account was deleted at the owner\'s request; no new evidence, calls or actions'); } }
