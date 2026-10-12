// Turns typed integration records into observations, following the versioned mappings in
// mappings.ts. The evidence content stores the typed record plus the extracted rows; the
// evidence service reads only the `extracted` array at a known path, filtered by an allowlist
// per evidence kind, so nothing in a payer file can create an arbitrary fact.
import type { Observation, SourceClass } from '../services/evidence.ts';
import type { ClaimPayment, Remittance } from './x12/x835.ts';
import { lineBalanced } from './x12/x835.ts';
import type { ClaimStatus, StatusResponse } from './x12/x277.ts';
import type { EligibilitySubject } from './x12/x271.ts';

export const INTEGRATION_KINDS = ['edi_835', 'edi_277', 'edi_271', 'fhir_eob', 'fhir_coverage'] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export interface Extracted { factKey: string; value: unknown; unit: string | null; locator: Record<string, unknown> }

const ALLOWED: Record<IntegrationKind, { keys: string[]; sourceClass: SourceClass }> = {
  edi_835: { keys: ['claimReference', 'eobPatientToken', 'eobServiceDate', 'allowedCents', 'adjustmentGroup', 'appliedCents', 'claimPaidCents', 'processedDate'], sourceClass: 'document' },
  edi_277: { keys: ['claimReference', 'claimStatusCategory', 'claimPaidCents', 'claimAcknowledgment'], sourceClass: 'structured' },
  edi_271: { keys: ['limitCents', 'deductibleRemainingCents', 'metBeforeCents', 'secondaryAtDos'], sourceClass: 'structured' },
  fhir_eob: { keys: ['claimReference', 'eobPatientToken', 'eobServiceDate', 'allowedCents', 'appliedCents'], sourceClass: 'document' },
  fhir_coverage: { keys: ['coverageStatus'], sourceClass: 'structured' },
};

const CENTS = new Set(['allowedCents', 'appliedCents', 'claimPaidCents', 'limitCents', 'deductibleRemainingCents', 'metBeforeCents']);

export function isIntegrationKind(k: string): k is IntegrationKind {
  return (INTEGRATION_KINDS as readonly string[]).includes(k);
}

export function integrationObservations(kind: IntegrationKind, content: unknown): Observation[] {
  const rule = ALLOWED[kind];
  const rows = (content as { extracted?: unknown })?.extracted;
  if (!Array.isArray(rows)) return [];
  const out: Observation[] = [];
  for (const r of rows as Extracted[]) {
    if (!r || typeof r.factKey !== 'string' || !rule.keys.includes(r.factKey) || r.value === undefined || r.value === null) continue;
    if (CENTS.has(r.factKey) && !(typeof r.value === 'number' && Number.isInteger(r.value))) continue;
    out.push({ factKey: r.factKey, value: r.value, unit: CENTS.has(r.factKey) ? 'USD_cents' : null, locator: r.locator ?? {}, sourceClass: rule.sourceClass });
  }
  return out;
}

const row = (factKey: string, value: unknown, locator: Record<string, unknown>): Extracted => ({ factKey, value, unit: CENTS.has(factKey) ? 'USD_cents' : null, locator });

export function observe835(remit: Remittance, claim: ClaimPayment, base: Record<string, unknown>): Extracted[] {
  if (claim.reversal) return [];
  const out: Extracted[] = [];
  const at = (segment: string, position: number, extra: Record<string, unknown> = {}) => ({ ...base, transaction: `835 ${remit.control}`, segment, position, ...extra });
  out.push(row('claimReference', claim.claimId, at('CLP01', claim.segmentRange[0])));
  if (claim.patient?.id && claim.patient.qualifier === 'MI') out.push(row('eobPatientToken', claim.patient.id, at('NM1*QC NM109', claim.segmentRange[0] + 1)));
  const line = claim.lines[0];
  const dos = line?.serviceDate ?? claim.claimDates.statementFrom;
  if (dos) out.push(row('eobServiceDate', dos, at(line?.serviceDate ? 'DTM*472' : 'DTM*232', line?.segment ?? claim.segmentRange[0])));
  if (line?.allowedCents !== null && line?.allowedCents !== undefined) out.push(row('allowedCents', line.allowedCents, at('AMT*B6', line.segment, { line: 1 })));
  if (line) {
    const ded = line.adjustments.find((a) => a.reason === '1');
    if (ded) {
      out.push(row('adjustmentGroup', ded.group, at('CAS01', ded.segment, { line: 1, triplet: ded.triplet })));
      out.push(row('appliedCents', ded.amountCents, at('CAS', ded.segment, { line: 1, triplet: ded.triplet, reason: '1' })));
    } else if (lineBalanced(line)) {
      out.push(row('appliedCents', 0, at('SVC', line.segment, { line: 1, derivation: 'No CARC 1 triplet on a balanced service line' })));
    }
  }
  if (claim.paidCents !== null) out.push(row('claimPaidCents', claim.paidCents, at('CLP04', claim.segmentRange[0])));
  if (remit.productionDate) out.push(row('processedDate', remit.productionDate, at('DTM*405', 0)));
  return out;
}

export function observe277(resp: StatusResponse, claim: ClaimStatus, base: Record<string, unknown>): Extracted[] {
  const out: Extracted[] = [];
  const at = (segment: string, position: number) => ({ ...base, transaction: `277 ${resp.control}`, segment, position });
  const first = claim.statuses[0];
  if (resp.variant === '277CA') {
    if (first) out.push(row('claimAcknowledgment', `${first.category}:${first.code}`, at('STC01', first.segment)));
    return out;
  }
  if (claim.patientAccount) out.push(row('claimReference', claim.patientAccount, at('REF*EJ', claim.segmentRange[0])));
  if (first) {
    out.push(row('claimStatusCategory', first.category, at('STC01-1', first.segment)));
    if (first.paidCents !== null) out.push(row('claimPaidCents', first.paidCents, at('STC05', first.segment)));
  }
  return out;
}

export interface Opts271 { deriveMetBeforeFromRemaining: boolean; otherPayerMeansSecondary: boolean }

export function covers(range: { from: string | null; to: string | null } | undefined, date: string): boolean {
  if (!range?.from) return false;
  return range.from <= date && (range.to ?? range.from) >= date;
}

export function observe271(subject: EligibilitySubject, serviceDate: string, opts: Opts271, base: Record<string, unknown>): Extracted[] {
  if (subject.errors.length) return [];
  const out: Extracted[] = [];
  const at = (segment: string, position: number | null, extra: Record<string, unknown> = {}) => ({ ...base, transaction: '271', segment, position, ...extra });
  const d = subject.deductible;
  if (d.individualLimitCents !== null) out.push(row('limitCents', d.individualLimitCents, at('EB07 (EB01=C, EB06 23/empty)', d.limitSegment)));
  if (d.individualRemainingCents !== null) out.push(row('deductibleRemainingCents', d.individualRemainingCents, at('EB07 (EB01=C, EB06 29)', d.remainingSegment)));
  const covered = covers(subject.dates['291'], serviceDate);
  if (opts.deriveMetBeforeFromRemaining && covered && d.individualLimitCents !== null && d.individualRemainingCents !== null && d.individualLimitCents >= d.individualRemainingCents) {
    out.push(row('metBeforeCents', d.individualLimitCents - d.individualRemainingCents, at('derived', null, { derivation: 'limit - remaining', limitSegment: d.limitSegment, remainingSegment: d.remainingSegment })));
  }
  if (opts.otherPayerMeansSecondary && covered && subject.otherPayer.reported) out.push(row('secondaryAtDos', 'active', at('EB01=R', subject.otherPayer.segment)));
  return out;
}
