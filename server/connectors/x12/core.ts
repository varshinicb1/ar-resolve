// Generic X12 5010 tokenizer, envelope parser, validator and serializer.
//
// Sources (read in this session, see docs/adr/0030-integrations.md):
// - Delimiters: the ISA segment is fixed at 106 characters; the element separator is
//   character 4, the repetition separator character 83, the component separator
//   character 105 and the segment terminator character 106 (ecosio, "The Structure of
//   an ANSI ASC X12 File", updated 2025-07-22).
// - ISA01-ISA16 names: IBX "HIPAA 5010 Incoming Transaction Envelope" companion guide (2011).
// - Control-number pairing and counts (SE01 = segments ST..SE inclusive, ST02 = SE02,
//   GS06 = GE02, GE01 = transaction sets, ISA13 = IEA02, IEA01 = groups) are observed in
//   the public x12.org 005010X221/X212/X279 examples.
// This is a parser for synthetic files. It is not a replacement for the licensed TR3s.

export interface Delimiters { element: string; component: string; repetition: string; segment: string }

export interface Segment { id: string; elements: string[]; position: number }

export interface Transaction { st: Segment; se: Segment | null; segments: Segment[]; setId: string; control: string; implementationRef: string }
export interface Group { gs: Segment; ge: Segment | null; transactions: Transaction[]; functionalId: string; control: string; version: string }
export interface Interchange {
  delimiters: Delimiters;
  isa: Segment;
  iea: Segment | null;
  groups: Group[];
  control: string;
  sender: string;
  receiver: string;
  usage: string;
  segmentCount: number;
}

export interface X12Issue { code: string; message: string; segment?: string; position?: number }

export class X12Error extends Error {
  code: string;
  issues: X12Issue[];
  constructor(code: string, message: string, issues: X12Issue[] = []) {
    super(message);
    this.code = code;
    this.issues = issues;
  }
}

export const ISA_LENGTH = 106;

const SAFE_DELIM = /^[^A-Za-z0-9 ]$/;

export function detectDelimiters(raw: string): Delimiters {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('ISA')) throw new X12Error('no_isa', 'File does not start with an ISA interchange header');
  if (text.length < ISA_LENGTH) throw new X12Error('truncated_isa', `ISA header is truncated (${text.length} of ${ISA_LENGTH} characters)`);
  const element = text[3];
  const repetition = text[82];
  const component = text[104];
  const segment = text[105];
  for (const [name, ch] of [['element', element], ['component', component], ['segment', segment]] as const) {
    if (!SAFE_DELIM.test(ch) && !(name === 'segment' && (ch === '\n' || ch === '\r'))) {
      throw new X12Error('bad_delimiter', `ISA ${name} separator '${ch}' is not a valid delimiter (ISA must be exactly ${ISA_LENGTH} characters)`);
    }
  }
  const distinct = new Set([element, component, segment]);
  if (distinct.size !== 3) throw new X12Error('bad_delimiter', 'Element, component and segment delimiters must be distinct');
  const isaFields = text.slice(0, ISA_LENGTH - 1).split(element);
  if (isaFields.length !== 17) throw new X12Error('bad_isa', `ISA must have 16 elements; found ${isaFields.length - 1} (wrong delimiter or field width)`);
  if (isaFields[16] !== component) throw new X12Error('bad_isa', 'ISA16 does not match the component separator at position 105');
  return { element, component, repetition: repetition === 'U' ? '' : repetition, segment };
}

// Splits a raw interchange into segments. Line breaks after segment terminators are tolerated.
export function tokenize(raw: string): { delimiters: Delimiters; segments: Segment[] } {
  const delimiters = detectDelimiters(raw);
  const text = raw.replace(/^﻿/, '');
  const parts = text.split(delimiters.segment);
  const segments: Segment[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');
    if (!part) {
      if (i === parts.length - 1) continue; // trailing terminator
      continue;
    }
    if (i === parts.length - 1) throw new X12Error('truncated', 'Data after the last segment terminator: file is truncated or the terminator is wrong', [{ code: 'unterminated_segment', message: part.slice(0, 40) }]);
    const elements = part.split(delimiters.element);
    const id = elements.shift()!;
    if (!/^[A-Z][A-Z0-9]{1,2}$/.test(id)) throw new X12Error('bad_segment', `Invalid segment identifier '${id.slice(0, 10)}' at segment ${segments.length + 1}`);
    segments.push({ id, elements, position: segments.length + 1 });
  }
  return { delimiters, segments };
}

