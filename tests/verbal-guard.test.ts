// ADR 0060: a request the payer accepted verbally on a call is not approved or dispatched
// again until it is reconciled (receipt, adjudication change, no request on file, or a
// reviewer release with a reason).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, importCohort, accountByExt, type Client } from './helpers.ts';
import { all } from '../server/db/db.ts';
import { setClock } from '../server/util.ts';
import { tick } from '../server/services/outbox.ts';

// Tuesday 10:00 in the synthetic payer's timezone, ticking.
const BUSINESS = Date.parse('2026-10-13T15:00:00Z');
const t0 = Date.now();
setClock(() => new Date(BUSINESS + (Date.now() - t0)));
after(() => setClock(null));

const approve = (c: Client, act: any, revision: number) =>
  c.post(`/api/actions/${act.actionId}/review`, { decision: 'approved', rationale: 'Accumulator shows deductible met before this claim', payloadSha256: act.payloadSha256, accountRevision: revision });

async function acceptedOnCall() {
  const h = await start();
  const ana = await h.as('u_ana');
  const rui = await h.as('u_rui');
  const sam = await h.as('u_sam');
  await importCohort(ana);
  assert.equal((await sam.post('/api/calls/policy', { patch: { verbalReprocessingPreauthorized: true }, reason: 'Client pre-authorized verbal reprocessing requests for DED01' })).status, 200);
  const id = await accountByExt(ana, 'SYN-1042');
  const inv = await ana.post(`/api/accounts/${id}/investigate`);
  assert.equal(inv.body.outcome, 'clarify_allocation');
  return { h, ana, rui, sam, id, firstActionId: inv.body.actionId as string };
}

async function runCall(c: Client, id: string) {
  const s = await c.post(`/api/accounts/${id}/calls`, {});
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal((await c.post(`/api/calls/${s.body.callId}/advance`, { steps: 200 })).status, 200);
  return (await c.get(`/api/calls/${s.body.callId}`)).body;
}

test('verbal acceptance blocks approval of a new same-class request until a reviewer releases it with a reason', async () => {
  const { h, ana, rui, id, firstActionId } = await acceptedOnCall();
  try {
    const call = await runCall(ana, id);
    assert.equal(call.answers.find((a: any) => a.key === 'reprocessingCommitment').value.status, 'accepted_by_rep');
    let v = (await ana.get(`/api/accounts/${id}`)).body;
    assert.equal(v.actions.find((a: any) => a.actionId === firstActionId).state, 'superseded');

    // A later re-investigation produces a new clarify_allocation proposal...
    const re = await ana.post(`/api/accounts/${id}/investigate`);
    assert.equal(re.status, 200, JSON.stringify(re.body));
    v = (await ana.get(`/api/accounts/${id}`)).body;
    const act = v.actions.find((a: any) => a.state === 'awaiting_review' && a.kind === 'clarify_allocation');
    assert.ok(act, 'a new proposal exists');
    // ...but it cannot be approved while the verbal request is unreconciled.
    const listed = (await ana.get(`/api/accounts/${id}/verbal-requests`)).body;
    assert.equal(listed.requests.length, 1);
    assert.equal(listed.requests[0].reconciled, false);
    assert.equal(listed.guard.id, 'VERBAL01');
    const blocked = await approve(rui, act, v.account.revision);
    assert.equal(blocked.status, 422, JSON.stringify(blocked.body));
    const failed = blocked.body.error?.details ?? blocked.body.details ?? blocked.body;
    assert.match(JSON.stringify(failed), /no_open_verbal_request/);

    // Release: reviewer only, reason required, append-only, audited, once.
    const answerId = listed.requests[0].answerId;
    assert.equal((await ana.post(`/api/verbal-requests/${answerId}/release`, { reason: 'Payer portal shows no reprocessing request on file' })).status, 403);
    assert.equal((await rui.post(`/api/verbal-requests/${answerId}/release`, { reason: 'too short' })).status, 400);
    const rel = await rui.post(`/api/verbal-requests/${answerId}/release`, { reason: 'Payer portal shows no reprocessing request on file' });
    assert.equal(rel.status, 200, JSON.stringify(rel.body));
    assert.equal((await rui.post(`/api/verbal-requests/${answerId}/release`, { reason: 'Payer portal shows no reprocessing request on file' })).status, 409);
    assert.throws(() => all(h.db, `UPDATE verbal_request_overrides SET reason='x'`), /append-only/);
    const after1 = (await ana.get(`/api/accounts/${id}/verbal-requests`)).body.requests[0];
    assert.equal(after1.reconciledBy.type, 'reviewer_override');
    assert.equal(after1.reconciledBy.by, 'u_rui');
    v = (await ana.get(`/api/accounts/${id}`)).body;
    assert.ok(v.timeline.some((e: any) => e.eventType === 'verbal_request_released'));
    assert.equal((await approve(rui, act, v.account.revision)).status, 200);
  } finally { await h.close(); }
});

