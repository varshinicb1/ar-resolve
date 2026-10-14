// Executor connectors. Phase 0 ships only simulated connectors. The live
// connector exists to make the boundary explicit and always refuses.
import { createHmac } from 'node:crypto';
import { type Db, one, run } from '../db/db.ts';
import { newId, nowIso } from '../util.ts';
import { simPm } from './sim-pm.ts';
import { isSyntheticDeployment } from '../config.ts';

export class ConnectorTimeout extends Error {}
export class LiveExecutionDisabled extends Error {}
// The target refused before writing (e.g. its record changed since preview). Never retried.
export class PreflightFailed extends Error {}

export interface SubmitResult { externalReference: string; status: 'accepted' | 'confirmed'; receipt: Record<string, unknown> }

export interface Connector {
  name: string;
  live: boolean;
  submit(db: Db, idempotencyKey: string, payloadSha256: string, payload: Record<string, unknown>): SubmitResult;
  // Read-back by idempotency key: did the external system receive this request?
  lookup(db: Db, idempotencyKey: string): SubmitResult | null;
}

function takeFault(db: Db, fault: string): boolean {
  const changed = run(db, 'UPDATE sim_faults SET remaining = remaining - 1 WHERE fault = ? AND remaining > 0', fault);
  return changed === 1;
}

export function setFault(db: Db, fault: 'timeout_after_success' | 'timeout_before_send', remaining: number) {
  run(db, 'INSERT INTO sim_faults VALUES (?, ?) ON CONFLICT(fault) DO UPDATE SET remaining = excluded.remaining', fault, remaining);
}

// Structured review commitment returned by the SIMULATED payer's receipt. Invented
// for the simulator; it is not any real payer's turnaround time.
export const SIM_PAYER_COMMITMENT = { kind: 'turnaround', value: 30, unit: 'days', basis: 'business', statement: 'Simulated payer: request will be reviewed within 30 business days (synthetic simulator value)' };

export const simPayer: Connector = {
  name: 'sim_payer',
  live: false,
  submit(db, key, payloadSha256, payload) {
    if (takeFault(db, 'timeout_before_send')) throw new ConnectorTimeout('Simulated timeout before the payer received the request');
    const existing = this.lookup(db, key);
    let result = existing;
    if (!existing) {
      const ref = `SIM-REQ-${newId('r').slice(2, 10).toUpperCase()}`;
      run(db, 'INSERT INTO sim_payer_requests VALUES (?,?,?,?,?,?)', key, ref, payloadSha256, String(payload.actionKind), nowIso(), 'accepted');
      result = { externalReference: ref, status: 'accepted', receipt: { system: 'simulated payer', externalReference: ref, acceptedAt: nowIso(), note: 'Request accepted for review. Not an adjudication or payment.', commitment: SIM_PAYER_COMMITMENT } };
    }
    if (takeFault(db, 'timeout_after_success')) throw new ConnectorTimeout('Simulated timeout after the payer accepted the request');
    return result!;
  },
  lookup(db, key) {
    const r = one<{ external_reference: string; status: string; received_at: string }>(db, 'SELECT external_reference, status, received_at FROM sim_payer_requests WHERE idempotency_key = ?', key);
    if (!r) return null;
    return { externalReference: r.external_reference, status: r.status === 'confirmed' ? 'confirmed' : 'accepted', receipt: { system: 'simulated payer', externalReference: r.external_reference, acceptedAt: r.received_at, readBack: true, commitment: SIM_PAYER_COMMITMENT } };
  },
};

export const internalWorklist: Connector = {
  name: 'internal_worklist',
  live: false,
  submit(db, key, _hash, payload) {
    const existing = this.lookup(db, key);
    if (existing) return existing;
    const acct = payload.account as { tenantId: string; clientId: string; accountId: string };
    const id = newId('wi');
    run(db, 'INSERT INTO work_items VALUES (?,?,?,?,?,?,?,?,?)', acct.tenantId, acct.clientId, id, acct.accountId, key, String(payload.actionKind),
      String((payload.request as { summary: string }).summary), 'open', nowIso());
    return { externalReference: id, status: 'confirmed', receipt: { system: 'internal worklist', workItemId: id, createdAt: nowIso() } };
  },
  lookup(db, key) {
    const r = one<{ work_item_id: string; created_at: string }>(db, 'SELECT work_item_id, created_at FROM work_items WHERE idempotency_key = ?', key);
    return r ? { externalReference: r.work_item_id, status: 'confirmed', receipt: { system: 'internal worklist', workItemId: r.work_item_id, createdAt: r.created_at, readBack: true } } : null;
  },
};

export const livePayer: Connector = {
  name: 'live_payer',
  live: true,
  submit() { throw new LiveExecutionDisabled('Live payer execution is disabled in Phase 0. No authorization or covered-service record exists.'); },
  lookup() { throw new LiveExecutionDisabled('Live payer execution is disabled in Phase 0.'); },
};

export function connectorFor(name: string): Connector {
  // ADR 0090: simulators never execute outside the synthetic environment; they fall through to the refusing live boundary.
  if ((name === 'sim_payer' || name === 'sim_pm') && !isSyntheticDeployment()) return livePayer;
  if (name === 'sim_payer') return simPayer;
  if (name === 'internal_worklist') return internalWorklist;
  if (name === 'sim_pm') return simPm;
  return livePayer;
}

// Webhook signing for simulated payer receipts. The dev secret is synthetic-only.
export const WEBHOOK_SECRET = process.env.AR_WEBHOOK_SECRET ?? 'synthetic-dev-only-webhook-secret';

export function signWebhook(body: string, timestamp: string, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
