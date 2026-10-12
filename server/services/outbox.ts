// Transactional outbox worker (FR11/FR14). Approval wrote a pending row in the
// same transaction. This worker:
//   1. turns expired 'dispatching' leases into 'uncertain' (crash recovery),
//   2. reconciles 'uncertain' rows by reading back from the connector,
//   3. dispatches 'pending' rows after re-checking every authority condition.
// A timeout never triggers a blind resubmission.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { canonicalJson, hashJson, newId, now, nowIso, sha256 } from '../util.ts';
import { audit } from './audit.ts';
import { approverStillAuthorized } from './auth.ts';
import { activePause } from './controls.ts';
import { afterReceipt, tickFollowups } from './followup.ts';
import { holdRow, outboxDims } from './holds.ts';
import { ConnectorTimeout, LiveExecutionDisabled, PreflightFailed, connectorFor, signWebhook, WEBHOOK_SECRET, type SubmitResult } from '../connectors/executors.ts';
import { AppError } from '../util.ts';
import { openVerbalRequests } from './verbal-requests.ts';

const LEASE_SECONDS = 30;
const MAX_ATTEMPTS = 3;

export interface OutboxRow {
  tenant_id: string; client_id: string; action_id: string; idempotency_key: string; connector: string; state: string;
  attempts: number; lease_until: string | null; external_reference: string | null; held_at?: string | null;
}

interface ActionRow { account_id: string; payload: string; payload_sha256: string; expected_revision: number; state: string; kind: string }

const SYSTEM = 'system:outbox-worker';

function ev(db: Db, o: OutboxRow, accountId: string, eventType: string, details: Record<string, unknown>) {
  audit(db, { tenantId: o.tenant_id, clientId: o.client_id, actorId: SYSTEM, objectType: 'action', objectId: o.action_id, accountId, eventType, details });
}

function setOutbox(db: Db, o: OutboxRow, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  run(db, `UPDATE action_outbox SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=?`,
    ...keys.map((k) => fields[k]), nowIso(), o.tenant_id, o.client_id, o.action_id);
}

function setAction(db: Db, o: OutboxRow, state: string) {
  run(db, 'UPDATE proposed_actions SET state=?, updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=?', state, nowIso(), o.tenant_id, o.client_id, o.action_id);
}

function setAccount(db: Db, o: OutboxRow, accountId: string, state: string, followupDue?: string | null) {
  if (o.connector === 'sim_pm') return; // a note write-back never changes the account workflow state
  run(db, 'UPDATE accounts SET state=?, followup_due=COALESCE(?, followup_due), updated_at=? WHERE tenant_id=? AND client_id=? AND account_id=?',
    state, followupDue ?? null, nowIso(), o.tenant_id, o.client_id, accountId);
}

function recordReceipt(db: Db, o: OutboxRow, a: ActionRow, r: SubmitResult, via: string) {
  const content = { ...r.receipt, idempotencyKey: o.idempotency_key, actionId: o.action_id, via };
  const body = canonicalJson(content);
  const evidenceId = newId('ev');
  run(db, 'INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', o.tenant_id, o.client_id, a.account_id, evidenceId, 'action_receipt',
    `Receipt ${r.externalReference} (${o.connector})`, o.connector, body, sha256(body), nowIso(), nowIso(), SYSTEM);
  const confirmed = r.status === 'confirmed';
  setOutbox(db, o, { state: confirmed ? 'confirmed' : 'accepted', external_reference: r.externalReference, receipt_evidence_id: evidenceId, lease_until: null, last_error: null });
  setAction(db, o, confirmed ? 'confirmed' : 'accepted');
  // A follow-up date comes only from a captured commitment or the labelled policy interval (afterReceipt below).
  setAccount(db, o, a.account_id, confirmed ? 'monitoring' : 'awaiting_receipt');
  ev(db, o, a.account_id, 'action_receipt_received', { externalReference: r.externalReference, status: r.status, via, receiptEvidenceId: evidenceId });
  afterReceipt(db, o, a.account_id, evidenceId); // follow-up from a captured commitment, or labelled policy interval
}

export interface TickReport { recovered: number; reconciled: number; dispatched: number; uncertain: number; blocked: number; skippedPaused: number; followupsDue: number }

