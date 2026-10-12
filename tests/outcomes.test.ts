import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, accountByExt, type Harness } from './helpers.ts';
import { all, one, run } from '../server/db/db.ts';
import { tick } from '../server/services/outbox.ts';
import { verifyLedger } from '../server/services/outcomes.ts';
import { addDays } from '../server/services/calendar.ts';
import { approve, clockAt, investigated, resetClock } from './ops-helpers.ts';

after(resetClock);
const DAY0 = '2026-11-02';

const line = (claimReference: string, adjudicatedDate: string, deductible: number, paid: number, status = 'corrected', lineNumber = 1) =>
  ({ claimReference, payerId: 'demo-payer', lineNumber, adjudicatedDate, status, allowedCents: 42500, paidCents: paid,
    adjustments: deductible ? [{ group: 'PR', carc: '1', amountCents: deductible }] : [] });
const remit = (lines: unknown[]) => ({ format: 'ar-resolve.synthetic-remittance.v1', sourceName: 'synthetic.json', lines });

// SYN-1042 asks the payer to clarify a $425.00 deductible that should have been $0.00.
async function acceptedRequest(h: Harness) {
  clockAt(`${DAY0}T15:00:00Z`);
  const ctx = await investigated(h);
  assert.equal((await approve(ctx.rui, ctx.act, ctx.v.account.revision)).status, 200);
  tick(h.db);
  return ctx;
}

