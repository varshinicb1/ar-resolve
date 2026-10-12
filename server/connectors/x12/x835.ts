// 835 Health Care Claim Payment/Advice (005010X221A1) → typed remittance.
//
// Element positions used here and where they were read (details in ADR 0030):
// - BPR02 amount, BPR04 method, BPR16 date; TRN02 trace; DTM*405 production date;
//   N1*PR / N1*PE; CLP01 submitter claim id, CLP02 status, CLP03 charge, CLP04 paid,
//   CLP05 patient responsibility, CLP06 filing indicator, CLP07 payer claim control number;
//   NM1*QC with NM108/NM109; SVC01 composite, SVC02 charge, SVC03 paid; DTM*472 service
//   date; CAS group + reason/amount triplets; AMT*B6 allowed; AMT*AU coverage amount:
//   x12.org public example 005010X221 "Example 01", the CMS 835 companion guide
//   (5010A1, v3.0, 2012) and the CMS 4010A1 Part B companion document (CAS triplet positions
//   CAS02-03, 05-06, ..., 17-18 with quantities in CAS04, 07, ..., 19; PLB01 provider,
//   PLB02 fiscal period date, PLB03 composite reason:reference, PLB04 amount, PLB05-14
//   further pairs).
// - CLP02 = 22 is a reversal of a previous adjudication (Minnesota Uniform Companion Guide
//   v14.0 for 005010X221A1, section 2.2.1).
// - CAS group codes CO, OA, PI, PR and CARC 1 "Deductible Amount": x12.org code lists.
// - LQ*HE remark codes at service level: CMS 835 companion guide ("Only HE applies").
// Balancing (charge - paid = adjustments; BPR02 = sum CLP04 - sum PLB04) is checked and
// reported as informational: no public source read in this session states the formula.
import { type Delimiters, type Segment, type Transaction, X12Error, d8, el, toCents } from './core.ts';

export interface Adjustment { group: string; reason: string; amountCents: number; quantity: string | null; segment: number; triplet: number }
export interface ServiceLine {
  line: number; procedure: string; qualifier: string; modifiers: string[]; chargeCents: number | null; paidCents: number | null; units: string | null;
  serviceDate: string | null; allowedCents: number | null; adjustments: Adjustment[]; remarks: string[]; segment: number; balanced: boolean | null;
}
export interface ClaimPayment {
  claimId: string; statusCode: string; reversal: boolean; chargeCents: number | null; paidCents: number | null; patientRespCents: number | null;
  filingIndicator: string; payerControlNumber: string; patient: { qualifier: string; id: string; last: string; first: string } | null;
  claimDates: { statementFrom: string | null; statementTo: string | null; received: string | null };
  claimAdjustments: Adjustment[]; coverageAmountCents: number | null; lines: ServiceLine[]; remarks: string[];
  segmentRange: [number, number]; balanced: boolean | null; balanceNote: string;
}
export interface ProviderAdjustment { providerId: string; fiscalPeriodDate: string | null; reason: string; reference: string; amountCents: number; segment: number }
export interface Remittance {
  transaction: 'ST*835'; control: string; implementationRef: string;
  payment: { amountCents: number | null; method: string; date: string | null; creditDebit: string };
  trace: string; productionDate: string | null;
  payer: { name: string; id: string }; payee: { name: string; qualifier: string; id: string };
  claims: ClaimPayment[]; providerAdjustments: ProviderAdjustment[];
  balance: { claimsPaidCents: number; plbCents: number; bprCents: number | null; balanced: boolean | null; note: string };
}

function parseCas(s: Segment): Adjustment[] {
  const group = el(s, 1);
  if (!['CO', 'OA', 'PI', 'PR', 'CR'].includes(group)) throw new X12Error('bad_cas', `Unknown CAS group code '${group}' at segment ${s.position}`);
  const out: Adjustment[] = [];
  for (let t = 0; t < 6; t++) {
    const reason = el(s, 2 + t * 3);
    const amount = el(s, 3 + t * 3);
    const qty = el(s, 4 + t * 3);
    if (!reason && !amount) continue;
    if (!reason || amount === '') throw new X12Error('bad_cas', `CAS triplet ${t + 1} at segment ${s.position} is incomplete`);
    out.push({ group, reason, amountCents: toCents(amount)!, quantity: qty || null, segment: s.position, triplet: t + 1 });
  }
  if (!out.length) throw new X12Error('bad_cas', `CAS at segment ${s.position} has no adjustments`);
  return out;
}

function sum(xs: (number | null)[]) { return xs.reduce<number>((a, b) => a + (b ?? 0), 0); }

