// Generates synthetic X12 fixtures under fixtures/x12/ from the synthetic cohort.
// Every identifier, name and amount is invented. Run: node scripts/generate-x12-fixtures.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { cohort } from '../server/connectors/synthetic-source.ts';
import { serialize } from '../server/connectors/x12/core.ts';
import { build271, build277, build835, build999, type RemitClaim } from '../server/connectors/x12/responses.ts';
import { IMPLEMENTATION_REFS } from '../server/connectors/x12/generate.ts';

const out = new URL('../fixtures/x12/', import.meta.url);
mkdirSync(out, { recursive: true });
const at = new Date('2026-09-01T10:00:00Z');
const PAYER = { name: 'DEMO PAYER A', id: 'DEMOPAYER' };
const CH = { name: 'SIMULATED CLEARINGHOUSE', id: 'SIMCH' };
const PROVIDER = { name: 'SYNTHETIC PROVIDER', id: 'PRV-SYN-01' };
const CONTRACTUAL = 7500; // synthetic CO-45 reduction per claim

interface Doc { kind: string; content: any }
const docs = (clientId: string, ext: string): Doc[] => cohort().sources[`${clientId}/${ext}`]?.documents as Doc[] ?? [];
const accounts = (clientId: string) => cohort().inventories[clientId].trim().split('\n').slice(1).map((l) => l.split(','))
  .map(([external_id, , provider_id, patient_token, service_date, claim_reference, , balance_cents]) => ({ external_id, provider_id, patient_token, service_date, claim_reference, balance_cents: Number(balance_cents) }));

function remitClaim(clientId: string, ext: string, n: number): RemitClaim | null {
  const eob = docs(clientId, ext).find((d) => d.kind === 'eob')?.content;
  if (!eob) return null;
  const line = eob.lines[0];
  const adj = line.adjustments[0];
  const charge = line.allowedCents + CONTRACTUAL;
  const pr = adj.group === 'PR' ? adj.amountCents : 0;
  const paid = line.allowedCents - adj.amountCents;
  return {
    claimId: eob.claimReference, status: '1', chargeCents: charge, paidCents: paid, patientRespCents: pr, payerControlNumber: `DP${ext.replace(/\D/g, '')}A${n}`,
    patient: { last: 'SYNTHETIC', first: 'PATIENT', memberId: eob.patientToken },
    lines: [{ procedure: 'SYNPROC1', chargeCents: charge, paidCents: paid, serviceDate: eob.serviceDate, allowedCents: line.allowedCents,
      adjustments: [{ group: 'CO', triplets: [['45', CONTRACTUAL]] }, { group: adj.group, triplets: [[adj.carc, adj.amountCents]] }] }],
  };
}

function era(clientId: string, control: number) {
  const claims = accounts(clientId).map((a, i) => remitClaim(clientId, a.external_id, i)).filter((c): c is RemitClaim => !!c);
  const paid = claims.reduce((s, c) => s + c.paidCents, 0);
  return build835({ sender: 'DEMOPAYER', receiver: 'SYNTHPROV', control, at, payer: PAYER, payee: PROVIDER, paymentCents: paid, paymentDate: '2026-09-01', trace: `SYNTRACE${control}`,
    productionDate: '2026-09-01', claims });
}

const files: Record<string, string> = {};
files['835-cl_ortho-era.edi'] = era('cl_ortho', 100000001);
files['835-cl_derm-era.edi'] = era('cl_derm', 100000002);

