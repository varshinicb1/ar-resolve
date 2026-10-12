// Generators for the 276 claim status request and 270 eligibility request.
// 276 layout: x12.org 005010X212 "Example 1a" (BHT 0010/13, HL 20/21/19/22, NM1 PR/41/1P/IL with
// PI/46/XX/MI, TRN*1, REF*EJ, AMT*T3, DTP*472). 270 layout: mirrors the 271 example
// (BHT 0022, HL 20/21/22, NM1 PR/1P/IL) with BHT02 13 (request), TRN*1, DTP*291 and EQ*30
// (service type 30 health benefit plan coverage). DMG (birth date) is deliberately omitted:
// AR Resolve holds no demographics; whether a payer requires it must be checked against the
// licensed TR3 and the payer companion guide before any live use.
import { type BuildInterchange, fromCents, serialize, toD8 } from './core.ts';

// GS01 functional identifier codes. HP (835) is shown in the x12.org 835 example and HR (276) in
// the IBX envelope guide; the others were not verified from a public source in this session.
export const FUNCTIONAL_IDS: Record<string, { code: string; verified: boolean }> = {
  '835': { code: 'HP', verified: true },
  '276': { code: 'HR', verified: true },
  '277': { code: 'HN', verified: false },
  '270': { code: 'HS', verified: false },
  '271': { code: 'HB', verified: false },
  '999': { code: 'FA', verified: false },
};

export const IMPLEMENTATION_REFS: Record<string, string> = {
  '835': '005010X221A1', '276': '005010X212', '277': '005010X212', '277CA': '005010X214', '270': '005010X279A1', '271': '005010X279A1', '999': '005010X231',
};

export interface Party { name: string; id: string }
export interface StatusQuery { trace: string; memberId: string; last: string; first: string; claimReference: string; chargeCents: number; serviceDate: string }
export interface EnvelopeOpts { sender: string; receiver: string; control: number; at: Date; usage?: 'T' | 'P' }

function stamp(at: Date) {
  const iso = at.toISOString();
  return { date: iso.slice(0, 10).replace(/-/g, ''), time: iso.slice(11, 16).replace(':', '') };
}

export function build276(o: EnvelopeOpts & { payer: Party; submitter: Party; provider: Party; claims: StatusQuery[]; reference: string }): string {
  const { date, time } = stamp(o.at);
  const body: string[][] = [
    ['BHT', '0010', '13', o.reference, date, time],
    ['HL', '1', '', '20', '1'], ['NM1', 'PR', '2', o.payer.name, '', '', '', '', 'PI', o.payer.id],
    ['HL', '2', '1', '21', '1'], ['NM1', '41', '2', o.submitter.name, '', '', '', '', '46', o.submitter.id],
    ['HL', '3', '2', '19', '1'], ['NM1', '1P', '2', o.provider.name, '', '', '', '', 'XX', o.provider.id],
  ];
  o.claims.forEach((c, i) => {
    body.push(['HL', String(4 + i), '3', '22', '0'], ['NM1', 'IL', '1', c.last, c.first, '', '', '', 'MI', c.memberId], ['TRN', '1', c.trace],
      ['REF', 'EJ', c.claimReference], ['AMT', 'T3', fromCents(c.chargeCents)], ['DTP', '472', 'D8', toD8(c.serviceDate)]);
  });
  const b: BuildInterchange = { sender: o.sender, receiver: o.receiver, control: o.control, date, time, usage: o.usage ?? 'T', functionalId: FUNCTIONAL_IDS['276'].code,
    groupControl: o.control, version: IMPLEMENTATION_REFS['276'], transactions: [{ setId: '276', control: '0001', implementationRef: IMPLEMENTATION_REFS['276'], body }] };
  return serialize(b);
}

export interface EligibilityQuery { trace: string; memberId: string; last: string; first: string; serviceDate: string }

export function build270(o: EnvelopeOpts & { payer: Party; provider: Party; query: EligibilityQuery; reference: string; originator: string }): string {
  const { date, time } = stamp(o.at);
  const q = o.query;
  const body: string[][] = [
    ['BHT', '0022', '13', o.reference, date, time],
    ['HL', '1', '', '20', '1'], ['NM1', 'PR', '2', o.payer.name, '', '', '', '', 'PI', o.payer.id],
    ['HL', '2', '1', '21', '1'], ['NM1', '1P', '2', o.provider.name, '', '', '', '', 'XX', o.provider.id],
    ['HL', '3', '2', '22', '0'], ['TRN', '1', q.trace, o.originator], ['NM1', 'IL', '1', q.last, q.first, '', '', '', 'MI', q.memberId],
    ['DTP', '291', 'D8', toD8(q.serviceDate)], ['EQ', '30'],
  ];
  const b: BuildInterchange = { sender: o.sender, receiver: o.receiver, control: o.control, date, time, usage: o.usage ?? 'T', functionalId: FUNCTIONAL_IDS['270'].code,
    groupControl: o.control, version: IMPLEMENTATION_REFS['270'], transactions: [{ setId: '270', control: '0001', implementationRef: IMPLEMENTATION_REFS['270'], body }] };
  return serialize(b);
}
