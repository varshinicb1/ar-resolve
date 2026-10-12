import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, accountByExt } from './helpers.ts';
import { all, one, run } from '../server/db/db.ts';
import { tick } from '../server/services/outbox.ts';
import { ANALYTICS_EVENTS, sanitizeProperties } from '../server/services/analytics.ts';
import { calculate, variants } from '../shared/economics.ts';
import { baseAssumptions } from '../server/services/kpis.ts';
import { addDays } from '../server/services/calendar.ts';
import { cohort } from '../server/connectors/synthetic-source.ts';
import { approve, clockAt, investigated, resetClock, reviewWb } from './ops-helpers.ts';

after(resetClock);

test('payer pause holds pending dispatches; resume releases only after re-check', async () => {
  const h = await start();
  try {
    const { ana, rui, v, act } = await investigated(h);
    await approve(rui, act, v.account.revision);
    const sam = await h.as('u_sam');
    assert.equal((await ana.post('/api/controls/pause', { dimension: 'payer', value: 'demo-payer', paused: true, reason: 'Payer outage' })).status, 403);
    assert.equal((await sam.post('/api/controls/pause', { dimension: 'payer', value: 'nobody', paused: true, reason: 'Payer outage' })).status, 400);
    assert.equal((await sam.post('/api/controls/pause', { dimension: 'tenant', paused: true, reason: 'Payer outage' })).status, 400);
    const p = await sam.post('/api/controls/pause', { dimension: 'payer', value: 'demo-payer', paused: true, reason: 'Payer outage drill' });
    assert.equal(p.status, 200);
    assert.equal(p.body.held.length, 1);
    assert.equal(p.body.held[0].hold_reason, 'Payer outage drill');
    assert.equal(p.body.held[0].hold_scope_key, 'payer:tn_demo/cl_ortho/demo-payer');
    const r1 = tick(h.db);
    assert.deepEqual([r1.dispatched, r1.skippedPaused], [0, 1]);
    // Payer pause also stops new investigations for that payer's accounts.
    const other = await accountByExt(ana, 'SYN-1043');
    assert.equal((await ana.post(`/api/accounts/${other}/investigate`)).status, 423);
    // A second, workflow pause; resuming the payer leaves the row held under the workflow pause.
    await sam.post('/api/controls/pause', { dimension: 'workflow', value: 'deductible', paused: true, reason: 'Rule review' });
    const resumed = (await sam.post('/api/controls/pause', { dimension: 'payer', value: 'demo-payer', paused: false, reason: 'Outage over' })).body;
    assert.equal(resumed.held.length, 1);
    assert.equal(resumed.held[0].hold_scope_key, 'workflow:tn_demo/cl_ortho/deductible');
    assert.equal(tick(h.db).dispatched, 0);
    await sam.post('/api/controls/pause', { dimension: 'workflow', value: 'deductible', paused: false, reason: 'Rule review done' });
    assert.equal(tick(h.db).dispatched, 1);
    assert.ok(one(h.db, `SELECT 1 FROM audit_events WHERE event_type='dispatch_released'`));
    // Other tenants cannot see or change these controls.
    const bea = await h.as('u_bea', 'tn_other', 'cl_other');
    assert.equal((await bea.get('/api/controls')).status, 403);
    const pauses = (await sam.get('/api/controls')).body.pauses;
    assert.ok(pauses.every((x: any) => x.scopeKey.includes('tn_demo/cl_ortho')));
  } finally { await h.close(); }
});

