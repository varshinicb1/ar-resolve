// ADR 0060: an ingested 835 feeds remittance reconciliation and the outcome ledger.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accountByExt, start, type Client } from './helpers.ts';
import { all } from '../server/db/db.ts';
import { tick } from '../server/services/outbox.ts';
import { verifyLedger } from '../server/services/outcomes.ts';
import { claimToLines } from '../server/connectors/remit-835.ts';
import { parseEdi } from '../server/connectors/x12/index.ts';
import { approve, clockAt, investigated, resetClock } from './ops-helpers.ts';

after(resetClock);
const fixture = (n: string) => readFileSync(new URL(`../fixtures/x12/${n}`, import.meta.url), 'utf8');

async function ingest(c: Client, name: string, content = fixture(name)) {
  const p = await c.post('/api/integrations/edi/preview', { filename: name, content });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const r = await c.post('/api/integrations/edi/ingest', { filename: name, content, expectedSha256: p.body.rawSha256 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const ledger = async (c: Client, id: string) => (await c.get(`/api/outcomes/ledger?accountId=${id}`)).body.entries as any[];

test('835 mapping: one remittance line per SVC loop, exact cents, reversal keeps signs and marks allowed as unreported', () => {
  const { transactions } = parseEdi(fixture('835-cl_ortho-corrected-after-request.edi'));
  const t = transactions[0];
  assert.equal(t.setId, '835');
  const r = t.setId === '835' ? t.data : null!;
  const [rev, corr] = r.claims;
  const a = claimToLines(rev, 'demo-payer', '2026-11-12', 'reversal');
  assert.deepEqual(a.problems, []);
  assert.deepEqual(a.lines[0], { claimReference: 'SYN-C1042', payerId: 'demo-payer', adjudicatedDate: '2026-11-12', status: 'reversal', payerClaimControl: 'DP1042A1',
    lineNumber: 1, allowedCents: 0, allowedReported: false, paidCents: 0, adjustments: [{ group: 'CO', carc: '45', amountCents: -7500 }, { group: 'PR', carc: '1', amountCents: -42500 }] });
  const b = claimToLines(corr, 'demo-payer', '2026-11-12', 'corrected');
  assert.deepEqual(b.lines[0].adjustments, [{ group: 'CO', carc: '45', amountCents: 7500 }]);
  assert.equal(b.lines[0].paidCents, 42500);
  assert.equal(b.lines[0].allowedCents, 42500);
  // A non-reversal line without AMT*B6 is not mapped (no allowed amount is invented).
  const noAllowed = claimToLines({ ...corr, lines: [{ ...corr.lines[0], allowedCents: null }] }, 'demo-payer', '2026-11-12', 'original');
  assert.match(noAllowed.problems.join(), /AMT\*B6/);
});

test('835 ingest reconciles: baseline from the ERA, then a reversal + correction after an accepted request is attributable and resolves', async () => {
  const h = await start();
  try {
    clockAt('2026-11-02T15:00:00Z');
    const ctx = await investigated(h);
    assert.equal((await approve(ctx.rui, ctx.act, ctx.v.account.revision)).status, 200);
    tick(h.db);
    const sam = await h.as('u_sam');

    // The original ERA: matching lines become baselines (no change can be measured), nothing reopens.
    const era = await ingest(sam, '835-cl_ortho-era.edi');
    const rem = era.report.remittance;
    assert.equal(rem.payerKey, 'DEMOPAYER');
    assert.equal(rem.payerId, 'demo-payer');
    assert.equal(rem.mapping.id, 'x12-835-remittance-lines');
    assert.ok(rem.batchId);
    assert.equal(rem.results.length, 8, 'one line per identity-matched claim');
    assert.ok(rem.skipped.some((s: any) => s.claimReference === 'SYN-C1044' && s.reason === 'identity_identity_mismatch'), 'identity mismatch is never reconciled');
    assert.deepEqual(rem.reopened, []);
    const before = await ledger(ctx.ana, ctx.id);
    const unchanged = before.find((e) => e.entryType === 'adjudication_unchanged');
    assert.ok(unchanged, 'the ERA deductible equals the verified EOB deductible');
    assert.equal(unchanged.sourceType, 'remittance_line');
    assert.equal((await ctx.ana.get(`/api/accounts/${ctx.id}`)).body.account.state !== 'specialist_review', true);

    // Reversal + corrected claim with no deductible: paired reversal does not reopen; the favourable change is attributable.
    clockAt('2026-11-14T15:00:00Z');
    const sam2 = await h.as('u_sam');
    const ana2 = await h.as('u_ana');
    const fix = await ingest(sam2, '835-cl_ortho-corrected-after-request.edi');
    const r2 = fix.report.remittance;
    assert.deepEqual(r2.results.map((x: any) => x.outcome), ['reversal_paired', 'changed']);
    assert.deepEqual(r2.resolved, [ctx.id]);
    assert.equal(fix.report.evaluations[ctx.id].reevaluated, false, 'a resolved account is not re-evaluated by the same ingest');
    const after1 = await ledger(ana2, ctx.id);
    const changed = after1.find((e) => e.entryType === 'adjudication_changed');
    assert.equal(changed.attribution, 'attributable');
    assert.equal(changed.deltaCents, 42500);
    assert.equal(changed.actionId, ctx.act.actionId);
    assert.ok(after1.some((e) => e.entryType === 'reversal' && /paired/.test(e.attributionReason)));
    const acct = (await ana2.get(`/api/accounts/${ctx.id}`)).body;
    assert.equal(acct.account.state, 'resolved');
    assert.ok(acct.evidence.some((e: any) => e.kind === 'edi_835'));
    assert.ok(acct.evidence.some((e: any) => e.kind === 'remittance'));
    assert.equal(verifyLedger(h.db, 'tn_demo').ok, true);

    // Batches are visible in the operations remittance view; identical lines from another file are duplicates.
    const view = (await ana2.get('/api/remittance')).body;
    assert.equal(view.batches.filter((b: any) => b.format === 'ar-resolve.remittance-lines.v1').length, 2);
    const copy = fixture('835-cl_ortho-corrected-after-request.edi').replace('SYNTRACE100000008', 'SYNTRACE100000009');
    const dup = await ingest(sam2, 'copy.edi', copy);
    assert.ok(dup.report.remittance.results.every((x: any) => x.status === 'duplicate'));
  } finally { await h.close(); resetClock(); }
});

test('835 reversal without a correction reopens the account; a payer outside the crosswalk is not reconciled', async () => {
  const h = await start();
  try {
    clockAt('2026-11-02T15:00:00Z');
    const ctx = await investigated(h);
    const sam = await h.as('u_sam');
    await ingest(sam, '835-cl_ortho-era.edi');
    const rev = fixture('835-cl_ortho-corrected-after-request.edi');
    // Keep only the reversal claim: drop the correction CLP loop and fix the counts and amounts.
    const segs = rev.split('~\n').filter(Boolean);
    const second = segs.findIndex((s, i) => i > 0 && s.startsWith('CLP*SYN-C1042*1*'));
    const kept = [...segs.slice(0, second), ...segs.slice(segs.findIndex((s) => s.startsWith('SE*')))]
      .map((s) => s.startsWith('BPR*') ? s.replace('BPR*I*425*C*ACH', 'BPR*H*0*C*NON') : s);
    const seCount = kept.filter((s) => !/^(ISA|GS|GE|IEA)\*/.test(s)).length;
    const onlyReversal = kept.map((s) => s.startsWith('SE*') ? `SE*${seCount}*0001` : s).join('~\n') + '~\n';
    const before = (await ctx.ana.get(`/api/accounts/${ctx.id}`)).body.account.revision;
    const r = await ingest(sam, 'reversal-only.edi', onlyReversal);
    assert.deepEqual(r.report.remittance.results.map((x: any) => x.outcome), ['reversal']);
    assert.deepEqual(r.report.remittance.reopened, [ctx.id]);
    const acct = (await ctx.ana.get(`/api/accounts/${ctx.id}`)).body;
    assert.equal(acct.account.state, 'specialist_review');
    assert.equal(acct.account.revision, before + 1);
    assert.ok(acct.timeline.some((e: any) => e.eventType === 'account_reopened' && e.details.cause === 'reversal'));

    // An empty crosswalk: nothing is reconciled, every claim is reported with the reason.
    assert.equal((await sam.post('/api/integrations/connectors/edi_upload/settings', { settings: { payerCrosswalk: {} } })).status, 200);
    assert.equal((await sam.post('/api/integrations/connectors/edi_upload/settings', { settings: { payerCrosswalk: { DEMOPAYER: 'bad id!' } } })).status, 400);
    const n = all(h.db, 'SELECT 1 FROM remittance_lines').length;
    const x = await ingest(sam, 'derm-as-ortho.edi', fixture('835-cl_ortho-era.edi').replace('SYNTRACE100000001', 'SYNTRACE100000099'));
    assert.equal(x.report.remittance.lines, 0);
    assert.ok(x.report.remittance.skipped.every((s: any) => s.reason === 'payer_not_in_crosswalk'));
    assert.equal(all(h.db, 'SELECT 1 FROM remittance_lines').length, n);
  } finally { await h.close(); resetClock(); }
});

test('835 reconciliation is scoped: another client never matches; a specialist cannot ingest', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    await (await import('./helpers.ts')).importCohort(ana);
    const samDerm = await h.as('u_sam', 'tn_demo', 'cl_derm');
    // The ortho ERA ingested under cl_derm: no claim matches, so nothing reaches the ledger.
    const r = await ingest(samDerm, '835-cl_ortho-era.edi');
    assert.equal(r.report.remittance.lines, 0);
    assert.ok(r.report.remittance.skipped.every((s: any) => s.reason === 'identity_unmatched'));
    assert.equal(all(h.db, 'SELECT 1 FROM outcome_ledger').length, 0);
    assert.equal((await ana.post('/api/integrations/edi/preview', { content: fixture('835-cl_ortho-era.edi') })).status, 403);
    // Once ortho has a remittance batch, neither another client nor another tenant can see it.
    await ingest(await h.as('u_sam'), '835-cl_ortho-era.edi');
    assert.equal((await ana.get('/api/remittance')).body.batches.length, 1);
    assert.equal((await samDerm.get('/api/remittance')).body.batches.length, 0);
    const bea = await h.as('u_bea', 'tn_other', 'cl_other');
    assert.equal((await bea.get('/api/remittance')).body.batches.length, 0);
    assert.ok(await accountByExt(ana, 'SYN-1042'));
  } finally { await h.close(); }
});