export function tick(db: Db): TickReport {
  const rep: TickReport = { recovered: 0, reconciled: 0, dispatched: 0, uncertain: 0, blocked: 0, skippedPaused: 0, followupsDue: 0 };

  // 1. Crash recovery: a dispatch whose lease expired may or may not have reached the connector.
  for (const o of all<OutboxRow>(db, `SELECT * FROM action_outbox WHERE state='dispatching' AND lease_until < ?`, nowIso())) {
    tx(db, () => {
      const a = one<ActionRow>(db, 'SELECT * FROM proposed_actions WHERE tenant_id=? AND client_id=? AND action_id=?', o.tenant_id, o.client_id, o.action_id)!;
      setOutbox(db, o, { state: 'uncertain', lease_until: null, last_error: 'Worker lease expired mid-dispatch' });
      setAction(db, o, 'uncertain');
      setAccount(db, o, a.account_id, 'receipt_uncertain');
      ev(db, o, a.account_id, 'dispatch_uncertain', { reason: 'lease_expired' });
    });
    rep.recovered++;
  }

  // 2. Reconcile uncertain rows by read-back before anything else may happen.
  for (const o of all<OutboxRow>(db, `SELECT * FROM action_outbox WHERE state='uncertain'`)) {
    rep.reconciled += reconcile(db, o) ? 1 : 0;
  }

  // 3. Dispatch pending rows.
  for (const o of all<OutboxRow>(db, `SELECT * FROM action_outbox WHERE state='pending' ORDER BY created_at`)) {
    const pause = activePause(db, o.tenant_id, o.client_id, outboxDims(db, o));
    if (pause || o.held_at) { if (pause) holdRow(db, o, pause); rep.skippedPaused++; continue; }
    const claimed = tx(db, () => {
      const a = one<ActionRow>(db, 'SELECT * FROM proposed_actions WHERE tenant_id=? AND client_id=? AND action_id=?', o.tenant_id, o.client_id, o.action_id)!;
      const acct = one<{ revision: number }>(db, 'SELECT revision FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', o.tenant_id, o.client_id, a.account_id)!;
      const decision = one<{ actor_id: string; payload_sha256: string; account_revision: number }>(db,
        `SELECT actor_id, payload_sha256, account_revision FROM review_decisions WHERE tenant_id=? AND client_id=? AND action_id=? AND decision='approved'`, o.tenant_id, o.client_id, o.action_id);
      const problems: string[] = [];
      if (a.state !== 'approved') problems.push(`action state is ${a.state}`);
      if (!decision) problems.push('no approval decision on record');
      if (decision && decision.payload_sha256 !== a.payload_sha256) problems.push('approval hash does not match payload');
      if (hashJson(JSON.parse(a.payload)) !== a.payload_sha256) problems.push('payload integrity check failed');
      if (acct.revision !== a.expected_revision || (decision && decision.account_revision !== acct.revision)) problems.push(`account revision changed (${a.expected_revision} -> ${acct.revision})`);
      if (decision && !approverStillAuthorized(db, decision.actor_id, o.tenant_id, o.client_id, a.kind)) problems.push('approver no longer holds the reviewer role');
      if (openVerbalRequests(db, { tenantId: o.tenant_id, clientId: o.client_id }, a.account_id, a.kind).length) problems.push('the payer accepted the same request verbally on a call and it is not reconciled (ADR 0060)');
      if (problems.length) {
        setOutbox(db, o, { state: 'blocked', last_error: problems.join('; ') });
        if (a.state === 'approved') setAction(db, o, 'stale_blocked');
        ev(db, o, a.account_id, 'dispatch_blocked', { problems });
        return null;
      }
      const lease = new Date(now().getTime() + LEASE_SECONDS * 1000).toISOString();
      const changed = run(db, `UPDATE action_outbox SET state='dispatching', attempts=attempts+1, lease_until=?, updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=? AND state='pending'`,
        lease, nowIso(), o.tenant_id, o.client_id, o.action_id);
      if (changed !== 1) return null;
      setAction(db, o, 'dispatching');
      setAccount(db, o, a.account_id, 'executing');
      ev(db, o, a.account_id, 'action_dispatched', { connector: o.connector, idempotencyKey: o.idempotency_key, attempt: o.attempts + 1 });
      return a;
    });
    if (!claimed) { rep.blocked++; continue; }
    // The connector call happens outside any local transaction, like a real network call.
    const connector = connectorFor(o.connector);
    try {
      const result = connector.submit(db, o.idempotency_key, claimed.payload_sha256, JSON.parse(claimed.payload));
      tx(db, () => recordReceipt(db, o, claimed, result, 'submit'));
      rep.dispatched++;
    } catch (err) {
      if (err instanceof ConnectorTimeout) {
        tx(db, () => {
          setOutbox(db, o, { state: 'uncertain', lease_until: null, last_error: err.message });
          setAction(db, o, 'uncertain');
          setAccount(db, o, claimed.account_id, 'receipt_uncertain');
          ev(db, o, claimed.account_id, 'dispatch_uncertain', { reason: 'timeout', message: err.message });
        });
        rep.uncertain++;
      } else {
        const message = err instanceof LiveExecutionDisabled ? err.message : `Connector error: ${(err as Error).message}`;
        tx(db, () => {
          setOutbox(db, o, { state: 'failed', lease_until: null, last_error: message });
          if (err instanceof PreflightFailed) setAction(db, o, 'stale_blocked');
          ev(db, o, claimed.account_id, 'dispatch_failed', { message });
        });
      }
    }
  }
  // 4. Follow-ups whose date has arrived become due or overdue.
  const fu = tickFollowups(db);
  rep.followupsDue = fu.due + fu.overdue;
  return rep;
}

