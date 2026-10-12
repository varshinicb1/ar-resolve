// Request parsers (276, 270) and response builders (277, 271, 835, 999) used by the
// simulated clearinghouse and the synthetic fixture generator. Same layouts and sources as
// x277.ts / x271.ts / x835.ts / x999.ts; nothing here talks to a real system.
import { type Delimiters, type Transaction, X12Error, d8, el, fromCents, hlNodes, serialize, toCents, toD8 } from './core.ts';
import { FUNCTIONAL_IDS, IMPLEMENTATION_REFS, type EligibilityQuery, type Party, type StatusQuery } from './generate.ts';

export interface ParsedStatusRequest { payer: Party; submitter: Party; provider: Party; claims: StatusQuery[] }

export function parse276(t: Transaction): ParsedStatusRequest {
  if (t.setId !== '276') throw new X12Error('wrong_transaction', `Expected 276, found ${t.setId}`);
  const { nodes } = hlNodes(t);
  const party = (lvl: string, code: string): Party => {
    const s = nodes.find((n) => n.level === lvl)?.segments.find((x) => x.id === 'NM1' && el(x, 1) === code);
    return { name: el(s, 3), id: el(s, 9) };
  };
  const claims: StatusQuery[] = [];
  for (const n of nodes.filter((x) => x.level === '22' || x.level === '23')) {
    const nm = n.segments.find((s) => s.id === 'NM1' && (el(s, 1) === 'IL' || el(s, 1) === 'QC'));
    const trn = n.segments.find((s) => s.id === 'TRN');
    const ej = n.segments.find((s) => s.id === 'REF' && el(s, 1) === 'EJ');
    const amt = n.segments.find((s) => s.id === 'AMT' && el(s, 1) === 'T3');
    const dtp = n.segments.find((s) => s.id === 'DTP' && el(s, 1) === '472');
    if (!trn || !nm) throw new X12Error('bad_276', `276 subscriber loop HL ${n.id} lacks TRN or NM1`);
    claims.push({ trace: el(trn, 2), memberId: el(nm, 9), last: el(nm, 3), first: el(nm, 4), claimReference: el(ej, 2), chargeCents: toCents(el(amt, 2)) ?? 0,
      serviceDate: d8(el(dtp, 3).split('-')[0]) ?? '' });
  }
  return { payer: party('20', 'PR'), submitter: party('21', '41'), provider: party('19', '1P'), claims };
}

export function parse270(t: Transaction): { payer: Party; provider: Party; query: EligibilityQuery } {
  if (t.setId !== '270') throw new X12Error('wrong_transaction', `Expected 270, found ${t.setId}`);
  const { nodes } = hlNodes(t);
  const sub = nodes.find((n) => n.level === '22');
  if (!sub) throw new X12Error('bad_270', '270 has no subscriber level');
  const nm = sub.segments.find((s) => s.id === 'NM1' && el(s, 1) === 'IL');
  const trn = sub.segments.find((s) => s.id === 'TRN');
  const dtp = sub.segments.find((s) => s.id === 'DTP' && el(s, 1) === '291');
  const p = (lvl: string, code: string): Party => { const s = nodes.find((n) => n.level === lvl)?.segments.find((x) => x.id === 'NM1' && el(x, 1) === code); return { name: el(s, 3), id: el(s, 9) }; };
  return { payer: p('20', 'PR'), provider: p('21', '1P'), query: { trace: el(trn, 2), memberId: el(nm, 9), last: el(nm, 3), first: el(nm, 4), serviceDate: d8(el(dtp, 3)) ?? '' } };
}

function stamp(at: Date) {
  const iso = at.toISOString();
  return { date: iso.slice(0, 10).replace(/-/g, ''), time: iso.slice(11, 16).replace(':', '') };
}

export interface Env { sender: string; receiver: string; control: number; at: Date; delimiters?: Delimiters }