// Element accessor: el(seg, 1) is the first data element (e.g. CLP01). Empty → ''.
export function el(seg: Segment | undefined, n: number): string {
  return seg?.elements[n - 1] ?? '';
}

export function comp(seg: Segment | undefined, n: number, k: number, d: Delimiters): string {
  return el(seg, n).split(d.component)[k - 1] ?? '';
}

export function parseInterchange(raw: string): { interchange: Interchange; issues: X12Issue[] } {
  const { delimiters, segments } = tokenize(raw);
  const issues: X12Issue[] = [];
  const isa = segments[0];
  if (isa.id !== 'ISA') throw new X12Error('no_isa', 'First segment must be ISA');
  const groups: Group[] = [];
  let iea: Segment | null = null;
  let group: Group | null = null;
  let txn: Transaction | null = null;
  let txnPos = 0;
  for (let i = 1; i < segments.length; i++) {
    const s = segments[i];
    if (iea) { issues.push({ code: 'after_iea', message: `Segment ${s.id} after IEA`, segment: s.id, position: s.position }); continue; }
    switch (s.id) {
      case 'ISA':
        issues.push({ code: 'nested_isa', message: 'Second ISA before IEA', position: s.position });
        break;
      case 'GS':
        if (group) issues.push({ code: 'missing_ge', message: `Functional group ${group.control} has no GE`, position: s.position });
        if (txn) issues.push({ code: 'missing_se', message: `Transaction ${txn.control} has no SE`, position: s.position });
        txn = null;
        group = { gs: s, ge: null, transactions: [], functionalId: el(s, 1), control: el(s, 6), version: el(s, 8) };
        groups.push(group);
        break;
      case 'GE':
        if (!group) { issues.push({ code: 'ge_without_gs', message: 'GE without GS', position: s.position }); break; }
        if (txn) { issues.push({ code: 'missing_se', message: `Transaction ${txn.control} has no SE`, position: s.position }); txn = null; }
        group.ge = s;
        group = null;
        break;
      case 'ST':
        if (!group) { issues.push({ code: 'st_outside_group', message: 'ST outside a functional group', position: s.position }); break; }
        if (txn) issues.push({ code: 'missing_se', message: `Transaction ${txn.control} has no SE`, position: s.position });
        txnPos = 1;
        txn = { st: s, se: null, segments: [{ ...s, position: 1 }], setId: el(s, 1), control: el(s, 2), implementationRef: el(s, 3) };
        group.transactions.push(txn);
        break;
      case 'SE':
        if (!txn) { issues.push({ code: 'se_without_st', message: 'SE without ST', position: s.position }); break; }
        txnPos++;
        txn.se = { ...s, position: txnPos };
        txn.segments.push(txn.se);
        txn = null;
        break;
      case 'IEA':
        if (group) issues.push({ code: 'missing_ge', message: `Functional group ${group.control} has no GE`, position: s.position });
        if (txn) issues.push({ code: 'missing_se', message: `Transaction ${txn.control} has no SE`, position: s.position });
        iea = s;
        break;
      default:
        if (!txn) { issues.push({ code: 'outside_transaction', message: `Segment ${s.id} outside a transaction set`, segment: s.id, position: s.position }); break; }
        txnPos++;
        txn.segments.push({ ...s, position: txnPos });
    }
  }
  if (!iea) issues.push({ code: 'missing_iea', message: 'Interchange has no IEA trailer (truncated file?)' });
  const interchange: Interchange = {
    delimiters, isa, iea, groups, control: el(isa, 13), sender: el(isa, 6).trim(), receiver: el(isa, 8).trim(), usage: el(isa, 15), segmentCount: segments.length,
  };
  issues.push(...validateEnvelope(interchange));
  return { interchange, issues };
}