// Reversal of SYN-C1042's original adjudication and a corrected adjudication (deductible no
// longer applied; coinsurance and copay as two CAS triplets), plus a provider-level adjustment.
{
  const orig = remitClaim('cl_ortho', 'SYN-1042', 1)!;
  const neg = (c: number) => -c;
  const reversal: RemitClaim = { ...orig, status: '22', chargeCents: neg(orig.chargeCents), paidCents: neg(orig.paidCents), patientRespCents: neg(orig.patientRespCents),
    lines: orig.lines.map((l) => ({ ...l, chargeCents: neg(l.chargeCents), paidCents: neg(l.paidCents), allowedCents: null,
      adjustments: l.adjustments.map((a) => ({ group: a.group, triplets: a.triplets.map(([r, amt]) => [r, neg(amt)] as [string, number]) })) })) };
  const charge = orig.chargeCents;
  const correction: RemitClaim = { ...orig, status: '1', paidCents: 34000, patientRespCents: 8500, payerControlNumber: 'DP1042B1',
    lines: [{ procedure: 'SYNPROC1', chargeCents: charge, paidCents: 34000, serviceDate: '2026-06-02', allowedCents: 42500, remarks: ['N1'],
      adjustments: [{ group: 'CO', triplets: [['45', CONTRACTUAL]] }, { group: 'PR', triplets: [['2', 6500], ['3', 2000]] }] }] };
  files['835-cl_ortho-reversal-correction.edi'] = build835({ sender: 'DEMOPAYER', receiver: 'SYNTHPROV', control: 100000003, at: new Date('2026-09-20T10:00:00Z'), payer: PAYER, payee: PROVIDER,
    paymentCents: 34000 - 5000, paymentDate: '2026-09-20', trace: 'SYNTRACE100000003', productionDate: '2026-09-20', claims: [reversal, correction],
    providerAdjustments: [{ providerId: 'PRV-SYN-01', fiscalDate: '2026-12-31', items: [['WO', 'SYN-C9999', 5000]] }] });
}

// ADR 0060: after the clarify_allocation request for SYN-C1042 is accepted (tests run the clock at
// 2026-11-02), the payer reverses the original adjudication and re-adjudicates with no deductible
// applied: paid rises from $0.00 to $425.00. Used by tests/remittance-835.test.ts.
{
  const orig = remitClaim('cl_ortho', 'SYN-1042', 1)!;
  const neg = (c: number) => -c;
  const reversal: RemitClaim = { ...orig, status: '22', chargeCents: neg(orig.chargeCents), paidCents: neg(orig.paidCents), patientRespCents: neg(orig.patientRespCents),
    lines: orig.lines.map((l) => ({ ...l, chargeCents: neg(l.chargeCents), paidCents: neg(l.paidCents), allowedCents: null,
      adjustments: l.adjustments.map((a) => ({ group: a.group, triplets: a.triplets.map(([r, amt]) => [r, neg(amt)] as [string, number]) })) })) };
  const correction: RemitClaim = { ...orig, status: '1', paidCents: 42500, patientRespCents: 0, payerControlNumber: 'DP1042C1',
    lines: [{ procedure: 'SYNPROC1', chargeCents: orig.chargeCents, paidCents: 42500, serviceDate: '2026-06-02', allowedCents: 42500,
      adjustments: [{ group: 'CO', triplets: [['45', CONTRACTUAL]] }] }] };
  files['835-cl_ortho-corrected-after-request.edi'] = build835({ sender: 'DEMOPAYER', receiver: 'SYNTHPROV', control: 100000008, at: new Date('2026-11-12T10:00:00Z'), payer: PAYER, payee: PROVIDER,
    paymentCents: 42500, paymentDate: '2026-11-12', trace: 'SYNTRACE100000008', productionDate: '2026-11-12', claims: [reversal, correction] });
}

// 277 claim status responses for three ortho claims.
{
  const acct = Object.fromEntries(accounts('cl_ortho').map((a) => [a.external_id, a]));
  const q = (ext: string) => ({ trace: `SYN-T-${ext}`, memberId: acct[ext].patient_token, last: 'SYNTHETIC', first: 'PATIENT', claimReference: acct[ext].claim_reference, chargeCents: acct[ext].balance_cents + CONTRACTUAL, serviceDate: acct[ext].service_date });
  files['277-cl_ortho-status.edi'] = build277({ sender: 'SIMCH', receiver: 'SYNTHPROV', control: 100000004, at: new Date('2026-09-15T10:00:00Z'), payer: PAYER, infoReceiver: CH, provider: PROVIDER, reference: 'SYN277-1',
    answers: [
      { query: q('SYN-1042'), category: 'F4', code: '1', statusDate: '2026-09-01', chargeCents: 50000, paidCents: 0, payerClaimControlNumber: 'DP1042A1' },
      { query: q('SYN-1043'), category: 'F4', code: '1', statusDate: '2026-09-01', chargeCents: 25500, paidCents: 0, payerClaimControlNumber: 'DP1043A2' },
      { query: q('SYN-1048'), category: 'P1', code: '20', statusDate: '2026-09-10', chargeCents: 44500, paidCents: null },
    ] });
}