function wrap(e: Env, setKey: string, setId: string, body: string[][]): string {
  const { date, time } = stamp(e.at);
  return serialize({ sender: e.sender, receiver: e.receiver, control: e.control, date, time, usage: 'T', functionalId: FUNCTIONAL_IDS[setId].code, groupControl: e.control,
    version: IMPLEMENTATION_REFS[setKey], transactions: [{ setId, control: '0001', implementationRef: IMPLEMENTATION_REFS[setKey], body }], delimiters: e.delimiters });
}

export interface StatusAnswer { query: StatusQuery; category: string; code: string; entity?: string; statusDate: string; chargeCents: number | null; paidCents: number | null; payerClaimControlNumber?: string }

export function build277(e: Env & { payer: Party; infoReceiver: Party; provider: Party; answers: StatusAnswer[]; reference: string }): string {
  const { date, time } = stamp(e.at);
  const c = e.delimiters?.component ?? ':';
  const body: string[][] = [
    ['BHT', '0010', '08', e.reference, date, time, 'DG'],
    ['HL', '1', '', '20', '1'], ['NM1', 'PR', '2', e.payer.name, '', '', '', '', 'PI', e.payer.id],
    ['HL', '2', '1', '21', '1'], ['NM1', '41', '2', e.infoReceiver.name, '', '', '', '', '46', e.infoReceiver.id],
    ['HL', '3', '2', '19', '1'], ['NM1', '1P', '2', e.provider.name, '', '', '', '', 'XX', e.provider.id],
  ];
  e.answers.forEach((a, i) => {
    const comp = [a.category, a.code, a.entity ?? ''].filter((x, j) => j < 2 || x).join(c);
    body.push(['HL', String(4 + i), '3', '22', '0'], ['NM1', 'IL', '1', a.query.last, a.query.first, '', '', '', 'MI', a.query.memberId], ['TRN', '2', a.query.trace],
      ['STC', comp, toD8(a.statusDate), '', a.chargeCents === null ? '' : fromCents(a.chargeCents), a.paidCents === null ? '' : fromCents(a.paidCents)]);
    if (a.payerClaimControlNumber) body.push(['REF', '1K', a.payerClaimControlNumber]);
    if (a.query.claimReference) body.push(['REF', 'EJ', a.query.claimReference]);
    if (a.query.serviceDate) body.push(['DTP', '472', 'D8', toD8(a.query.serviceDate)]);
  });
  return wrap(e, '277', '277', body);
}

export interface EligibilityAnswer {
  query: EligibilityQuery; found: boolean; planBegin?: string; planEnd?: string; planDescription?: string;
  individualLimitCents?: number | null; individualRemainingCents?: number | null; otherPayer?: boolean; rejectCode?: string;
}

export function build271(e: Env & { payer: Party; provider: Party; answer: EligibilityAnswer; reference: string }): string {
  const { date, time } = stamp(e.at);
  const a = e.answer;
  const body: string[][] = [
    ['BHT', '0022', '11', e.reference, date, time],
    ['HL', '1', '', '20', '1'], ['NM1', 'PR', '2', e.payer.name, '', '', '', '', 'PI', e.payer.id],
    ['HL', '2', '1', '21', '1'], ['NM1', '1P', '2', e.provider.name, '', '', '', '', 'XX', e.provider.id],
    ['HL', '3', '2', '22', '0'], ['TRN', '2', a.query.trace, e.sender], ['NM1', 'IL', '1', a.query.last, a.query.first, '', '', '', 'MI', a.query.memberId],
  ];
  if (!a.found) {
    body.push(['AAA', 'Y', '', a.rejectCode ?? '72', 'C']);
  } else {
    if (a.planBegin && a.planEnd) body.push(['DTP', '291', 'RD8', `${toD8(a.planBegin)}-${toD8(a.planEnd)}`]);
    body.push(['EB', '1', '', '30', '', a.planDescription ?? '']);
    if (a.individualLimitCents != null) body.push(['EB', 'C', 'IND', '30', '', '', '23', fromCents(a.individualLimitCents), '', '', '', '', 'Y']);
    if (a.individualRemainingCents != null) body.push(['EB', 'C', 'IND', '30', '', '', '29', fromCents(a.individualRemainingCents), '', '', '', '', 'Y']);
    if (a.otherPayer) body.push(['EB', 'R', '', '30']);
  }
  return wrap(e, '271', '271', body);
}

