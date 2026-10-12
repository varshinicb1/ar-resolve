// 277 claim status response (005010X212) and 277CA claim acknowledgment (005010X214).
//
// Layout read from the public x12.org examples 005010X212 "Example 1b" and 005010X214
// "Example 01": HL01-HL04 hierarchy (20 information source, 21 receiver, 19 provider,
// 22 subscriber, 23 dependent; PT patient in 277CA), NM1 entity codes PR/41/1P/85/IL/QC,
// TRN02 trace, STC01 composite (category : status : entity), STC02 status date,
// STC03 action code, STC04 total charge, STC05 payment amount, REF*1K payer claim
// control number, REF*EJ patient account number, REF*BLT bill type, DTP*472 service date
// (D8 or RD8). Category and status code descriptions: x12.org code lists.
import { type Delimiters, type Segment, type Transaction, X12Error, dateValue, el, hlNodes, toCents } from './core.ts';

export interface StatusInfo { category: string; code: string; entity: string; date: string | null; action: string; chargeCents: number | null; paidCents: number | null; extra: string[]; segment: number }
export interface ClaimStatus {
  level: string; trace: string; payerClaimControlNumber: string; patientAccount: string; billType: string;
  memberId: string; subscriber: { last: string; first: string }; patientId: string;
  serviceDate: { from: string | null; to: string | null } | null; statuses: StatusInfo[]; segmentRange: [number, number];
}
export interface StatusResponse {
  transaction: 'ST*277'; variant: '277' | '277CA'; control: string; implementationRef: string;
  payer: { name: string; id: string }; receiver: { name: string; id: string };
  receiverStatuses: StatusInfo[]; claims: ClaimStatus[];
}

const CATEGORY = /^[A-Z][A-Z0-9]$/;

export function parseStc(s: Segment, d: Delimiters): StatusInfo {
  const [category, code, entity] = el(s, 1).split(d.component);
  if (!category || !CATEGORY.test(category)) throw new X12Error('bad_stc', `STC01-1 status category missing or invalid at segment ${s.position}`);
  // Additional status composites later in the segment (positions not verified; captured verbatim).
  const extra = s.elements.slice(5).filter((v) => v.includes(d.component));
  return { category, code: code ?? '', entity: entity ?? '', date: dateValue('D8', el(s, 2)).from, action: el(s, 3), chargeCents: toCents(el(s, 4)), paidCents: toCents(el(s, 5)), extra, segment: s.position };
}

export function map277(t: Transaction, d: Delimiters): StatusResponse {
  if (t.setId !== '277') throw new X12Error('wrong_transaction', `Expected 277, found ${t.setId}`);
  const variant = t.implementationRef.startsWith('005010X214') ? '277CA' : '277';
  const { nodes } = hlNodes(t);
  if (!nodes.length) throw new X12Error('missing_segment', '277 has no HL hierarchy');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: StatusResponse = { transaction: 'ST*277', variant, control: t.control, implementationRef: t.implementationRef, payer: { name: '', id: '' }, receiver: { name: '', id: '' }, receiverStatuses: [], claims: [] };
  for (const n of nodes) {
    if (n.parent && !byId.has(n.parent)) throw new X12Error('bad_hl', `HL ${n.id} references unknown parent ${n.parent}`);
    const nm1 = (code: string) => n.segments.find((s) => s.id === 'NM1' && el(s, 1) === code);
    if (n.level === '20') { const p = nm1('PR'); out.payer = { name: el(p, 3), id: el(p, 9) }; continue; }
    if (n.level === '21') {
      const r = nm1('41'); out.receiver = { name: el(r, 3), id: el(r, 9) };
      out.receiverStatuses.push(...n.segments.filter((s) => s.id === 'STC').map((s) => parseStc(s, d)));
      continue;
    }
    if (n.level === '19') continue;
    if (!['22', '23', 'PT'].includes(n.level)) continue;
    // Member id: NM1*IL on this level, or on the parent subscriber level for a dependent.
    const il = nm1('IL') ?? (n.level === '23' ? byId.get(n.parent)?.segments.find((s) => s.id === 'NM1' && el(s, 1) === 'IL') : undefined);
    const qc = nm1('QC');
    const named = il ?? qc;
    let cur: ClaimStatus | null = null;
    let inService = false;
    for (const s of n.segments) {
      if (s.id === 'TRN') {
        cur = { level: n.level, trace: el(s, 2), payerClaimControlNumber: '', patientAccount: '', billType: '', memberId: el(il ?? qc, 9),
          subscriber: { last: el(named, 3), first: el(named, 4) }, patientId: el(qc, 9), serviceDate: null, statuses: [], segmentRange: [s.position, s.position] };
        out.claims.push(cur);
        inService = false;
        continue;
      }
      if (!cur) continue;
      cur.segmentRange[1] = s.position;
      if (s.id === 'SVC') { inService = true; continue; }
      if (s.id === 'STC' && !inService) cur.statuses.push(parseStc(s, d));
      if (s.id === 'REF' && !inService) {
        if (el(s, 1) === '1K') cur.payerClaimControlNumber = el(s, 2);
        if (el(s, 1) === 'EJ') cur.patientAccount = el(s, 2);
        if (el(s, 1) === 'BLT') cur.billType = el(s, 2);
      }
      if (s.id === 'DTP' && el(s, 1) === '472' && !inService) cur.serviceDate = dateValue(el(s, 2), el(s, 3));
    }
  }
  return out;
}

// Status categories in the order a claim moves through them. Used for monotonic,
// out-of-order-tolerant updates: acknowledgment < pending < finalized.
export function categoryRank(category: string): number {
  if (category.startsWith('F')) return 3;
  if (category.startsWith('P') || category.startsWith('R')) return 2;
  if (category.startsWith('A')) return 1;
  return 0;
}
