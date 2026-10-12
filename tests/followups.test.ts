import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, accountByExt } from './helpers.ts';
import { all, one } from '../server/db/db.ts';
import { tick } from '../server/services/outbox.ts';
import { tickFollowups } from '../server/services/followup.ts';
import { computeDue, getCalendar, resolveCalendar, addDays } from '../server/services/calendar.ts';
import { approve, clockAt, investigated, resetClock } from './ops-helpers.ts';

after(resetClock);

test('business-day math skips weekends and OPM holidays; calendar basis rolls forward', async () => {
  const h = await start();
  try {
    const fed = getCalendar(h.db, 'cal_us_federal', 1);
    // Fri 2026-11-20 + 5 business days: Thanksgiving (Thu 11-26) and the weekend are skipped.
    const a = computeDue('2026-11-20', 5, 'days', 'business', fed);
    assert.equal(a.dueDate, '2026-11-30');
    assert.ok(a.skipped.some((s) => s.date === '2026-11-26' && s.reason.includes('Thanksgiving')));
    // Calendar basis: 8 days lands on Saturday 11-28 and moves to Monday.
    assert.equal(computeDue('2026-11-20', 8, 'days', 'calendar', fed).dueDate, '2026-11-30');
    // Two business weeks = ten business days.
    assert.equal(computeDue('2026-11-30', 2, 'weeks', 'business', fed).dueDate, '2026-12-14');
    // Synthetic payer calendar adds an invented 12-24 closure.
    const payer = resolveCalendar(h.db, 'tn_demo', 'cl_ortho', 'demo-payer');
    assert.equal(payer.calendarId, 'cal_demo_payer');
    assert.equal(payer.status, 'synthetic');
    assert.equal(computeDue('2026-12-22', 3, 'days', 'business', fed).dueDate, '2026-12-28');
    assert.equal(computeDue('2026-12-22', 3, 'days', 'business', payer).dueDate, '2026-12-29');
    // Other payers and other tenants fall back to the federal reference calendar.
    assert.equal(resolveCalendar(h.db, 'tn_demo', 'cl_ortho', 'some-other-payer').calendarId, 'cal_us_federal');
    assert.equal(resolveCalendar(h.db, 'tn_other', 'cl_other', 'demo-payer').calendarId, 'cal_us_federal');
    // Beyond the verified holiday coverage the computation warns instead of guessing.
    assert.ok(computeDue('2027-12-20', 30, 'days', 'business', fed).warnings.some((w) => w.includes('only known')));
    assert.equal(fed.source, 'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/');
  } finally { await h.close(); }
});

test('follow-up from a captured payer commitment in a receipt; due date by payer calendar', async () => {
  clockAt('2026-11-20T15:00:00Z');
  const h = await start();
  try {
    const { ana, rui, id, v, act } = await investigated(h);
    assert.equal((await approve(rui, act, v.account.revision)).status, 200);
    tick(h.db);
    const ops = (await ana.get(`/api/accounts/${id}/operations`)).body;
    assert.equal(ops.followups.length, 1);
    const fu = ops.followups[0];
    assert.equal(fu.basis, 'payer_commitment');
    const payer = resolveCalendar(h.db, 'tn_demo', 'cl_ortho', 'demo-payer');
    assert.equal(fu.dueDate, computeDue('2026-11-20', 30, 'days', 'business', payer).dueDate);
    assert.match(fu.label, /Payer commitment \(verified\)/);
    const c = ops.commitments[0];
    assert.deepEqual([c.capture_method, c.status, c.locator.path, c.value, c.unit, c.basis], ['structured', 'verified', 'commitment', 30, 'days', 'business']);
    assert.equal(c.evidence_id, ops.followups[0] && one<{ receipt_evidence_id: string }>(h.db, 'SELECT receipt_evidence_id FROM action_outbox')!.receipt_evidence_id);
    // Promise and accepted request are ledger entries, never recovery.
    const types = ops.ledger.map((e: any) => [e.entryType, e.attribution]);
    assert.deepEqual(types.sort(), [['payer_promise', 'not_applicable'], ['request_accepted', 'not_applicable']]);
    const acct = (await ana.get(`/api/accounts/${id}`)).body.account;
    assert.equal(acct.followupDue, fu.dueDate);
  } finally { await h.close(); resetClock(); }
});