export interface RemitClaim {
  claimId: string; status: string; chargeCents: number; paidCents: number; patientRespCents: number; payerControlNumber: string;
  patient: { last: string; first: string; memberId: string };
  lines: { procedure: string; chargeCents: number; paidCents: number; serviceDate: string; allowedCents: number | null; adjustments: { group: string; triplets: [string, number][] }[]; remarks?: string[] }[];
}

export function build835(e: Env & { payer: Party; payee: Party; paymentCents: number; paymentDate: string; trace: string; productionDate: string; claims: RemitClaim[];
  providerAdjustments?: { providerId: string; fiscalDate: string; items: [string, string, number][] }[] }): string {
  const c = e.delimiters?.component ?? ':';
  const body: string[][] = [
    // BPR04 NON with BPR05-BPR15 empty when nothing is paid (Nevada Medicaid 835 companion guide).
    e.paymentCents > 0
      ? ['BPR', 'I', fromCents(e.paymentCents), 'C', 'ACH', 'CCP', '01', '999999999', 'DA', '000000000', '1999999999', '', '01', '999999999', 'DA', '000000000', toD8(e.paymentDate)]
      : ['BPR', 'H', '0', 'C', 'NON', '', '', '', '', '', '', '', '', '', '', '', toD8(e.paymentDate)],
    ['TRN', '1', e.trace, '1999999999'], ['DTM', '405', toD8(e.productionDate)],
    ['N1', 'PR', e.payer.name], ['N1', 'PE', e.payee.name, 'XX', e.payee.id], ['LX', '1'],
  ];
  for (const cl of e.claims) {
    body.push(['CLP', cl.claimId, cl.status, fromCents(cl.chargeCents), fromCents(cl.paidCents), fromCents(cl.patientRespCents), '12', cl.payerControlNumber],
      ['NM1', 'QC', '1', cl.patient.last, cl.patient.first, '', '', '', 'MI', cl.patient.memberId]);
    for (const l of cl.lines) {
      body.push(['SVC', `HC${c}${l.procedure}`, fromCents(l.chargeCents), fromCents(l.paidCents)], ['DTM', '472', toD8(l.serviceDate)]);
      for (const a of l.adjustments) body.push(['CAS', a.group, ...a.triplets.flatMap(([r, amt]) => [r, fromCents(amt), ''])].slice(0, -1));
      if (l.allowedCents !== null) body.push(['AMT', 'B6', fromCents(l.allowedCents)]);
      for (const r of l.remarks ?? []) body.push(['LQ', 'HE', r]);
    }
  }
  for (const p of e.providerAdjustments ?? []) {
    body.push(['PLB', p.providerId, toD8(p.fiscalDate), ...p.items.flatMap(([code, ref, amt]) => [`${code}${c}${ref}`, fromCents(amt)])]);
  }
  return wrap(e, '835', '835', body);
}

export function build999(e: Env & { group: { functionalId: string; control: string; version: string }; results: { setId: string; control: string; accepted: boolean; error?: { segment: string; position: number; code: string } }[] }): string {
  const body: string[][] = [['AK1', e.group.functionalId, e.group.control, e.group.version]];
  for (const r of e.results) {
    body.push(['AK2', r.setId, r.control]);
    if (r.error) body.push(['IK3', r.error.segment, String(r.error.position), '', r.error.code]);
    body.push(r.accepted ? ['IK5', 'A'] : ['IK5', 'R', '5']);
  }
  const acc = e.results.filter((r) => r.accepted).length;
  body.push(['AK9', acc === e.results.length ? 'A' : acc === 0 ? 'R' : 'P', String(e.results.length), String(e.results.length), String(acc)]);
  return wrap(e, '999', '999', body);
}
