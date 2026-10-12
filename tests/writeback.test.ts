import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.ts';
import { all, one } from '../server/db/db.ts';
import { tick } from '../server/services/outbox.ts';
import { setPmFault } from '../server/connectors/sim-pm.ts';
import { investigated, reviewWb } from './ops-helpers.ts';

test('write-back happy path: preview, separate permission, hash-bound review, read-back verified', async () => {
  const h = await start();
  try {
    const { ana, rui, id, v } = await investigated(h);
    const ops = (await ana.get(`/api/accounts/${id}/operations`)).body;
    assert.equal(ops.writeback.field, 'account_notes');
    assert.equal(ops.writeback.record.recordVersion, 1);
    assert.match(ops.writeback.record.pmRecordId, /^PM-SYN-/);
    assert.ok(ops.writeback.draft.text.includes('SYSTEM-DRAFTED NOTE'));
    const wb = (await ana.post(`/api/accounts/${id}/writebacks`, { expectedRevision: v.account.revision })).body;
    assert.equal(wb.edited, false);
    // The specialist cannot approve; the financial review path refuses write-backs.
    assert.equal((await reviewWb(ana, wb)).status, 403);
    assert.equal((await rui.post(`/api/actions/${wb.actionId}/review`, { decision: 'approved', rationale: 'wrong path test', payloadSha256: wb.payloadSha256, accountRevision: wb.accountRevision })).body.error.code, 'wrong_review_path');
    assert.equal((await reviewWb(rui, { ...wb, payloadSha256: 'x'.repeat(64) })).status, 409);
    assert.equal((await reviewWb(rui, wb)).status, 200);
    // The DED01 proposal is unaffected and still the account's current proposal.
    const view = (await ana.get(`/api/accounts/${id}`)).body;
    assert.equal(view.actions.length, 1);
    assert.equal(view.actions[0].kind, 'clarify_allocation');
    tick(h.db);
    const list = (await ana.get(`/api/accounts/${id}/writebacks`)).body;
    assert.equal(list[0].displayState, 'written_verified');
    assert.equal(list[0].approver, 'u_rui');
    assert.equal(list[0].readBack.matched, true);
    const note = one<{ text: string; field: string }>(h.db, 'SELECT text, field FROM sim_pm_notes')!;
    assert.equal(note.text, ops.writeback.draft.text);
    assert.equal(note.field, 'account_notes');
    assert.equal((await ana.get(`/api/accounts/${id}`)).body.account.state, 'awaiting_review', 'write-back does not move the account workflow');
    assert.equal(all(h.db, `SELECT 1 FROM analytics_events WHERE event_name='writeback_confirmed'`).length, 1);
    assert.equal(all(h.db, `SELECT 1 FROM analytics_events WHERE event_name='action_receipt_received'`).length, 0);
    // A write-back gets no payer follow-up.
    assert.equal(all(h.db, 'SELECT 1 FROM followup_tasks').length, 0);
  } finally { await h.close(); }
});

test('edited notes keep the original draft, the edit reason and the approver; separation of duties', async () => {
  const h = await start();
  try {
    const { ana, rui, id } = await investigated(h);
    const sam = await h.as('u_sam');
    assert.equal((await ana.post(`/api/accounts/${id}/writebacks`, { text: 'Shorter note.' })).status, 400);
    const wb = (await ana.post(`/api/accounts/${id}/writebacks`, { text: 'Called payer; deductible allocation questioned. See verified facts.', editReason: 'Shortened for PM field' })).body;
    assert.equal(wb.edited, true);
    // A reviewer who drafts a note cannot approve it.
    const own = (await rui.post(`/api/accounts/${id}/writebacks`, {})).body;
    assert.equal((await reviewWb(rui, own)).status, 403);
    // The newer draft superseded the edited one.
    assert.equal((await reviewWb(sam, wb)).body.error.code, 'not_reviewable');
    const wb2 = (await ana.post(`/api/accounts/${id}/writebacks`, { text: 'Called payer; deductible allocation questioned.', editReason: 'Final wording' })).body;
    assert.equal((await reviewWb(sam, wb2)).status, 200, 'a supervisor holds approve_writeback');
    tick(h.db);
    const list = (await ana.get(`/api/accounts/${id}/writebacks`)).body;
    const done = list.find((w: any) => w.actionId === wb2.actionId);
    assert.equal(done.displayState, 'written_verified', 'supervisor approver passes the dispatch re-check');
    assert.equal(done.approver, 'u_sam');
    assert.equal(done.editedBy, 'u_ana');
    assert.equal(done.editReason, 'Final wording');
    assert.ok(done.originalDraft.includes('SYSTEM-DRAFTED NOTE'));
    assert.ok(done.diff.added.includes('Called payer; deductible allocation questioned.'));
    assert.equal(list.filter((w: any) => w.state === 'superseded').length, 2);
  } finally { await h.close(); }
});

