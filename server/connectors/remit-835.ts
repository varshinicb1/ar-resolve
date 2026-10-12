// 835 -> remittance reconciliation (ADR 0060).
// Every 835 claim payment that passed the identity gate (claim reference + patient token + DOS,
// see ingest.ts) is mapped to the operations hand-off contract `RemittanceLine`
// ('ar-resolve.remittance-lines.v1', ADR 0040) and reconciled into the outcome ledger in the
// same transaction as the ingest. Nothing is reconciled by guesswork: a claim whose identity
// does not match, whose payer is not in the client's crosswalk, or whose amounts cannot be
// mapped is reported as skipped with a reason.
import { type Db, one } from '../db/db.ts';
import type { Scope } from '../services/auth.ts';
import { type RemittanceLine, type RemittanceResult, reconcileRemittance } from '../services/outcomes.ts';
import { DEFAULT_SETTINGS, getConfig } from './framework.ts';
import { matchClaim, type PreviewItem } from './ingest.ts';
import type { ClaimPayment } from './x12/x835.ts';

export const REMIT_835_MAPPING = { id: 'x12-835-remittance-lines', version: 1 } as const;

const GROUPS = new Set(['PR', 'CO', 'OA', 'PI', 'CR']);

export interface Skipped { claimReference: string; payerControlNumber: string; reason: string; detail: string }
export interface Remit835Report {
  mapping: typeof REMIT_835_MAPPING; payerKey: string | null; payerId: string | null;
  batchId: string | null; lines: number; results: RemittanceResult[]; skipped: Skipped[];
  reconciledAccounts: string[]; reopened: string[]; resolved: string[];
}

export function payerCrosswalk(db: Db, scope: Scope): Record<string, string> {
  const s = getConfig(db, scope, 'edi_upload').settings.payerCrosswalk as Record<string, string> | undefined;
  return s ?? (DEFAULT_SETTINGS.edi_upload.payerCrosswalk as Record<string, string>);
}

// Pure mapping of one 835 claim payment to remittance lines. One line per SVC loop; a claim with
// no service lines becomes a single claim-level line. Claim-level CAS is folded into the line only
// when there is exactly one service line (it cannot be apportioned otherwise).
export function claimToLines(c: ClaimPayment, payerId: string, adjudicatedDate: string, status: RemittanceLine['status']): { lines: RemittanceLine[]; problems: string[] } {
  const problems: string[] = [];
  const adj = (xs: { group: string; reason: string; amountCents: number }[]) => xs.map((a) => {
    if (!GROUPS.has(a.group) || !/^[A-Z0-9]{1,4}$/.test(a.reason)) problems.push(`CAS ${a.group}*${a.reason} cannot be mapped`);
    return { group: a.group as RemittanceLine['adjustments'][number]['group'], carc: a.reason, amountCents: a.amountCents };
  });
  const allowed = (v: number | null): { allowedCents: number; allowedReported?: boolean } => {
    if (v !== null) return { allowedCents: v };
    if (status === 'reversal') return { allowedCents: 0, allowedReported: false };
    problems.push('AMT*B6 allowed amount is absent');
    return { allowedCents: 0 };
  };
  const base = { claimReference: c.claimId, payerId, adjudicatedDate, status, ...(c.payerControlNumber ? { payerClaimControl: c.payerControlNumber } : {}) };
  if (!c.lines.length) {
    if (c.paidCents === null) problems.push('CLP04 paid amount is absent');
    return { lines: [{ ...base, lineNumber: 1, ...allowed(c.coverageAmountCents), paidCents: c.paidCents ?? 0, adjustments: adj(c.claimAdjustments) }], problems };
  }
  if (c.claimAdjustments.length && c.lines.length > 1) problems.push('Claim-level CAS cannot be apportioned across several service lines');
  const lines = c.lines.map((l) => {
    if (l.paidCents === null) problems.push(`SVC03 paid amount is absent on line ${l.line}`);
    return { ...base, lineNumber: l.line, ...allowed(l.allowedCents), paidCents: l.paidCents ?? 0,
      adjustments: adj([...(c.lines.length === 1 ? c.claimAdjustments : []), ...l.adjustments]) };
  });
  return { lines, problems };
}

