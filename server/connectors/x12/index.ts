// Entry point: parse a raw interchange strictly and map every transaction set it contains.
import { type Interchange, X12Error, parseStrict } from './core.ts';
import { map835, type Remittance } from './x835.ts';
import { map277, type StatusResponse } from './x277.ts';
import { map271, type EligibilityResponse } from './x271.ts';
import { map999, type ImplementationAck } from './x999.ts';
import { parse270, parse276 } from './responses.ts';

export type MappedTransaction =
  | { setId: '835'; control: string; data: Remittance }
  | { setId: '277'; control: string; data: StatusResponse }
  | { setId: '271'; control: string; data: EligibilityResponse }
  | { setId: '999'; control: string; data: ImplementationAck }
  | { setId: '276'; control: string; data: ReturnType<typeof parse276> }
  | { setId: '270'; control: string; data: ReturnType<typeof parse270> };

export const SUPPORTED_SETS = ['835', '277', '271', '999', '276', '270'] as const;

export function parseEdi(raw: string): { interchange: Interchange; transactions: MappedTransaction[] } {
  const x = parseStrict(raw);
  const transactions: MappedTransaction[] = [];
  for (const g of x.groups) for (const t of g.transactions) {
    switch (t.setId) {
      case '835': transactions.push({ setId: '835', control: t.control, data: map835(t, x.delimiters) }); break;
      case '277': transactions.push({ setId: '277', control: t.control, data: map277(t, x.delimiters) }); break;
      case '271': transactions.push({ setId: '271', control: t.control, data: map271(t, x.delimiters) }); break;
      case '999': transactions.push({ setId: '999', control: t.control, data: map999(t) }); break;
      case '276': transactions.push({ setId: '276', control: t.control, data: parse276(t) }); break;
      case '270': transactions.push({ setId: '270', control: t.control, data: parse270(t) }); break;
      default: throw new X12Error('unsupported_transaction', `Transaction set ${t.setId} is not supported (supported: ${SUPPORTED_SETS.join(', ')})`);
    }
  }
  if (!transactions.length) throw new X12Error('empty', 'Interchange contains no transaction sets');
  return { interchange: x, transactions };
}

export { X12Error } from './core.ts';