// 271 eligibility responses (two transaction sets in one group) for SYN-1045 and SYN-1048.
{
  const a45 = build271({ sender: 'SIMCH', receiver: 'SYNTHPROV', control: 100000005, at, payer: PAYER, provider: PROVIDER, reference: 'SYN271-1045',
    answer: { query: { trace: 'E-SYN-1045', memberId: 'PT-2B4N', last: 'SYNTHETIC', first: 'PATIENT', serviceDate: '2026-08-05' }, found: true, planBegin: '2026-01-01', planEnd: '2026-12-31',
      planDescription: 'SYNTHETIC PPO', individualLimitCents: 200000, individualRemainingCents: 80000, otherPayer: true } });
  const a48 = build271({ sender: 'SIMCH', receiver: 'SYNTHPROV', control: 100000005, at, payer: PAYER, provider: PROVIDER, reference: 'SYN271-1048',
    answer: { query: { trace: 'E-SYN-1048', memberId: 'PT-6Y5E', last: 'SYNTHETIC', first: 'PATIENT', serviceDate: '2026-08-22' }, found: true, planBegin: '2026-01-01', planEnd: '2026-12-31',
      planDescription: 'SYNTHETIC PPO', individualLimitCents: 200000, individualRemainingCents: 200000, otherPayer: false } });
  // Merge the two single-transaction interchanges into one group with two sets.
  const body = (x: string) => x.split('~\n').filter((s) => /^(?!ISA|GS|GE|IEA|ST|SE)/.test(s) && s).map((s) => s.split('*'));
  files['271-cl_ortho-eligibility.edi'] = serialize({ sender: 'SIMCH', receiver: 'SYNTHPROV', control: 100000005, date: '20260901', time: '1000', usage: 'T', functionalId: 'HB', groupControl: 100000005,
    version: IMPLEMENTATION_REFS['271'], transactions: [
      { setId: '271', control: '0001', implementationRef: IMPLEMENTATION_REFS['271'], body: body(a45) },
      { setId: '271', control: '0002', implementationRef: IMPLEMENTATION_REFS['271'], body: body(a48) },
    ] });
}

files['999-ack.edi'] = build999({ sender: 'SIMCH', receiver: 'SYNTHPROV', control: 100000006, at, group: { functionalId: 'HR', control: '100000010', version: '005010X212' },
  results: [{ setId: '276', control: '0001', accepted: true }, { setId: '276', control: '0002', accepted: false, error: { segment: 'DTP', position: 12, code: '8' } }] });

// 277CA claim acknowledgment (005010X214 layout from the x12.org public example).
files['277ca-cl_ortho-ack.edi'] = serialize({ sender: 'SIMCH', receiver: 'SYNTHPROV', control: 100000007, date: '20260715', time: '1000', usage: 'T', functionalId: 'HN', groupControl: 100000007,
  version: IMPLEMENTATION_REFS['277CA'], transactions: [{ setId: '277', control: '0001', implementationRef: IMPLEMENTATION_REFS['277CA'], body: [
    ['BHT', '0085', '08', 'SYN277CA1', '20260715', '1000', 'TH'],
    ['HL', '1', '', '20', '1'], ['NM1', 'PR', '2', 'DEMO PAYER A', '', '', '', '', 'PI', 'DEMOPAYER'], ['TRN', '1', 'SYNBATCH1'], ['DTP', '050', 'D8', '20260714'], ['DTP', '009', 'D8', '20260715'],
    ['HL', '2', '1', '21', '1'], ['NM1', '41', '2', 'SYNTHETIC PROVIDER', '', '', '', '', '46', 'SYNSUB01'], ['TRN', '2', 'SYNBATCH1'], ['STC', 'A1:19:PR', '20260715', 'WQ', '445'],
    ['HL', '3', '2', '19', '1'], ['NM1', '85', '2', 'SYNTHETIC PROVIDER', '', '', '', '', 'XX', 'PRV-SYN-01'],
    ['HL', '4', '3', 'PT'], ['NM1', 'QC', '1', 'SYNTHETIC', 'PATIENT', '', '', '', 'MI', 'PT-7Q2K'], ['TRN', '2', 'SYN-C1041'], ['STC', 'A2:20', '20260715', 'WQ', '500'], ['REF', '1K', 'DP1041A0'], ['DTP', '472', 'D8', '20260714'],
  ] }] });

for (const [name, text] of Object.entries(files)) writeFileSync(new URL(name, out), text);
console.log(`Wrote ${Object.keys(files).length} synthetic X12 fixtures to fixtures/x12/`);
