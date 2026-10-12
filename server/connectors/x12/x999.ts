// 999 implementation acknowledgment (005010X231). Layout read from the public x12.org
// 005010X231 "Example 01": AK1 (functional id, group control number, version), AK2 (set id,
// control number), IK3 (segment id, position, loop, error code), IK4 (element position,
// reference, error code), CTX, IK5 (A accepted / E accepted with errors / R rejected, error
// codes), AK9 (group disposition, included, received, accepted counts). Error code values are
// carried verbatim: their descriptions are in the licensed TR3.
import { type Transaction, X12Error, el } from './core.ts';

export interface AckError { segmentId: string; position: number; loop: string; code: string; element: { position: string; reference: string; code: string } | null; context: string[] }
export interface AckTransaction { setId: string; control: string; disposition: string; dispositionCodes: string[]; errors: AckError[] }
export interface ImplementationAck {
  transaction: 'ST*999'; control: string; group: { functionalId: string; control: string; version: string };
  transactions: AckTransaction[]; groupDisposition: string; counts: { included: number; received: number; accepted: number };
}

export function map999(t: Transaction): ImplementationAck {
  if (t.setId !== '999') throw new X12Error('wrong_transaction', `Expected 999, found ${t.setId}`);
  const ak1 = t.segments.find((s) => s.id === 'AK1');
  const ak9 = t.segments.find((s) => s.id === 'AK9');
  if (!ak1 || !ak9) throw new X12Error('missing_segment', '999 requires AK1 and AK9');
  const out: ImplementationAck = { transaction: 'ST*999', control: t.control, group: { functionalId: el(ak1, 1), control: el(ak1, 2), version: el(ak1, 3) }, transactions: [],
    groupDisposition: el(ak9, 1), counts: { included: Number(el(ak9, 2)), received: Number(el(ak9, 3)), accepted: Number(el(ak9, 4)) } };
  let cur: AckTransaction | null = null;
  let err: AckError | null = null;
  for (const s of t.segments) {
    if (s.id === 'AK2') { cur = { setId: el(s, 1), control: el(s, 2), disposition: '', dispositionCodes: [], errors: [] }; out.transactions.push(cur); err = null; continue; }
    if (!cur) continue;
    if (s.id === 'IK3') { err = { segmentId: el(s, 1), position: Number(el(s, 2)), loop: el(s, 3), code: el(s, 4), element: null, context: [] }; cur.errors.push(err); }
    else if (s.id === 'IK4' && err) err.element = { position: el(s, 1), reference: el(s, 2), code: el(s, 3) };
    else if (s.id === 'CTX' && err) err.context.push(s.elements.join('*'));
    else if (s.id === 'IK5') { cur.disposition = el(s, 1); cur.dispositionCodes = s.elements.slice(1).filter(Boolean); }
  }
  if (!['A', 'E', 'P', 'R', 'M', 'W', 'X'].includes(out.groupDisposition)) throw new X12Error('bad_ak9', `Unknown AK901 disposition '${out.groupDisposition}'`);
  return out;
}