export function map835(t: Transaction, d: Delimiters): Remittance {
  if (t.setId !== '835') throw new X12Error('wrong_transaction', `Expected 835, found ${t.setId}`);
  const segs = t.segments;
  const bpr = segs.find((s) => s.id === 'BPR');
  if (!bpr) throw new X12Error('missing_segment', '835 has no BPR segment');
  const trn = segs.find((s) => s.id === 'TRN');
  const firstLx = segs.findIndex((s) => s.id === 'LX' || s.id === 'CLP');
  const header = firstLx >= 0 ? segs.slice(0, firstLx) : segs;
  const n1 = (code: string) => header.find((s) => s.id === 'N1' && el(s, 1) === code);
  const prod = header.find((s) => s.id === 'DTM' && el(s, 1) === '405');
  const r: Remittance = {
    transaction: 'ST*835', control: t.control, implementationRef: t.implementationRef,
    payment: { amountCents: toCents(el(bpr, 2)), creditDebit: el(bpr, 3), method: el(bpr, 4), date: d8(el(bpr, 16)) },
    trace: el(trn, 2), productionDate: prod ? d8(el(prod, 2)) : null,
    payer: { name: el(n1('PR'), 2), id: el(n1('PR'), 4) }, payee: { name: el(n1('PE'), 2), qualifier: el(n1('PE'), 3), id: el(n1('PE'), 4) },
    claims: [], providerAdjustments: [], balance: { claimsPaidCents: 0, plbCents: 0, bprCents: null, balanced: null, note: '' },
  };
  let claim: ClaimPayment | null = null;
  let line: ServiceLine | null = null;
  const close = (endPos: number) => { if (claim) claim.segmentRange[1] = endPos; };
  for (const s of segs) {
    switch (s.id) {
      case 'CLP': {
        close(s.position - 1);
        if (!el(s, 1)) throw new X12Error('bad_clp', `CLP01 claim identifier missing at segment ${s.position}`);
        if (!el(s, 2)) throw new X12Error('bad_clp', `CLP02 claim status missing at segment ${s.position}`);
        claim = {
          claimId: el(s, 1), statusCode: el(s, 2), reversal: el(s, 2) === '22', chargeCents: toCents(el(s, 3)), paidCents: toCents(el(s, 4)),
          patientRespCents: toCents(el(s, 5)), filingIndicator: el(s, 6), payerControlNumber: el(s, 7), patient: null,
          claimDates: { statementFrom: null, statementTo: null, received: null }, claimAdjustments: [], coverageAmountCents: null, lines: [], remarks: [],
          segmentRange: [s.position, s.position], balanced: null, balanceNote: '',
        };
        r.claims.push(claim);
        line = null;
        break;
      }
      case 'NM1':
        if (claim && !line && el(s, 1) === 'QC') claim.patient = { qualifier: el(s, 8), id: el(s, 9), last: el(s, 3), first: el(s, 4) };
        break;
      case 'DTM':
        if (!claim) break;
        if (line && el(s, 1) === '472') line.serviceDate = d8(el(s, 2));
        else if (!line && el(s, 1) === '232') claim.claimDates.statementFrom = d8(el(s, 2));
        else if (!line && el(s, 1) === '233') claim.claimDates.statementTo = d8(el(s, 2));
        else if (!line && el(s, 1) === '050') claim.claimDates.received = d8(el(s, 2));
        break;
      case 'SVC': {
        if (!claim) throw new X12Error('bad_svc', `SVC outside a claim at segment ${s.position}`);
        const parts = el(s, 1).split(d.component);
        line = { line: claim.lines.length + 1, qualifier: parts[0] ?? '', procedure: parts[1] ?? '', modifiers: parts.slice(2).filter(Boolean),
          chargeCents: toCents(el(s, 2)), paidCents: toCents(el(s, 3)), units: el(s, 5) || null, serviceDate: null, allowedCents: null, adjustments: [], remarks: [], segment: s.position, balanced: null };
        claim.lines.push(line);
        break;
      }
      case 'CAS':
        if (!claim) throw new X12Error('bad_cas', `CAS outside a claim at segment ${s.position}`);
        (line ? line.adjustments : claim.claimAdjustments).push(...parseCas(s));
        break;
      case 'AMT':
        if (!claim) break;
        if (line && el(s, 1) === 'B6') line.allowedCents = toCents(el(s, 2));
        else if (!line && el(s, 1) === 'AU') claim.coverageAmountCents = toCents(el(s, 2));
        break;
      case 'LQ':
        if (line && el(s, 1) === 'HE') line.remarks.push(el(s, 2));
        break;
      case 'MOA': case 'MIA':
        if (claim) for (const v of s.elements) if (/^[A-Z]{1,2}\d{1,4}$/.test(v)) claim.remarks.push(v);
        break;
      case 'PLB': {
        close(s.position - 1);
        claim = null; line = null;
        for (let p = 0; p < 6; p++) {
          const c = el(s, 3 + p * 2);
          const amt = el(s, 4 + p * 2);
          if (!c && !amt) continue;
          if (!c || amt === '') throw new X12Error('bad_plb', `PLB adjustment ${p + 1} at segment ${s.position} is incomplete`);
          r.providerAdjustments.push({ providerId: el(s, 1), fiscalPeriodDate: d8(el(s, 2)), reason: c.split(d.component)[0], reference: c.split(d.component)[1] ?? '', amountCents: toCents(amt)!, segment: s.position });
        }
        break;
      }
      case 'SE':
        close(s.position - 1);
        break;
    }
  }
  for (const c of r.claims) {
    const adj = sum([...c.claimAdjustments, ...c.lines.flatMap((l) => l.adjustments)].map((a) => a.amountCents));
    if (c.chargeCents !== null && c.paidCents !== null) {
      c.balanced = c.chargeCents - c.paidCents === adj;
      c.balanceNote = `charge ${c.chargeCents} - paid ${c.paidCents} ${c.balanced ? '=' : '≠'} adjustments ${adj}`;
    }
    for (const l of c.lines) {
      l.balanced = l.chargeCents !== null && l.paidCents !== null ? lineBalanced(l) : null;
    }
  }
  r.balance.claimsPaidCents = sum(r.claims.map((c) => c.paidCents));
  r.balance.plbCents = sum(r.providerAdjustments.map((p) => p.amountCents));
  r.balance.bprCents = r.payment.amountCents;
  if (r.payment.amountCents !== null) {
    r.balance.balanced = r.balance.claimsPaidCents - r.balance.plbCents === r.payment.amountCents;
    r.balance.note = 'Informational check (sum CLP04 - sum PLB amounts = BPR02); the formula is not verified from a public source read in this session.';
  }
  return r;
}

export function lineBalanced(l: ServiceLine): boolean {
  if (l.chargeCents === null || l.paidCents === null) return false;
  return l.chargeCents - l.paidCents === sum(l.adjustments.map((a) => a.amountCents));
}
