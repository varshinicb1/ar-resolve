import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, importCohort, accountByExt } from './helpers.ts';

test('cross-tenant and cross-client access is impossible', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    await importCohort(ana);
    const id = await accountByExt(ana, 'SYN-1042');
    const bea = await h.as('u_bea', 'tn_other', 'cl_other');
    await importCohort(bea, 'cl_other');

    // Other tenant, own scope, foreign account id: indistinguishable from not found.
    assert.equal((await bea.get(`/api/accounts/${id}`)).status, 404);
    assert.equal((await bea.post(`/api/accounts/${id}/investigate`)).status, 404);
    assert.equal((await bea.get(`/api/accounts/${id}/audit-export`)).status, 403); // no export role at all
    // Other tenant claims the demo scope via headers: no grant, so the scope does not exist for them.
    const beaSpoof = await h.as('u_bea', 'tn_demo', 'cl_ortho');
    assert.equal((await beaSpoof.get(`/api/accounts/${id}`)).status, 404);
    assert.equal((await beaSpoof.get('/api/accounts')).body.error.code, 'scope_not_found');
    // Same tenant, different client: the account is not visible from cl_derm.
    const anaDerm = await h.as('u_ana', 'tn_demo', 'cl_derm');
    assert.equal((await anaDerm.get(`/api/accounts/${id}`)).status, 404);
    // Search never leaks other-scope matches.
    assert.equal((await bea.get('/api/accounts?q=SYN-1042')).body.total, 0);
    // Unauthenticated
    const r = await fetch(`${h.base}/api/accounts`);
    assert.equal(r.status, 401);
  } finally { await h.close(); }
});

test('roles are enforced server-side', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    await importCohort(ana);
    const id = await accountByExt(ana, 'SYN-1042');
    await ana.post(`/api/accounts/${id}/investigate`);
    const v = (await ana.get(`/api/accounts/${id}`)).body;
    const act = v.actions[0];
    const body = { decision: 'approved', rationale: 'Looks right to me', payloadSha256: act.payloadSha256, accountRevision: v.account.revision };
    assert.equal((await ana.post(`/api/actions/${act.actionId}/review`, body)).status, 403, 'specialist cannot approve');
    const ada = await h.as('u_ada');
    assert.equal((await ada.post(`/api/accounts/${id}/investigate`)).status, 403, 'auditor cannot investigate');
    assert.equal((await ana.get('/api/ops/outbox')).status, 403, 'specialist cannot operate');
    // A client-supplied "approved" flag means nothing.
    assert.equal((await ana.post(`/api/actions/${act.actionId}/review`, { ...body, approved: true, role: 'reviewer' })).status, 403);
  } finally { await h.close(); }
});
