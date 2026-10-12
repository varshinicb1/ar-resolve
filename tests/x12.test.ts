import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseInterchange, parseStrict, reserialize, serialize, toCents, fromCents, X12Error, DEFAULT_DELIMITERS } from '../server/connectors/x12/core.ts';
import { parseEdi } from '../server/connectors/x12/index.ts';
import { build270, build276 } from '../server/connectors/x12/generate.ts';
import { lineBalanced } from '../server/connectors/x12/x835.ts';

const DIR = new URL('../fixtures/x12/', import.meta.url);
const fixture = (n: string) => readFileSync(new URL(n, DIR), 'utf8');
const at = new Date('2026-09-01T10:00:00Z');

test('every synthetic fixture parses strictly and round-trips byte for byte', () => {
  const names = readdirSync(DIR).filter((n) => n.endsWith('.edi'));
  assert.ok(names.length >= 7);
  for (const n of names) {
    const raw = fixture(n);
    const x = parseStrict(raw);
    assert.equal(reserialize(x), raw, `${n} round trip`);
    assert.ok(parseEdi(raw).transactions.length >= 1, n);
  }
});

test('276 and 270 generators produce valid envelopes that parse back to the same request', () => {
  const claims = [{ trace: 'S-SYN-1042', memberId: 'PT-3M8D', last: 'SYNTHETIC', first: 'PATIENT', claimReference: 'SYN-C1042', chargeCents: 42550, serviceDate: '2026-06-02' },
    { trace: 'S-SYN-1043', memberId: 'PT-9X1A', last: 'SYNTHETIC', first: 'PATIENT', claimReference: 'SYN-C1043', chargeCents: 18000, serviceDate: '2026-05-21' }];
  const raw = build276({ sender: 'ARRSYN', receiver: 'SIMCH', control: 7, at, payer: { name: 'DEMO PAYER A', id: 'DEMOPAYER' }, submitter: { name: 'S', id: 'S1' }, provider: { name: 'P', id: 'PRV-SYN-01' }, reference: 'R1', claims });
  const t = parseEdi(raw).transactions[0];
  assert.equal(t.setId, '276');
  assert.deepEqual((t.data as { claims: unknown }).claims, claims);
  const raw270 = build270({ sender: 'ARRSYN', receiver: 'SIMCH', control: 8, at, payer: { name: 'DEMO PAYER A', id: 'DEMOPAYER' }, provider: { name: 'P', id: 'PRV-SYN-01' }, reference: 'R2', originator: 'ARRSYN',
    query: { trace: 'E-SYN-1045', memberId: 'PT-2B4N', last: 'SYNTHETIC', first: 'PATIENT', serviceDate: '2026-08-05' } });
  const e = parseEdi(raw270).transactions[0];
  assert.equal(e.setId, '270');
  assert.deepEqual((e.data as { query: unknown }).query, { trace: 'E-SYN-1045', memberId: 'PT-2B4N', last: 'SYNTHETIC', first: 'PATIENT', serviceDate: '2026-08-05' });
  assert.equal(parseStrict(raw).isa.elements.length, 16);
  assert.equal(raw.indexOf('~'), 105, 'ISA is exactly 106 characters');
});

test('alternative delimiters declared in the ISA are honored', () => {
  const d = { element: '|', component: '>', repetition: '^', segment: '\'' };
  const raw = serialize({ sender: 'A', receiver: 'B', control: 9, date: '20260901', time: '1000', usage: 'T', functionalId: 'HP', groupControl: 9, version: '005010X221A1', delimiters: d,
    transactions: [{ setId: '835', control: '0001', implementationRef: '005010X221A1', body: [['BPR', 'H', '0', 'C', 'NON'], ['TRN', '1', 'T1'], ['CLP', 'SYN-C1', '1', '100', '0', '100', '12', 'X1'], ['SVC', 'HC>SYNPROC1', '100', '0'], ['CAS', 'PR', '1', '100']] }] }, false);
  const r = parseEdi(raw).transactions[0];
  assert.equal(r.setId, '835');
  const claim = (r.data as { claims: { lines: { procedure: string }[] }[] }).claims[0];
  assert.equal(claim.lines[0].procedure, 'SYNPROC1');
});

test('malformed interchanges are rejected with specific reasons', () => {
  const good = fixture('835-cl_ortho-era.edi');
  const code = (raw: string) => { try { parseEdi(raw); return 'ok'; } catch (e) { return (e as X12Error).code; } };
  // Wrong segment count in SE01.
  const badSe = good.replace(/SE\*(\d+)\*0001/, (_m, n) => `SE*${Number(n) + 1}*0001`);
  assert.equal(code(badSe), 'envelope_invalid');
  assert.ok(parseInterchange(badSe).issues.some((i) => i.code === 'count_mismatch' && i.segment === 'SE'));
  // GE01 transaction count and IEA02 control number.
  assert.ok(parseInterchange(good.replace('GE*1*', 'GE*2*')).issues.some((i) => i.code === 'count_mismatch' && i.segment === 'GE'));
  assert.ok(parseInterchange(good.replace(/IEA\*1\*\d+/, 'IEA*1*999999999')).issues.some((i) => i.code === 'control_mismatch'));
  assert.ok(parseInterchange(good.replace(/SE\*(\d+)\*0001/, 'SE*$1*0002')).issues.some((i) => i.code === 'control_mismatch' && i.segment === 'SE'));
  // Wrong delimiters: ISA field widths altered so position 106 is not the terminator.
  assert.ok(['bad_delimiter', 'bad_isa'].includes(code(good.replace('*00*          *', '*00*         *'))), 'ISA must be exactly 106 characters');
  assert.equal(code(good.slice(0, 106) + good.slice(106).replace(/\*/g, '|')), 'bad_segment', 'body must use the delimiters the ISA declares');
  assert.equal(code(good.replace(/^ISA\*/, 'ISA|')), 'bad_isa');
  // Truncated: cut mid-file.
  assert.equal(code(good.slice(0, Math.floor(good.length * 0.7))), 'truncated');
  assert.equal(code(good.slice(0, good.lastIndexOf('GE*'))), 'envelope_invalid');
  assert.equal(code(good.slice(0, 50)), 'truncated_isa');
  assert.equal(code('GS*HP*X~'), 'no_isa');
  // Bad data inside an otherwise valid envelope.
  assert.equal(code(good.replace('AMT*B6*425', 'AMT*B6*425.123')), 'bad_amount');
  assert.equal(code(good.replace('CAS*PR*1*425', 'CAS*ZZ*1*425')), 'bad_cas');
  assert.equal(code(good.replace('DTM*472*20260602', 'DTM*472*20260231')), 'bad_date');
  assert.equal(code(good.replace(/ST\*835/, 'ST*837')), 'unsupported_transaction');
});