test('stale revision and stale PM record block write-back; nothing is written', async () => {
  const h = await start();
  try {
    // Account revision changes between draft and review.
    const { ana, rui, id } = await investigated(h, 'SYN-1046');
    const wb = (await ana.post(`/api/accounts/${id}/writebacks`, {})).body;
    await ana.post(`/api/accounts/${id}/calls/simulate`);
    const r = await reviewWb(rui, wb);
    assert.equal(r.body.error.code, 'stale_review');
    assert.equal((await ana.get(`/api/accounts/${id}/writebacks`)).body[0].state, 'superseded');
    // PM record edited elsewhere after approval: the connector preflight refuses.
    const second = await investigated(h, 'SYN-1042');
    const wb2 = (await second.ana.post(`/api/accounts/${second.id}/writebacks`, {})).body;
    assert.equal((await reviewWb(rui, wb2)).status, 200);
    const sam = await h.as('u_sam');
    await sam.post(`/api/sim-pm/${second.id}/touch`);
    tick(h.db);
    const w = (await ana.get(`/api/accounts/${second.id}/writebacks`)).body[0];
    assert.equal(w.displayState, 'failed');
    assert.equal(w.state, 'stale_blocked');
    assert.match(w.outbox.last_error, /Preflight failed: PM record changed/);
    assert.equal(all(h.db, 'SELECT 1 FROM sim_pm_notes').length, 0);
    // Touching before approval is caught at review time.
    const wb3 = (await second.ana.post(`/api/accounts/${second.id}/writebacks`, {})).body;
    await sam.post(`/api/sim-pm/${second.id}/touch`);
    assert.equal((await reviewWb(rui, wb3)).body.error.code, 'pm_record_changed');
  } finally { await h.close(); }
});

test('read-back mismatch stays writeback_uncertain until reconciled by read-back; lag reconciles without resubmission', async () => {
  const h = await start();
  try {
    const { ana, rui, id } = await investigated(h);
    const sam = await h.as('u_sam');
    setPmFault(h.db, 'pm_alters_note', 1);
    const wb = (await ana.post(`/api/accounts/${id}/writebacks`, {})).body;
    await reviewWb(rui, wb);
    assert.equal(tick(h.db).uncertain, 1);
    let w = (await ana.get(`/api/accounts/${id}/writebacks`)).body[0];
    assert.equal(w.displayState, 'writeback_uncertain');
    assert.equal(w.readBack.matched, false);
    assert.notEqual((await ana.get(`/api/accounts/${id}`)).body.account.state, 'receipt_uncertain');
    // The worker's read-back sees the mismatch and keeps it uncertain: never "success".
    tick(h.db);
    w = (await ana.get(`/api/accounts/${id}/writebacks`)).body[0];
    assert.equal(w.displayState, 'writeback_uncertain');
    assert.ok(one(h.db, `SELECT 1 FROM audit_events WHERE event_type='reconcile_failed'`));
    assert.equal(all(h.db, `SELECT 1 FROM analytics_events WHERE event_name='writeback_confirmed'`).length, 0);
    assert.equal((await ana.post(`/api/writebacks/${wb.actionId}/readback`)).status, 403);
    assert.equal((await sam.post(`/api/sim-pm/correct/${wb.actionId}`)).status, 200);
    const rb = await sam.post(`/api/writebacks/${wb.actionId}/readback`);
    assert.equal(rb.body.state, 'confirmed');
    w = (await ana.get(`/api/accounts/${id}/writebacks`)).body[0];
    assert.deepEqual([w.displayState, w.outbox.attempts], ['written_verified', 1]);
    assert.equal(all(h.db, 'SELECT 1 FROM sim_pm_notes').length, 1);

    // Replication lag: the first read-back misses the note; the next tick finds it.
    setPmFault(h.db, 'pm_readback_lag', 1);
    const wb2 = (await ana.post(`/api/accounts/${id}/writebacks`, { text: 'Follow-up note two.', editReason: 'Second note' })).body;
    await reviewWb(rui, wb2);
    tick(h.db);
    assert.equal((await ana.get(`/api/accounts/${id}/writebacks`)).body[0].displayState, 'writeback_uncertain');
    tick(h.db);
    const w2 = (await ana.get(`/api/accounts/${id}/writebacks`)).body[0];
    assert.deepEqual([w2.displayState, w2.outbox.attempts], ['written_verified', 1]);
    assert.equal(all(h.db, 'SELECT 1 FROM sim_pm_notes').length, 2);
  } finally { await h.close(); }
});

test('write-back scope isolation', async () => {
  const h = await start();
  try {
    const { ana, id } = await investigated(h);
    const wb = (await ana.post(`/api/accounts/${id}/writebacks`, {})).body;
    const bea = await h.as('u_bea', 'tn_other', 'cl_other');
    assert.equal((await bea.get(`/api/accounts/${id}/writebacks`)).status, 404);
    assert.equal((await bea.post(`/api/accounts/${id}/writebacks`, {})).status, 404);
    assert.equal((await bea.post(`/api/writebacks/${wb.actionId}/review`, { decision: 'approved', rationale: 'cross tenant', payloadSha256: wb.payloadSha256, accountRevision: wb.accountRevision })).status, 404);
    const ada = await h.as('u_ada');
    assert.equal((await ada.get(`/api/accounts/${id}/writebacks`)).status, 200);
    assert.equal((await ada.post(`/api/accounts/${id}/writebacks`, {})).status, 403);
    assert.equal((await reviewWb(ada, wb)).status, 403);
    const adaDerm = await h.as('u_ada', 'tn_demo', 'cl_derm');
    assert.equal((await adaDerm.get(`/api/accounts/${id}/operations`)).status, 404);
    // The audit packet carries write-backs for auditors.
    const pkt = (await ada.get(`/api/accounts/${id}/audit-export`)).body;
    assert.equal(pkt.operations.writebacks.length, 1);
  } finally { await h.close(); }
});