interface Remit835Meta { control: string; payer: { name: string; id: string }; productionDate: string | null }
type RemitRecord = { remittance: Remit835Meta; claim: ClaimPayment };

// Reconciles the 835 items of a preview. Runs inside the caller's transaction.
export function reconcile835(db: Db, scope: Scope, items: PreviewItem[], envelopeSender: string, paymentDates: Record<string, string | null>, sourceName: string): Remit835Report {
  const report: Remit835Report = { mapping: REMIT_835_MAPPING, payerKey: null, payerId: null, batchId: null, lines: 0, results: [], skipped: [], reconciledAccounts: [], reopened: [], resolved: [] };
  const remitItems = items.filter((it) => it.setId === '835');
  if (!remitItems.length) return report;
  const crosswalk = payerCrosswalk(db, scope);
  const lines: RemittanceLine[] = [];
  const expected = new Map<string, Set<string>>();
  for (const it of remitItems) {
    const rec = it.record as RemitRecord;
    const c = rec.claim;
    const skip = (reason: string, detail: string) => { report.skipped.push({ claimReference: c.claimId, payerControlNumber: c.payerControlNumber, reason, detail }); };
    const payerKey = (rec.remittance.payer.id || envelopeSender).trim();
    report.payerKey = payerKey;
    const payerId = crosswalk[payerKey] ?? null;
    if (!payerId) { skip('payer_not_in_crosswalk', `X12 payer identifier ${payerKey} has no entry in this client's payer crosswalk`); continue; }
    report.payerId = payerId;
    // Reversal items are reported as not_applicable for evidence; their identity is still checked here.
    const match = c.reversal ? matchClaim(db, scope, it.identity) : it.match;
    if (match.status !== 'matched' || !match.accountId) { skip(`identity_${match.status}`, match.reason); continue; }
    const acct = one<{ payer_id: string }>(db, 'SELECT payer_id FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', scope.tenantId, scope.clientId, match.accountId);
    if (acct?.payer_id !== payerId) { skip('payer_mismatch', `Account payer ${acct?.payer_id ?? 'unknown'} differs from remittance payer ${payerId}`); continue; }
    const date = rec.remittance.productionDate ?? paymentDates[rec.remittance.control] ?? null;
    if (!date) { skip('no_adjudication_date', 'Neither DTM*405 production date nor BPR16 payment date is present'); continue; }
    const followsReversal = !c.reversal && remitItems.some((o) => o !== it && (o.record as RemitRecord).claim.reversal && (o.record as RemitRecord).claim.claimId === c.claimId);
    const status: RemittanceLine['status'] = c.reversal ? 'reversal' : followsReversal ? 'corrected' : 'original';
    const mapped = claimToLines(c, payerId, date, status);
    if (mapped.problems.length) { skip('unmappable', mapped.problems.join('; ')); continue; }
    lines.push(...mapped.lines);
    expected.set(c.claimId, (expected.get(c.claimId) ?? new Set<string>()).add(match.accountId));
  }
  report.lines = lines.length;
  if (!lines.length) return report;
  const r = reconcileRemittance(db, scope, { format: 'ar-resolve.remittance-lines.v1', sourceName, lines });
  report.batchId = r.batchId;
  report.results = r.results;
  for (const x of r.results) {
    // Defence in depth: the ledger's own match (claim + payer) must agree with the identity gate.
    if (x.accountId && !expected.get(x.claimReference)?.has(x.accountId)) throw new Error(`Remittance match disagrees with the identity match for ${x.claimReference}`);
  }
  const touched = [...new Set(r.results.map((x) => x.accountId).filter((x): x is string => !!x))];
  report.reconciledAccounts = touched;
  report.reopened = [...new Set(r.results.filter((x) => x.reopened && x.accountId).map((x) => x.accountId!))];
  report.resolved = touched.filter((id) => !!one(db, `SELECT 1 FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=? AND state='resolved'`, scope.tenantId, scope.clientId, id));
  return report;
}