test('resume re-check blocks a held row whose approver lost the role; write-backs are held too', async () => {
  const h = await start();
  try {
    const { ana, rui, id, v, act } = await investigated(h);
    await approve(rui, act, v.account.revision);
    const sam = await h.as('u_sam');
    await sam.post('/api/controls/pause', { dimension: 'client', paused: true, reason: 'Client hold' });
    const wb = (await ana.post(`/api/accounts/${id}/writebacks`, {})).body;
    await reviewWb(sam, wb);
    tick(h.db); // the new write-back approval is held by the active pause
    assert.equal((await sam.get('/api/controls')).body.held.length, 2);
    run(h.db, `DELETE FROM grants WHERE user_id='u_rui' AND client_id='cl_ortho' AND role='reviewer'`);
    await sam.post('/api/ops/pause', { paused: false, reason: 'Client hold over' });
    const rows = all<{ action_id: string; state: string; last_error: string | null }>(h.db, 'SELECT action_id, state, last_error FROM action_outbox');
    const fin = rows.find((r) => r.action_id === act.actionId)!;
    assert.equal(fin.state, 'blocked');
    assert.match(fin.last_error!, /Re-check on resume failed: approver no longer holds/);
    assert.equal(rows.find((r) => r.action_id === wb.actionId)!.state, 'pending');
    tick(h.db);
    assert.equal(all(h.db, 'SELECT 1 FROM sim_payer_requests').length, 0);
    assert.equal(all(h.db, 'SELECT 1 FROM sim_pm_notes').length, 1);
  } finally { await h.close(); }
});

test('analytics events use opaque ids and enumerated codes only (no PHI, no free text)', async () => {
  clockAt('2026-11-02T15:00:00Z');
  const h = await start();
  try {
    const { ana, rui, id, v, act } = await investigated(h);
    const lee = await h.as('u_lee');
    assert.equal((await rui.post(`/api/actions/${act.actionId}/review-opened`)).body.recorded, true);
    assert.equal((await rui.post(`/api/actions/${act.actionId}/review-opened`)).body.recorded, false, 'once per reviewer');
    assert.equal((await ana.post(`/api/actions/${act.actionId}/review-opened`)).status, 403);
    await approve(rui, act, v.account.revision);
    tick(h.db);
    const wb = (await ana.post(`/api/accounts/${id}/writebacks`, { text: 'Patient PT-3M8D note with claim SYN-C1042.', editReason: 'Include identifiers' })).body;
    await reviewWb(lee, wb);
    tick(h.db);
    // Identity block, conflict, correction and rejection.
    const id44 = await accountByExt(ana, 'SYN-1044');
    await ana.post(`/api/accounts/${id44}/investigate`);
    const c = await investigated(h, 'SYN-1046');
    await c.ana.post(`/api/accounts/${c.id}/calls/simulate`);
    let v46 = (await c.ana.get(`/api/accounts/${c.id}`)).body;
    await rui.post(`/api/accounts/${c.id}/facts/metBeforeCents/correct`, { value: 150000, reason: 'Payer rep confirmed with reference SYN-R1046', expectedRevision: v46.account.revision });
    v46 = (await c.ana.get(`/api/accounts/${c.id}`)).body;
    await lee.post(`/api/actions/${v46.actions[0].actionId}/review`, { decision: 'rejected', rationale: 'Patient Jane Doe should be called first', payloadSha256: v46.actions[0].payloadSha256, accountRevision: v46.account.revision });
    // Follow-up due, outcome reconciled, account reopened.
    const fu = one<{ due_date: string }>(h.db, 'SELECT due_date FROM followup_tasks')!;
    clockAt(`${fu.due_date}T10:00:00Z`);
    tick(h.db);
    const ana2 = await h.as('u_ana');
    await ana2.post('/api/remittance', { format: 'ar-resolve.synthetic-remittance.v1', sourceName: 'r.json',
      lines: [{ claimReference: 'SYN-C1042', payerId: 'demo-payer', lineNumber: 1, adjudicatedDate: addDays('2026-11-02', 5), status: 'corrected', allowedCents: 42500, paidCents: 0, adjustments: [{ group: 'PR', carc: '1', amountCents: 42500 }] }] });

    const rows = all<{ event_name: string; account_id: string | null; object_id: string | null; actor_id: string; properties: string }>(h.db, 'SELECT * FROM analytics_events');
    const names = new Set(rows.map((r) => r.event_name));
    for (const n of ANALYTICS_EVENTS) assert.ok(names.has(n), `missing analytics event ${n}`);
    const c0 = cohort();
    const forbidden = [
      ...c0.inventories.cl_ortho.split('\n').slice(1).filter(Boolean).flatMap((l) => { const f = l.split(','); return [f[0], f[3], f[5]]; }),
      'Jane Doe', 'SYN-R1046', 'PT-3M8D', 'Accumulator shows', '150000',
    ];
    for (const r of rows) {
      const blob = JSON.stringify(r);
      for (const f of forbidden) assert.ok(!blob.includes(f), `analytics event ${r.event_name} leaks ${f}: ${blob}`);
      for (const [k, val] of Object.entries(JSON.parse(r.properties))) {
        const ok = typeof val === 'number' || typeof val === 'boolean' || (typeof val === 'string' && !/\s/.test(val)) || (Array.isArray(val) && val.every((x) => !/\s/.test(x)));
        assert.ok(ok, `${r.event_name}.${k} is not an enumerated code`);
      }
      assert.ok(r.actor_id === 'system' || /^u_[a-z]+$/.test(r.actor_id));
    }
    assert.deepEqual(sanitizeProperties('fact_corrected', { factKey: 'metBeforeCents', previousStatus: 'conflicting', value: 150000, reason: 'free text here' }), { factKey: 'metBeforeCents', previousStatus: 'conflicting' });
    assert.deepEqual(sanitizeProperties('proposal_approved', { kind: 'free text with spaces' }), {});
    assert.throws(() => run(h.db, 'DELETE FROM analytics_events'), /append-only/);
    // Scoped: another tenant's analytics are invisible.
    const bea = await h.as('u_bea', 'tn_other', 'cl_other');
    assert.equal((await bea.get('/api/analytics/events')).body.length, 0);
  } finally { await h.close(); resetClock(); }
});

