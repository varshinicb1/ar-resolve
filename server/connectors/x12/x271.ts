// 271 eligibility response (005010X279A1) → typed benefits.
//
// Layout read from: x12.org 005010X279 "Example 1b" (BHT 0022/11, HL 20/21/22, NM1 PR/1P/IL,
// TRN, DMG, DTP*346, EB01-EB12 positions, LS/LE 2120 loop); CMS HETS 270/271 companion guide
// v14.0 (2025-11): EB01 C deductible examples "EB*C**30*MB**23*257" (base) and
// "EB*C**30*MB**29*0" (remaining), EB01 R / 1 / 6 / I, DTP*291 plan dates, AAA errors;
// UnitedHealthcare 270/271 companion guide v9.0 (2025-02): EB02 IND/FAM, EB06 29 = remaining,
// EB12 Y = in network, base deductible with EB06 empty; Minnesota best practice
// "Reporting other or additional payor information" (2019): EB01 R = Other or Additional Payor.
import { type Delimiters, type Segment, type Transaction, X12Error, dateValue, el, hlNodes, toCents } from './core.ts';

export interface Benefit {
  code: string; coverageLevel: string; serviceTypes: string[]; insuranceType: string; planDescription: string;
  timePeriod: string; amountCents: number | null; percent: string; inNetwork: string; segment: number;
  dates: Record<string, { from: string | null; to: string | null }>;
}
export interface EligibilitySubject {
  level: string; memberId: string; name: { last: string; first: string }; traces: string[];
  dates: Record<string, { from: string | null; to: string | null }>; benefits: Benefit[];
  errors: { code: string; segment: number }[];
  deductible: { individualLimitCents: number | null; individualRemainingCents: number | null; familyLimitCents: number | null; familyRemainingCents: number | null;
    limitSegment: number | null; remainingSegment: number | null; ambiguous: string[] };
  otherPayer: { reported: boolean; segment: number | null };
  activeCoverage: boolean | null;
}
export interface EligibilityResponse { transaction: 'ST*271'; control: string; implementationRef: string; payer: { name: string; id: string }; sourceErrors: { code: string; segment: number }[]; subjects: EligibilitySubject[] }

function serviceTypes(v: string, d: Delimiters): string[] {
  const sep = d.repetition && v.includes(d.repetition) ? d.repetition : d.component;
  return v ? v.split(sep).filter(Boolean) : [];
}

function parseEb(s: Segment, d: Delimiters): Benefit {
  if (!el(s, 1)) throw new X12Error('bad_eb', `EB01 missing at segment ${s.position}`);
  return { code: el(s, 1), coverageLevel: el(s, 2), serviceTypes: serviceTypes(el(s, 3), d), insuranceType: el(s, 4), planDescription: el(s, 5),
    timePeriod: el(s, 6), amountCents: toCents(el(s, 7)), percent: el(s, 8), inNetwork: el(s, 12), segment: s.position, dates: {} };
}

export function map271(t: Transaction, d: Delimiters): EligibilityResponse {
  if (t.setId !== '271') throw new X12Error('wrong_transaction', `Expected 271, found ${t.setId}`);
  const { nodes } = hlNodes(t);
  if (!nodes.length) throw new X12Error('missing_segment', '271 has no HL hierarchy');
  const out: EligibilityResponse = { transaction: 'ST*271', control: t.control, implementationRef: t.implementationRef, payer: { name: '', id: '' }, sourceErrors: [], subjects: [] };
  for (const n of nodes) {
    if (n.level === '20') {
      const p = n.segments.find((s) => s.id === 'NM1' && el(s, 1) === 'PR');
      out.payer = { name: el(p, 3), id: el(p, 9) };
      out.sourceErrors.push(...n.segments.filter((s) => s.id === 'AAA').map((s) => ({ code: el(s, 3), segment: s.position })));
      continue;
    }
    if (n.level !== '22' && n.level !== '23') continue;
    const subj: EligibilitySubject = {
      level: n.level, memberId: '', name: { last: '', first: '' }, traces: [], dates: {}, benefits: [], errors: [],
      deductible: { individualLimitCents: null, individualRemainingCents: null, familyLimitCents: null, familyRemainingCents: null, limitSegment: null, remainingSegment: null, ambiguous: [] },
      otherPayer: { reported: false, segment: null }, activeCoverage: null,
    };
    let benefit: Benefit | null = null;
    let inLs = false;
    for (const s of n.segments) {
      if (s.id === 'LS') { inLs = true; continue; }
      if (s.id === 'LE') { inLs = false; continue; }
      if (inLs) continue; // 2120 loop (related entities) is not subject data
      switch (s.id) {
        case 'TRN': subj.traces.push(el(s, 2)); break;
        case 'NM1':
          if (['IL', '03'].includes(el(s, 1)) && !benefit) { subj.memberId = el(s, 9); subj.name = { last: el(s, 3), first: el(s, 4) }; }
          break;
        case 'AAA': subj.errors.push({ code: el(s, 3), segment: s.position }); break;
        case 'DTP': {
          const v = dateValue(el(s, 2), el(s, 3));
          if (benefit) benefit.dates[el(s, 1)] = v; else subj.dates[el(s, 1)] = v;
          break;
        }
        case 'EB':
          benefit = parseEb(s, d);
          subj.benefits.push(benefit);
          break;
      }
    }
    if (!subj.memberId && n.level === '23') {
      const parent = out.subjects.find((x) => x.level === '22');
      subj.memberId = parent?.memberId ?? '';
    }
    summarize(subj);
    out.subjects.push(subj);
  }
  return out;
}

// Health benefit plan (service type 30) deductible in network. Base: EB06 23 (calendar
// year, CMS HETS example) or empty (UHC example). Remaining: EB06 29. Anything else is
// reported as ambiguous and not used.
function summarize(s: EligibilitySubject) {
  for (const b of s.benefits) {
    if (b.code === '1') s.activeCoverage = true;
    if (b.code === '6' && s.activeCoverage === null) s.activeCoverage = false;
    if (b.code === 'R' && !s.otherPayer.reported) s.otherPayer = { reported: true, segment: b.segment };
    if (b.code !== 'C') continue;
    if (b.serviceTypes.length && !b.serviceTypes.includes('30')) continue;
    if (b.inNetwork === 'N') continue;
    if (b.amountCents === null) continue;
    const fam = b.coverageLevel === 'FAM';
    if (b.timePeriod === '29') {
      if (fam) s.deductible.familyRemainingCents = pickOne(s, 'family remaining', s.deductible.familyRemainingCents, b.amountCents);
      else { s.deductible.individualRemainingCents = pickOne(s, 'individual remaining', s.deductible.individualRemainingCents, b.amountCents); s.deductible.remainingSegment = b.segment; }
    } else if (b.timePeriod === '23' || b.timePeriod === '') {
      if (fam) s.deductible.familyLimitCents = pickOne(s, 'family limit', s.deductible.familyLimitCents, b.amountCents);
      else { s.deductible.individualLimitCents = pickOne(s, 'individual limit', s.deductible.individualLimitCents, b.amountCents); s.deductible.limitSegment = b.segment; }
    } else {
      s.deductible.ambiguous.push(`EB segment ${b.segment}: time period ${b.timePeriod} not mapped`);
    }
  }
}

function pickOne(s: EligibilitySubject, label: string, prev: number | null, next: number): number | null {
  if (prev !== null && prev !== next) { s.deductible.ambiguous.push(`Two different ${label} amounts (${prev} vs ${next})`); return null; }
  return next;
}