// Envelope integrity: control numbers pair up and counts match.
export function validateEnvelope(x: Interchange): X12Issue[] {
  const issues: X12Issue[] = [];
  const isa = x.isa;
  if (!/^\d{9}$/.test(el(isa, 13))) issues.push({ code: 'bad_isa13', message: 'ISA13 interchange control number must be 9 digits' });
  if (!['P', 'T'].includes(el(isa, 15))) issues.push({ code: 'bad_isa15', message: 'ISA15 usage indicator must be P or T' });
  if (el(isa, 12) !== '00501') issues.push({ code: 'bad_isa12', message: `ISA12 version ${el(isa, 12)} is not 00501 (5010)` });
  if (x.iea) {
    if (el(x.iea, 2) !== el(isa, 13)) issues.push({ code: 'control_mismatch', message: `IEA02 ${el(x.iea, 2)} does not match ISA13 ${el(isa, 13)}`, segment: 'IEA' });
    if (Number(el(x.iea, 1)) !== x.groups.length) issues.push({ code: 'count_mismatch', message: `IEA01 says ${el(x.iea, 1)} groups; found ${x.groups.length}`, segment: 'IEA' });
  }
  for (const g of x.groups) {
    if (!g.ge) continue;
    if (el(g.ge, 2) !== g.control) issues.push({ code: 'control_mismatch', message: `GE02 ${el(g.ge, 2)} does not match GS06 ${g.control}`, segment: 'GE' });
    if (Number(el(g.ge, 1)) !== g.transactions.length) issues.push({ code: 'count_mismatch', message: `GE01 says ${el(g.ge, 1)} transaction sets; found ${g.transactions.length}`, segment: 'GE' });
    for (const t of g.transactions) {
      if (!t.se) continue;
      if (el(t.se, 2) !== t.control) issues.push({ code: 'control_mismatch', message: `SE02 ${el(t.se, 2)} does not match ST02 ${t.control}`, segment: 'SE' });
      if (Number(el(t.se, 1)) !== t.segments.length) issues.push({ code: 'count_mismatch', message: `SE01 says ${el(t.se, 1)} segments; transaction ${t.control} has ${t.segments.length}`, segment: 'SE' });
    }
  }
  return issues;
}

// Strict parse: any envelope issue rejects the whole file.
export function parseStrict(raw: string): Interchange {
  const { interchange, issues } = parseInterchange(raw);
  if (issues.length) throw new X12Error('envelope_invalid', `Envelope validation failed: ${issues.map((i) => i.message).join('; ')}`, issues);
  return interchange;
}

// ---------------------------------------------------------------- amounts and dates