test('KPIs carry definitions; the economics calculator reproduces the build pack results', async () => {
  const expected: Record<string, number[]> = {
    base: [2.03, 4.2, 2.17, 0.5167, 9.6667, 21700, 105],
    stress: [3.87, 3.3, -0.57, -0.1727, 23.4545, -5700, 174],
    high_quality_low_review: [1.78, 4.8, 3.02, 0.6292, 7.4167, 30200, 105],
  };
  for (const [k, a] of Object.entries(variants(baseAssumptions()))) {
    const r = calculate(a);
    assert.deepEqual([r.direct_cost_per_account, r.revenue_per_account, r.contribution_per_account, r.contribution_margin, r.price_floor_per_resolution, r.monthly_contribution, r.required_concurrent_lines], expected[k], k);
  }
  const h = await start();
  try {
    const { rui, v, act } = await investigated(h);
    await approve(rui, act, v.account.revision);
    tick(h.db);
    const ada = await h.as('u_ada');
    const k = (await ada.get('/api/insights/kpis')).body;
    const m = Object.fromEntries(k.metrics.map((x: any) => [x.id, x]));
    for (const x of k.metrics) assert.ok(x.definition.length > 20, x.id);
    assert.deepEqual([m.dispatch_success.numerator, m.dispatch_success.denominator], [1, 1]);
    assert.deepEqual([m.review_burden.numerator, m.review_burden.denominator], [1, 1]);
    assert.deepEqual([m.abstention_rate.numerator, m.abstention_rate.denominator], [0, 1]);
    assert.ok(k.outcomesByType.some((o: any) => o.entryType === 'request_accepted'));
    assert.match(k.notice, /not accuracy, recovery or productivity results/);
    const e = await ada.post('/api/insights/economics', { overrides: { review_share: 0.5, review_minutes: 8, occupied_minutes_per_attempt: 25, resolution_rate: 0.55 } });
    assert.equal(e.body.results.base.result.direct_cost_per_account, 3.87);
    assert.match(e.body.disclaimer, /not net profit/);
    assert.equal((await ada.post('/api/insights/economics', { overrides: { made_up: 1 } })).status, 400);
    assert.equal((await ada.post('/api/insights/economics', { overrides: { resolution_rate: 2 } })).status, 400);
    const bea = await h.as('u_bea', 'tn_other', 'cl_other');
    const kb = (await bea.get('/api/insights/kpis')).body;
    assert.equal(kb.metrics.find((x: any) => x.id === 'dispatch_success').denominator, 0);
  } finally { await h.close(); }
});