// Read-back reconciliation. Found: record the receipt without resubmitting.
// Confirmed absent: safe to return to pending (bounded attempts). Never guesses.
export function reconcile(db: Db, o: OutboxRow): boolean {
  const a = one<ActionRow>(db, 'SELECT * FROM proposed_actions WHERE tenant_id=? AND client_id=? AND action_id=?', o.tenant_id, o.client_id, o.action_id)!;
  let found: SubmitResult | null;
  try {
    found = connectorFor(o.connector).lookup(db, o.idempotency_key);
  } catch (err) {
    tx(db, () => ev(db, o, a.account_id, 'reconcile_failed', { message: (err as Error).message }));
    return false;
  }
  tx(db, () => {
    if (found) {
      recordReceipt(db, o, a, found, 'read_back');
      ev(db, o, a.account_id, 'uncertain_reconciled', { outcome: 'found_at_connector', externalReference: found.externalReference, resubmitted: false });
    } else if (o.attempts < MAX_ATTEMPTS) {
      setOutbox(db, o, { state: 'pending', last_error: 'Read-back confirmed the connector never received the request' });
      setAction(db, o, 'approved');
      setAccount(db, o, a.account_id, 'approved');
      ev(db, o, a.account_id, 'uncertain_reconciled', { outcome: 'absent_at_connector', willRetry: true });
    } else {
      setOutbox(db, o, { state: 'failed', last_error: 'Not received after maximum attempts; human reconciliation required' });
      ev(db, o, a.account_id, 'uncertain_reconciled', { outcome: 'absent_at_connector', willRetry: false });
    }
  });
  return true;
}

// ---------------------------------------------------------------- signed receipt webhook (simulated payer)

export interface WebhookBody { eventId: string; externalReference: string; status: 'confirmed'; timestamp: string }

export function handlePayerWebhook(db: Db, rawBody: string, signature: string | undefined, timestamp: string | undefined) {
  if (!signature || !timestamp) throw new AppError(401, 'unsigned', 'Missing webhook signature');
  const expected = signWebhook(rawBody, timestamp, WEBHOOK_SECRET);
  if (expected.length !== signature.length || !timingSafe(expected, signature)) throw new AppError(401, 'bad_signature', 'Invalid webhook signature');
  const ageMs = Math.abs(now().getTime() - Date.parse(timestamp));
  if (!Number.isFinite(ageMs) || ageMs > 5 * 60_000) throw new AppError(401, 'stale_webhook', 'Webhook timestamp outside tolerance');
  const body = JSON.parse(rawBody) as WebhookBody;
  return tx(db, () => {
    if (one(db, 'SELECT 1 FROM receipt_events WHERE event_id=?', body.eventId)) return { duplicate: true };
    const o = one<OutboxRow>(db, 'SELECT * FROM action_outbox WHERE external_reference=? AND connector=?', body.externalReference, 'sim_payer');
    if (!o) throw new AppError(404, 'unknown_reference', 'No dispatched action with that reference');
    run(db, 'INSERT INTO receipt_events VALUES (?,?,?,?,?,?,?)', body.eventId, o.tenant_id, o.client_id, o.action_id, body.externalReference, body.status, nowIso());
    const a = one<ActionRow>(db, 'SELECT * FROM proposed_actions WHERE tenant_id=? AND client_id=? AND action_id=?', o.tenant_id, o.client_id, o.action_id)!;
    if (body.status === 'confirmed' && o.state === 'accepted') {
      setOutbox(db, o, { state: 'confirmed' });
      setAction(db, o, 'confirmed');
      setAccount(db, o, a.account_id, 'monitoring');
      run(db, `UPDATE sim_payer_requests SET status='confirmed' WHERE external_reference=?`, body.externalReference);
    }
    ev(db, o, a.account_id, 'payer_confirmation_received', { eventId: body.eventId, externalReference: body.externalReference, status: body.status,
      note: 'Payer confirmed receipt of the request. This is not an adjudication or a payment.' });
    return { duplicate: false, actionId: o.action_id };
  });
}

function timingSafe(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function buildSimConfirmation(externalReference: string, eventId = newId('whk')) {
  const timestamp = nowIso();
  const body = JSON.stringify({ eventId, externalReference, status: 'confirmed', timestamp });
  return { body, timestamp, signature: signWebhook(body, timestamp) };
}

export function startWorker(db: Db, intervalMs = 1000): () => void {
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    try { tick(db); } catch (err) { console.error('[worker]', (err as Error).message); } finally { busy = false; }
  }, intervalMs);
  return () => clearInterval(t);
}