test('an approved request is blocked at dispatch when the payer accepts the same request verbally first; a receipt reconciles', async () => {
  const { h, ana, rui, id, firstActionId } = await acceptedOnCall();
  try {
    let v = (await ana.get(`/api/accounts/${id}`)).body;
    const act = v.actions.find((a: any) => a.actionId === firstActionId);
    assert.equal((await approve(rui, act, v.account.revision)).status, 200);
    // Simulate the verbal acceptance landing between approval and dispatch.
    const callId = 'call_test_verbal';
    h.db.prepare(`INSERT INTO voice_calls (tenant_id, client_id, call_id, account_id, payer_id, destination, scenario_id, plan_id, plan_version, policy_version, policy_sha256, adapter, provider_call_id,
      state, plan, line_state, hold_timeout_ms, idempotency_key, account_revision_at_start, next_step_at, created_by, created_at, updated_at)
      VALUES ('tn_demo','cl_ortho',?,?,'demo-payer','sim:demo-payer/provider-services','DED01','plan',1,1,'x','sim','p1','completed','{}','{}',1,'k1',1,?, 'u_ana', ?, ?)`)
      .run(callId, id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    h.db.prepare(`INSERT INTO voice_answers VALUES ('tn_demo','cl_ortho',?, 'ans_test', 'request_reprocessing', 'reprocessingCommitment', NULL, ?, NULL, 'answered', '[5]', NULL, '[]', ?, ?)`)
      .run(callId, JSON.stringify({ kind: 'reprocessing_request', status: 'accepted_by_rep', tat: null }), new Date().toISOString(), new Date().toISOString());
    const rep = tick(h.db);
    assert.equal(rep.dispatched, 0);
    v = (await ana.get(`/api/accounts/${id}`)).body;
    assert.equal(v.actions.find((a: any) => a.actionId === firstActionId).state, 'stale_blocked');
    assert.ok(v.timeline.some((e: any) => e.eventType === 'dispatch_blocked' && /verbally/.test(JSON.stringify(e.details))));
    // A payer receipt recorded after the acceptance reconciles it.
    h.db.prepare(`INSERT INTO evidence VALUES ('tn_demo','cl_ortho',?, 'ev_rcpt_test', 'action_receipt', 'Receipt', 'test', '{}', 'h', ?, NULL, 'system')`).run(id, new Date(Date.now() + 1000).toISOString());
    const req = (await ana.get(`/api/accounts/${id}/verbal-requests`)).body.requests[0];
    assert.equal(req.reconciled, true);
    assert.equal(req.reconciledBy.type, 'receipt');
  } finally { await h.close(); }
});

test('verbal request guard is scoped: other tenants cannot read or release; auditors read only', async () => {
  const { h, ana, id } = await acceptedOnCall();
  try {
    await runCall(ana, id);
    const answerId = (await ana.get(`/api/accounts/${id}/verbal-requests`)).body.requests[0].answerId;
    const bea = await h.as('u_bea', 'tn_other', 'cl_other');
    assert.equal((await bea.get(`/api/accounts/${id}/verbal-requests`)).status, 404);
    assert.equal((await bea.post(`/api/verbal-requests/${answerId}/release`, { reason: 'Cross-tenant release attempt here' })).status, 404);
    const derm = await h.as('u_rui', 'tn_demo', 'cl_derm');
    assert.equal((await derm.post(`/api/verbal-requests/${answerId}/release`, { reason: 'Cross-client release attempt here' })).status, 404);
    const ada = await h.as('u_ada');
    assert.equal((await ada.get(`/api/accounts/${id}/verbal-requests`)).status, 200);
    assert.equal((await ada.post(`/api/verbal-requests/${answerId}/release`, { reason: 'Auditor cannot release requests' })).status, 403);
  } finally { await h.close(); }
});