// X12 decimal amount → integer cents without floating point. Rejects more than 2 decimals.
export function toCents(v: string): number | null {
  if (v === '' || v === undefined) return null;
  const m = /^(-)?(\d*)(?:\.(\d{1,2}))?$/.exec(v);
  if (!m || (m[2] === '' && m[3] === undefined)) throw new X12Error('bad_amount', `Invalid monetary amount '${v}'`);
  const cents = Number(m[2] || '0') * 100 + Number((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -cents : cents;
}

export function fromCents(c: number): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const s = frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
  return (neg ? '-' : '') + s;
}

// CCYYMMDD → YYYY-MM-DD (validated); null when empty.
export function d8(v: string): string | null {
  if (!v) return null;
  if (!/^\d{8}$/.test(v)) throw new X12Error('bad_date', `Invalid D8 date '${v}'`);
  const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new X12Error('bad_date', `Invalid calendar date '${v}'`);
  return iso;
}

export function dateValue(format: string, v: string): { from: string | null; to: string | null } {
  if (format === 'RD8') {
    const [a, b] = v.split('-');
    return { from: d8(a ?? ''), to: d8(b ?? '') };
  }
  const x = d8(v);
  return { from: x, to: x };
}

export function toD8(iso: string): string {
  return iso.replace(/-/g, '');
}

// ---------------------------------------------------------------- serializer

export interface BuildTransaction { setId: string; control: string; implementationRef: string; body: string[][] }
export interface BuildInterchange {
  sender: string; receiver: string; control: number; date: string; time: string; usage: 'T' | 'P';
  functionalId: string; groupControl: number; version: string;
  transactions: BuildTransaction[];
  delimiters?: Delimiters;
  senderQualifier?: string; receiverQualifier?: string;
}

export const DEFAULT_DELIMITERS: Delimiters = { element: '*', component: ':', repetition: '^', segment: '~' };

function pad(v: string, n: number) {
  if (v.length > n) throw new X12Error('field_too_long', `Value '${v}' exceeds ${n} characters`);
  return v.padEnd(n, ' ');
}

// Builds a complete interchange with correct counts and control numbers.
// Segment elements are given without the segment id repeated (body: [['BHT','0010','13',...], ...]).
export function serialize(b: BuildInterchange, newlines = true): string {
  const d = b.delimiters ?? DEFAULT_DELIMITERS;
  for (const t of b.transactions) for (const seg of t.body) for (const v of seg) {
    if ([d.element, d.segment].some((c) => v.includes(c))) throw new X12Error('delimiter_in_data', `Data value '${v}' contains a delimiter`);
  }
  const isaCtl = String(b.control).padStart(9, '0');
  const isa = ['ISA', '00', pad('', 10), '00', pad('', 10), pad(b.senderQualifier ?? 'ZZ', 2), pad(b.sender, 15), pad(b.receiverQualifier ?? 'ZZ', 2), pad(b.receiver, 15),
    b.date.slice(2), b.time, d.repetition || 'U', '00501', isaCtl, '0', b.usage, d.component].join(d.element);
  if (isa.length !== ISA_LENGTH - 1) throw new X12Error('bad_isa', `Built ISA has ${isa.length + 1} characters`);
  const lines: string[] = [isa];
  lines.push(['GS', b.functionalId, b.sender, b.receiver, b.date, b.time, String(b.groupControl), 'X', b.version].join(d.element));
  for (const t of b.transactions) {
    const body = t.body.map((s) => trimTrailing(s).join(d.element));
    lines.push(['ST', t.setId, t.control, t.implementationRef].join(d.element));
    lines.push(...body);
    lines.push(['SE', String(body.length + 2), t.control].join(d.element));
  }
  lines.push(['GE', String(b.transactions.length), String(b.groupControl)].join(d.element));
  lines.push(['IEA', '1', isaCtl].join(d.element));
  return lines.join(d.segment + (newlines ? '\n' : '')) + d.segment + (newlines ? '\n' : '');
}

function trimTrailing(seg: string[]): string[] {
  const out = [...seg];
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out;
}

// Re-emits a parsed interchange exactly (normalized line breaks), for round-trip tests.
export function reserialize(x: Interchange, newlines = true): string {
  const d = x.delimiters;
  const segs: Segment[] = [x.isa];
  for (const g of x.groups) {
    segs.push(g.gs);
    for (const t of g.transactions) segs.push(...t.segments);
    if (g.ge) segs.push(g.ge);
  }
  if (x.iea) segs.push(x.iea);
  return segs.map((s) => [s.id, ...s.elements].join(d.element)).join(d.segment + (newlines ? '\n' : '')) + d.segment + (newlines ? '\n' : '');
}

// HL hierarchy helper: groups segments of a transaction under their HL (HL01 id, HL02 parent, HL03 level).
export interface HlNode { id: string; parent: string; level: string; segments: Segment[] }
export function hlNodes(t: Transaction): { header: Segment[]; nodes: HlNode[] } {
  const header: Segment[] = [];
  const nodes: HlNode[] = [];
  let cur: HlNode | null = null;
  for (const s of t.segments) {
    if (s.id === 'ST' || s.id === 'SE') continue;
    if (s.id === 'HL') { cur = { id: el(s, 1), parent: el(s, 2), level: el(s, 3), segments: [] }; nodes.push(cur); continue; }
    if (cur) cur.segments.push(s); else header.push(s);
  }
  return { header, nodes };
}