test('remittance matches by claim and line; favourable change after an accepted request is attributable and resolves', async () => {
  const h = await start();
  try {
    const { id } = await acceptedRequest(h);
    clockAt(`${addDays(DAY0, 10)}T15:00:00Z`);
    const ana = await h.as('u_ana');
    const r = await ana.post('/api/remittance', remit([line('SYN-C1042', addDays(DAY0, 9), 0, 42500), line('SYN-C9999', addDays(DAY0, 9), 0, 100, 'original')]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.results.map((x: any) => x.matchStatus), ['matched', 'unmatched']);
    const ledger = (await ana.get(`/api/outcomes/ledger?accountId=${id}`)).body;
    const changed = ledger.entries.find((e: any) => e.entryType === 'adjudication_changed');
    assert.equal(changed.attribution, 'attributable');
    assert.equal(changed.attributionRule, 'ATTR01@1');
    assert.equal(changed.deltaCents, 42500);
    assert.ok(changed.actionId);
    assert.equal(ledger.rule.windowDays, 90);
    const acct = (await ana.get(`/api/accounts/${id}`)).body.account;
    assert.equal(acct.state, 'resolved');
    // Idempotent: the same line again is a duplicate, not a second outcome.
    const again = await ana.post('/api/remittance', remit([line('SYN-C1042', addDays(DAY0, 9), 0, 42500)]));
    assert.equal(again.body.results[0].status, 'duplicate');
    // Cash equal to the remitted paid amount is attributable up to the paid increase.
    const cash = await ana.post('/api/cash-postings', { postings: [{ claimReference: 'SYN-C1042', payerId: 'demo-payer', lineNumber: 1, amountCents: 42500, postedDate: addDays(DAY0, 12), depositReference: 'DEP-SYN-1' }] });
    assert.equal(cash.status, 200);
    const cashEntry = (await ana.get(`/api/outcomes/ledger?accountId=${id}`)).body.entries.find((e: any) => e.entryType === 'cash_posted');
    assert.equal(cashEntry.attribution, 'attributable');
    // A malformed file is rejected as a whole.
    const bad = await ana.post('/api/remittance', remit([{ ...line('SYN-C1042', 'yesterday', 0, 1) }]));
    assert.equal(bad.status, 400);
    assert.equal(verifyLedger(h.db, 'tn_demo').ok, true);
    const kinds = (await ana.get('/api/outcomes/ledger')).body.entries.map((e: any) => e.entryType);
    for (const k of ['payer_promise', 'request_accepted', 'adjudication_changed', 'cash_posted']) assert.ok(kinds.includes(k), k);
  } finally { await h.close(); resetClock(); }
});

test('attribution: no approved request, or outside the window, is not attributable', async () => {
  const h = await start();
  try {
    await acceptedRequest(h);
    const ana = await h.as('u_ana');
    const id43 = await accountByExt(ana, 'SYN-1043');
    await ana.post(`/api/accounts/${id43}/investigate`);
    clockAt(`${addDays(DAY0, 120)}T15:00:00Z`);
    const ana2 = await h.as('u_ana');
    const v43 = (await ana2.get(`/api/accounts/${id43}`)).body;
    const applied = v43.facts.find((f: any) => f.key === 'appliedCents').value;
    await ana2.post('/api/remittance', remit([line('SYN-C1043', addDays(DAY0, 100), Math.max(0, applied - 1000), 1000)]));
    await ana2.post('/api/remittance', remit([line('SYN-C1042', addDays(DAY0, 100), 0, 42500)]));
    const entries = (await ana2.get('/api/outcomes/ledger')).body.entries.filter((e: any) => e.entryType === 'adjudication_changed');
    const by = (ext: string) => entries.find((e: any) => e.externalId === ext);
    assert.equal(by('SYN-1043').attribution, 'not_attributable');
    assert.match(by('SYN-1043').attributionReason, /No approved request/);
    assert.equal(by('SYN-1042').attribution, 'not_attributable');
    assert.match(by('SYN-1042').attributionReason, /within 90 days/);
  } finally { await h.close(); resetClock(); }
});

test('contradictions reopen the account: unchanged after accepted request, reversal, cash mismatch', async () => {
  const h = await start();
  try {
    const { id } = await acceptedRequest(h);
    clockAt(`${addDays(DAY0, 20)}T15:00:00Z`);
    const ana = await h.as('u_ana');
    const before = (await ana.get(`/api/accounts/${id}`)).body.account.revision;
    await ana.post('/api/remittance', remit([line('SYN-C1042', addDays(DAY0, 19), 42500, 0)]));
    let acct = (await ana.get(`/api/accounts/${id}`)).body;
    assert.equal(acct.account.state, 'specialist_review');
    assert.equal(acct.account.revision, before + 1, 'reopening bumps the revision so pending approvals lose authority');
    assert.ok(acct.timeline.some((e: any) => e.eventType === 'account_reopened' && e.details.cause === 'request_not_reflected'));
    await ana.post('/api/remittance', remit([line('SYN-C1042', addDays(DAY0, 25), 0, -42500, 'reversal')]));
    await ana.post('/api/cash-postings', { postings: [{ claimReference: 'SYN-C1042', payerId: 'demo-payer', lineNumber: 1, amountCents: 999, postedDate: addDays(DAY0, 26), depositReference: 'DEP-SYN-2' }] });
    acct = (await ana.get(`/api/accounts/${id}`)).body;
    const causes = acct.timeline.filter((e: any) => e.eventType === 'account_reopened').map((e: any) => e.details.cause);
    assert.deepEqual(causes, ['request_not_reflected', 'reversal', 'cash_mismatch']);
    assert.equal(all(h.db, `SELECT 1 FROM analytics_events WHERE event_name='account_reopened'`).length, 3);
    const contradictions = all(h.db, `SELECT 1 FROM outcome_ledger WHERE entry_type='contradiction'`).length;
    assert.equal(contradictions, 3);
  } finally { await h.close(); resetClock(); }
});

test('outcome ledger is append-only, hash-chained, exportable by auditors only, and scoped', async () => {
  const h = await start();
  try {
    await acceptedRequest(h);
    assert.throws(() => run(h.db, `UPDATE outcome_ledger SET amount_cents=1`), /append-only/);
    assert.throws(() => run(h.db, `DELETE FROM outcome_ledger`), /append-only/);
    const ada = await h.as('u_ada');
    const exp = await ada.get('/api/outcomes/ledger/export');
    assert.equal(exp.status, 200);
    assert.equal(exp.body.chain.ok, true);
    assert.equal(exp.body.entries.length, 2);
    assert.match(exp.body.packetSha256, /^[0-9a-f]{64}$/);
    assert.ok(one(h.db, `SELECT 1 FROM audit_events WHERE event_type='outcome_ledger_exported'`));
    const ana = await h.as('u_ana');
    assert.equal((await ana.get('/api/outcomes/ledger/export')).status, 403);
    assert.equal((await ana.get('/api/outcomes/ledger')).body.entries.length, 2);
    // Another tenant cannot see or match into this tenant's accounts.
    const bea = await h.as('u_bea', 'tn_other', 'cl_other');
    assert.equal((await bea.get('/api/outcomes/ledger')).body.entries.length, 0);
    const r = await bea.post('/api/remittance', remit([line('SYN-C1042', DAY0, 0, 42500)]));
    assert.equal(r.body.results[0].matchStatus, 'unmatched');
    assert.throws(() => run(h.db, `UPDATE remittance_lines SET paid_cents=1`), /immutable/);
    assert.equal((await ada.post('/api/remittance', remit([line('SYN-C1042', DAY0, 0, 42500)]))).status, 403);
    const adaDerm = await h.as('u_ada', 'tn_demo', 'cl_derm');
    assert.equal((await adaDerm.get('/api/outcomes/ledger')).status, 404);
  } finally { await h.close(); resetClock(); }
});