test('no commitment: labelled policy interval; a captured transcript commitment supersedes it', async () => {
  clockAt('2026-11-20T15:00:00Z');
  const h = await start();
  try {
    const { ana } = await investigated(h, 'SYN-1045');
    const id = await accountByExt(ana, 'SYN-1045');
    const p = await ana.post(`/api/accounts/${id}/followups/policy-interval`);
    assert.equal(p.status, 200);
    assert.equal(p.body.basis, 'policy_interval');
    assert.match(p.body.label, /No verified commitment/);
    assert.match(p.body.label, /not a payer promise/);
    assert.equal(p.body.dueDate, '2026-12-07'); // 10 business days, Thanksgiving skipped
    await ana.post(`/api/accounts/${id}/calls/simulate`);
    const view = (await ana.get(`/api/accounts/${id}`)).body;
    const tr = view.evidence.find((e: any) => e.kind === 'call_transcript');
    const other = view.evidence.find((e: any) => e.kind === 'eob');
    // Agent turns are not payer commitments; basis must be stated; locator must resolve.
    assert.equal((await ana.post(`/api/accounts/${id}/commitments`, { evidenceId: tr.evidenceId, locator: { turn: 1 }, kind: 'reprocess', value: 15, unit: 'days', basis: 'business' })).status, 400);
    assert.equal((await ana.post(`/api/accounts/${id}/commitments`, { evidenceId: tr.evidenceId, locator: { turn: 2 }, kind: 'reprocess', value: 15, unit: 'days' })).status, 400);
    assert.equal((await ana.post(`/api/accounts/${id}/commitments`, { evidenceId: other.evidenceId, locator: { path: 'nope.here' }, kind: 'reprocess', value: 15, unit: 'days', basis: 'business' })).status, 400);
    const other1042 = await accountByExt(ana, 'SYN-1042');
    assert.equal((await ana.post(`/api/accounts/${other1042}/commitments`, { evidenceId: tr.evidenceId, locator: { turn: 2 }, kind: 'reprocess', value: 15, unit: 'days', basis: 'business' })).status, 404);
    const ok = await ana.post(`/api/accounts/${id}/commitments`, { evidenceId: tr.evidenceId, locator: { turn: 2 }, kind: 'reprocess', value: 15, unit: 'days', basis: 'calendar' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.followup.basis, 'payer_commitment');
    const fus = all<{ state: string; basis: string }>(h.db, 'SELECT state, basis FROM followup_tasks ORDER BY created_at');
    assert.deepEqual(fus.map((f) => f.state), ['superseded', 'scheduled']);
    const cm = one<{ quote: string; status: string; capture_method: string }>(h.db, 'SELECT quote, status, capture_method FROM payer_commitments')!;
    assert.deepEqual([cm.status, cm.capture_method], ['reported', 'specialist']);
    assert.match(cm.quote, /processed on August 19/);
  } finally { await h.close(); resetClock(); }
});

test('worker tick moves follow-ups to due then overdue; snooze and completion', async () => {
  clockAt('2026-11-20T15:00:00Z');
  const h = await start();
  try {
    const { ana } = await investigated(h, 'SYN-1043');
    const id = await accountByExt(ana, 'SYN-1043');
    const fu = (await ana.post(`/api/accounts/${id}/followups/policy-interval`)).body;
    assert.equal(tickFollowups(h.db).due, 0);
    clockAt(`${fu.dueDate}T10:00:00Z`);
    assert.equal(tick(h.db).followupsDue, 1);
    const ana2 = await h.as('u_ana');
    let q = (await ana2.get('/api/followups')).body;
    assert.equal(q.counts.due_today, 1);
    clockAt(`${addDays(fu.dueDate, 1)}T10:00:00Z`);
    assert.deepEqual(tickFollowups(h.db), { due: 0, overdue: 1, unsnoozed: 0 });
    const ana3 = await h.as('u_ana');
    q = (await ana3.get('/api/followups?bucket=overdue')).body;
    assert.equal(q.items.length, 1);
    // Snooze needs a reason and a bounded future date.
    assert.equal((await ana3.post(`/api/followups/${fu.followupId}/snooze`, { until: addDays(fu.dueDate, 3) })).status, 400);
    assert.equal((await ana3.post(`/api/followups/${fu.followupId}/snooze`, { until: addDays(fu.dueDate, 60), reason: 'Payer system outage' })).status, 400);
    assert.equal((await ana3.post(`/api/followups/${fu.followupId}/snooze`, { until: addDays(fu.dueDate, 3), reason: 'Payer system outage' })).status, 200);
    clockAt(`${addDays(fu.dueDate, 2)}T10:00:00Z`);
    tickFollowups(h.db);
    assert.equal(one<{ state: string }>(h.db, 'SELECT state FROM followup_tasks')!.state, 'snoozed');
    clockAt(`${addDays(fu.dueDate, 3)}T10:00:00Z`);
    assert.equal(tickFollowups(h.db).unsnoozed, 1);
    assert.equal(one<{ state: string }>(h.db, 'SELECT state FROM followup_tasks')!.state, 'overdue');
    // followup_due is emitted once per task, not on every transition.
    assert.equal(all(h.db, `SELECT 1 FROM analytics_events WHERE event_name='followup_due'`).length, 1);
    const ana4 = await h.as('u_ana');
    assert.equal((await ana4.post(`/api/followups/${fu.followupId}/complete`, { code: 'made_up' })).status, 400);
    const done = await ana4.post(`/api/followups/${fu.followupId}/complete`, { code: 'status_obtained' });
    assert.deepEqual([done.status, done.body.onTime], [200, false]);
    assert.equal((await ana4.post(`/api/followups/${fu.followupId}/complete`, { code: 'status_obtained' })).status, 409);
    const kpi = (await ana4.get('/api/insights/kpis')).body.metrics.find((m: any) => m.id === 'followup_adherence');
    assert.deepEqual([kpi.numerator, kpi.denominator], [0, 1]);
  } finally { await h.close(); resetClock(); }
});

test('follow-up scope isolation and permissions', async () => {
  const h = await start();
  try {
    const { ana } = await investigated(h, 'SYN-1043');
    const id = await accountByExt(ana, 'SYN-1043');
    const fu = (await ana.post(`/api/accounts/${id}/followups/policy-interval`)).body;
    const bea = await h.as('u_bea', 'tn_other', 'cl_other');
    assert.equal((await bea.get('/api/followups')).body.items.length, 0);
    assert.equal((await bea.post(`/api/followups/${fu.followupId}/snooze`, { until: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10), reason: 'not mine at all' })).status, 404);
    assert.equal((await bea.post(`/api/accounts/${id}/followups/policy-interval`)).status, 404);
    const beaWrong = await h.as('u_bea');
    assert.equal((await beaWrong.get('/api/followups')).status, 404);
    const ada = await h.as('u_ada');
    assert.equal((await ada.get('/api/followups')).body.items.length, 1);
    assert.equal((await ada.post(`/api/followups/${fu.followupId}/complete`, { code: 'status_obtained' })).status, 403);
    const adaDerm = await h.as('u_ada', 'tn_demo', 'cl_derm');
    assert.equal((await adaDerm.get('/api/followups')).status, 404);
    const sam = await h.as('u_sam');
    assert.equal((await ana.post('/api/followup-policy', { intervalValue: 5, intervalUnit: 'days', basis: 'business', reason: 'Client asked for weekly' })).status, 403);
    const pol = await sam.post('/api/followup-policy', { intervalValue: 5, intervalUnit: 'days', basis: 'business', reason: 'Client asked for weekly' });
    assert.deepEqual([pol.status, pol.body.version], [200, 2]);
    const derm = await h.as('u_sam', 'tn_demo', 'cl_derm');
    assert.equal((await derm.get('/api/followup-policy')).body.version, 1, 'policy is per client');
    // Calendars: a supervisor version is unverified and scoped to the client.
    const cal = await sam.post('/api/calendars', { name: 'Client closure days', payerId: 'demo-payer', holidays: [{ date: '2026-12-26', name: 'Client closure' }], reason: 'Client office closed' });
    assert.deepEqual([cal.status, cal.body.status], [200, 'unverified']);
    assert.equal((await bea.get('/api/calendars')).body.some((c: any) => c.calendarId === cal.body.calendarId), false);
  } finally { await h.close(); }
});