test('money parsing is exact and never uses floating point rounding', () => {
  assert.equal(toCents('425'), 42500);
  assert.equal(toCents('425.5'), 42550);
  assert.equal(toCents('-0.07'), -7);
  assert.equal(toCents('.5'), 50);
  assert.equal(toCents(''), null);
  assert.throws(() => toCents('1.005'));
  assert.throws(() => toCents('1e3'));
  for (const c of [0, 1, 10, 99, 100, 42550, -42500, 123456789]) assert.equal(toCents(fromCents(c)), c);
});

test('835: reversal (CLP02 22), corrected claim, multiple CAS triplets and PLB', () => {
  const t = parseEdi(fixture('835-cl_ortho-reversal-correction.edi')).transactions[0];
  assert.equal(t.setId, '835');
  const r = t.data as import('../server/connectors/x12/x835.ts').Remittance;
  assert.equal(r.claims.length, 2);
  const [rev, cor] = r.claims;
  assert.equal(rev.reversal, true);
  assert.equal(rev.statusCode, '22');
  assert.equal(rev.chargeCents, -50000);
  assert.equal(rev.payerControlNumber, 'DP1042A1');
  assert.deepEqual(rev.lines[0].adjustments.map((a) => [a.group, a.reason, a.amountCents]), [['CO', '45', -7500], ['PR', '1', -42500]]);
  assert.equal(cor.reversal, false);
  const pr = cor.lines[0].adjustments.filter((a) => a.group === 'PR');
  assert.deepEqual(pr.map((a) => [a.reason, a.amountCents, a.triplet]), [['2', 6500, 1], ['3', 2000, 2]], 'two triplets in one CAS segment');
  assert.equal(cor.lines[0].allowedCents, 42500);
  assert.deepEqual(cor.lines[0].remarks, ['N1']);
  assert.ok(lineBalanced(cor.lines[0]));
  assert.equal(cor.balanced, true);
  assert.equal(rev.balanced, true);
  assert.deepEqual(r.providerAdjustments.map((p) => [p.reason, p.reference, p.amountCents]), [['WO', 'SYN-C9999', 5000]]);
  assert.equal(r.balance.bprCents, 29000);
  assert.equal(r.balance.balanced, true);
});

test('271, 277, 277CA and 999 mappers read the synthetic fixtures', () => {
  const e = parseEdi(fixture('271-cl_ortho-eligibility.edi')).transactions;
  assert.equal(e.length, 2);
  const s45 = (e[0].data as import('../server/connectors/x12/x271.ts').EligibilityResponse).subjects[0];
  assert.equal(s45.memberId, 'PT-2B4N');
  assert.equal(s45.deductible.individualLimitCents, 200000);
  assert.equal(s45.deductible.individualRemainingCents, 80000);
  assert.equal(s45.otherPayer.reported, true);
  assert.deepEqual(s45.dates['291'], { from: '2026-01-01', to: '2026-12-31' });
  const s48 = (e[1].data as import('../server/connectors/x12/x271.ts').EligibilityResponse).subjects[0];
  assert.equal(s48.otherPayer.reported, false);

  const st = parseEdi(fixture('277-cl_ortho-status.edi')).transactions[0].data as import('../server/connectors/x12/x277.ts').StatusResponse;
  assert.equal(st.variant, '277');
  assert.deepEqual(st.claims.map((c) => [c.patientAccount, c.statuses[0].category, c.statuses[0].code, c.payerClaimControlNumber]),
    [['SYN-C1042', 'F4', '1', 'DP1042A1'], ['SYN-C1043', 'F4', '1', 'DP1043A2'], ['SYN-C1048', 'P1', '20', '']]);
  const ca = parseEdi(fixture('277ca-cl_ortho-ack.edi')).transactions[0].data as import('../server/connectors/x12/x277.ts').StatusResponse;
  assert.equal(ca.variant, '277CA');
  assert.equal(ca.receiverStatuses[0].category, 'A1');
  assert.equal(ca.claims[0].statuses[0].category, 'A2');
  assert.equal(ca.claims[0].payerClaimControlNumber, 'DP1041A0');

  const ack = parseEdi(fixture('999-ack.edi')).transactions[0].data as import('../server/connectors/x12/x999.ts').ImplementationAck;
  assert.equal(ack.groupDisposition, 'P');
  assert.deepEqual(ack.counts, { included: 2, received: 2, accepted: 1 });
  assert.equal(ack.transactions[1].disposition, 'R');
  assert.equal(ack.transactions[1].errors[0].segmentId, 'DTP');
  void DEFAULT_DELIMITERS;
});
