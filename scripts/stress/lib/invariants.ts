// Safety invariants checked directly in the database after a run (read-only).
// These are the properties the stress harness exists to protect: one decision per
// action, at most one send per approval, no dispatch of a superseded proposal, outbox
// and action states that agree, and an unbroken audit hash chain per tenant.
import { DatabaseSync } from 'node:sqlite';
import { verifyChain } from '../../../server/services/audit.ts';
import type { Db } from '../../../server/db/db.ts';

export interface Violation { invariant: string; detail: string }

export function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}

type Row = Record<string, any>;
const q = (db: DatabaseSync, sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as Row[];

export function checkInvariants(path: string, opts: { quiesced?: boolean } = {}): { violations: Violation[]; stats: Record<string, number> } {
  const db = openReadOnly(path);
  const v: Violation[] = [];
  try {
    for (const r of q(db, `SELECT action_id, COUNT(*) n FROM review_decisions GROUP BY tenant_id, client_id, action_id HAVING n > 1`))
      v.push({ invariant: 'one_decision_per_action', detail: `${r.action_id} has ${r.n} decisions` });

    // A connector call happens only after an 'action_dispatched' claim. More claims than
    // (1 + read-backs that proved the request absent) means a blind resend.
    for (const r of q(db, `SELECT o.action_id,
        (SELECT COUNT(*) FROM audit_events e WHERE e.tenant_id=o.tenant_id AND e.object_id=o.action_id AND e.event_type='action_dispatched') d,
        (SELECT COUNT(*) FROM audit_events e WHERE e.tenant_id=o.tenant_id AND e.object_id=o.action_id AND e.event_type='uncertain_reconciled'
           AND json_extract(e.details,'$.outcome')='absent_at_connector' AND json_extract(e.details,'$.willRetry')=1) retry
      FROM action_outbox o`)) {
      if (r.d > 1 + r.retry) v.push({ invariant: 'no_blind_resend', detail: `${r.action_id}: ${r.d} dispatch claims, ${r.retry} proven-absent retries` });
    }

    // Every request the simulated payer / worklist / PM received is bound to an approval of
    // the exact payload at the revision the proposal was generated from.
    const received = q(db, `SELECT o.tenant_id, o.client_id, o.action_id, o.state ostate, p.state pstate, p.expected_revision, p.payload_sha256,
        (SELECT COUNT(*) FROM review_decisions d WHERE d.tenant_id=o.tenant_id AND d.client_id=o.client_id AND d.action_id=o.action_id AND d.decision='approved'
           AND d.payload_sha256=p.payload_sha256 AND d.account_revision=p.expected_revision) bound
      FROM action_outbox o JOIN proposed_actions p USING (tenant_id, client_id, action_id)
      WHERE o.idempotency_key IN (SELECT idempotency_key FROM sim_payer_requests UNION SELECT idempotency_key FROM work_items)`);
    for (const r of received) {
      if (r.bound !== 1) v.push({ invariant: 'send_bound_to_approval', detail: `${r.action_id} reached the connector without a matching approval` });
      if (r.ostate === 'blocked' || r.ostate === 'pending' || r.ostate === 'failed') v.push({ invariant: 'outbox_state_matches_connector', detail: `${r.action_id} was received by the connector but outbox says ${r.ostate}` });
      if (opts.quiesced && r.ostate === 'dispatching') v.push({ invariant: 'no_stuck_dispatch', detail: `${r.action_id} still dispatching after quiesce` });
    }
    // Superseded before dispatched is never sent.
    for (const r of q(db, `SELECT s.object_id action_id FROM audit_events s JOIN audit_events d ON d.tenant_id=s.tenant_id AND d.object_id=s.object_id
        WHERE s.event_type='proposal_superseded' AND d.event_type='action_dispatched' AND d.seq > s.seq`))
      v.push({ invariant: 'no_dispatch_after_supersede', detail: `${r.action_id} dispatched after it was superseded` });

    // Once claimed for dispatch, a row is never re-checked and "blocked" unless a read-back first
    // proved the request absent and returned it to pending.
    for (const r of q(db, `SELECT DISTINCT b.object_id action_id FROM audit_events b JOIN audit_events d ON d.tenant_id=b.tenant_id AND d.object_id=b.object_id
        WHERE b.event_type='dispatch_blocked' AND d.event_type='action_dispatched' AND d.seq < b.seq
          AND NOT EXISTS (SELECT 1 FROM audit_events r WHERE r.tenant_id=b.tenant_id AND r.object_id=b.object_id AND r.event_type='uncertain_reconciled'
            AND json_extract(r.details,'$.willRetry')=1 AND r.seq > d.seq AND r.seq < b.seq)`))
      v.push({ invariant: 'no_block_after_dispatch', detail: `${r.action_id} was marked blocked after another dispatcher had claimed it` });

    for (const r of q(db, `SELECT o.action_id, o.state, o.external_reference, p.state pstate FROM action_outbox o JOIN proposed_actions p USING (tenant_id, client_id, action_id)
        WHERE o.state IN ('accepted','confirmed')`)) {
      if (!r.external_reference) v.push({ invariant: 'receipt_has_reference', detail: `${r.action_id} ${r.state} without external reference` });
      if (!['accepted', 'confirmed'].includes(r.pstate)) v.push({ invariant: 'outbox_action_agree', detail: `${r.action_id}: outbox ${r.state}, action ${r.pstate}` });
    }
    for (const r of q(db, `SELECT o.action_id, o.state, p.state pstate FROM action_outbox o JOIN proposed_actions p USING (tenant_id, client_id, action_id)
        WHERE o.state='blocked' AND p.state IN ('dispatching','uncertain','accepted','confirmed')`))
      v.push({ invariant: 'outbox_action_agree', detail: `${r.action_id}: outbox blocked but action ${r.pstate}` });
    if (opts.quiesced) {
      for (const r of q(db, `SELECT action_id FROM action_outbox WHERE state='dispatching'`)) v.push({ invariant: 'no_stuck_dispatch', detail: `${r.action_id} still dispatching` });
    }

    for (const t of q(db, 'SELECT tenant_id FROM tenants')) {
      const c = verifyChain(db as unknown as Db, t.tenant_id);
      if (!c.ok) v.push({ invariant: 'audit_chain_intact', detail: `tenant ${t.tenant_id} chain broken at ${c.brokenAt} (${c.events} events)` });
    }
    const one = (sql: string) => Number((db.prepare(sql).get() as Row).n);
    return {
      violations: v,
      stats: {
        accounts: one('SELECT COUNT(*) n FROM accounts'), proposals: one('SELECT COUNT(*) n FROM proposed_actions'), decisions: one('SELECT COUNT(*) n FROM review_decisions'),
        outbox: one('SELECT COUNT(*) n FROM action_outbox'), connectorReceived: received.length, auditEvents: one('SELECT COUNT(*) n FROM audit_events'),
      },
    };
  } finally {
    db.close();
  }
}
