// Remittance reconciliation and the outcome ledger (FR14).
// Four things are kept apart, line by line: a payer promise, an accepted request,
// a changed adjudication and posted cash. Recovery is attributable only under an
// explicit, versioned attribution rule. A contradictory outcome reopens the account.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { canonicalJson, hashJson, invalid, newId, nowIso, sha256 } from '../util.ts';
import { audit } from './audit.ts';
import { requirePerm, type Scope } from './auth.ts';
import { addEvidence } from './evidence.ts';
import { dayDiff, isDate } from './calendar.ts';

export interface Actor { tenantId: string; clientId: string; userId: string }

// ---------------------------------------------------------------- input contract
// The 835 parser (integrations workstream) should map each service-line payment
// (CLP/SVC/CAS loops) to this shape and call importRemittance with format
// 'ar-resolve.remittance-lines.v1'. The synthetic format below is identical.
export interface RemittanceLine {
  claimReference: string;
  payerId: string;
  lineNumber: number;
  adjudicatedDate: string; // YYYY-MM-DD
  status: 'original' | 'corrected' | 'reversal';
  allowedCents: number;
  allowedReported?: boolean; // false when the source reported no allowed amount (an 835 reversal without AMT*B6); allowedCents is then 0 and unused
  paidCents: number; // negative for a reversal (amount taken back)
  adjustments: { group: 'PR' | 'CO' | 'OA' | 'PI' | 'CR'; carc: string; amountCents: number }[];
  payerClaimControl?: string;
}
export interface RemittanceInput { format: 'ar-resolve.synthetic-remittance.v1' | 'ar-resolve.remittance-lines.v1'; sourceName: string; lines: RemittanceLine[] }
export interface CashPostingInput { claimReference: string; payerId: string; lineNumber: number; amountCents: number; postedDate: string; depositReference: string }

// ---------------------------------------------------------------- attribution rule

export interface AttributionRule {
  id: string; version: number; state: 'draft';
  title: string;
  methodology: string[];
  windowDays: number;
  eligibleActionKinds: string[];
  receiptStates: string[];
}

export const ATTR01_V1: AttributionRule = {
  id: 'ATTR01', version: 1, state: 'draft',
  title: 'Adjudication change after an approved, accepted payer request (DRAFT, synthetic)',
  methodology: [
    'Attributable only if the adjudication on the same claim line changed in the favourable direction (deductible applied decreased or paid amount increased).',
    'An approved action of an eligible kind must have a recorded connector receipt (accepted or confirmed) dated before the adjudication date.',
    'The adjudication date must fall within windowDays calendar days after that receipt.',
    'An unfavourable change, a reversal or an unchanged adjudication after an accepted request is a contradiction and reopens the account.',
    'Cash is attributable only up to the paid increase of an attributable adjudication change on the same line, and only when it equals the remitted paid amount.',
    'A payer promise and an accepted request are never counted as recovery.',
    'Draft methodology for synthetic testing. The customer contract must define attribution before any reporting (build pack doc 03, Definition of resolution).',
  ],
  windowDays: 90,
  eligibleActionKinds: ['clarify_allocation', 'verify_crossover'],
  receiptStates: ['accepted', 'confirmed'],
};

export function seedAttribution(db: Db): void {
  if (one(db, 'SELECT 1 FROM attribution_rules WHERE rule_id=? AND version=?', ATTR01_V1.id, ATTR01_V1.version)) return;
  run(db, 'INSERT INTO attribution_rules VALUES (?,?,?,?,?,?)', ATTR01_V1.id, ATTR01_V1.version, ATTR01_V1.state, canonicalJson(ATTR01_V1), hashJson(ATTR01_V1), nowIso());
}

function activeRule(db: Db): AttributionRule & { sha256: string } {
  const r = one<{ definition: string; sha256: string }>(db, 'SELECT definition, sha256 FROM attribution_rules WHERE rule_id=? ORDER BY version DESC LIMIT 1', ATTR01_V1.id);
  if (!r) throw invalid('Attribution rule is not seeded');
  return { ...(JSON.parse(r.definition) as AttributionRule), sha256: r.sha256 };
}

// ---------------------------------------------------------------- ledger

const GENESIS = '0'.repeat(64);
const RECONCILED = new Set(['adjudication_changed', 'adjudication_unchanged', 'reversal', 'cash_posted', 'contradiction']);

export interface LedgerInput {
  accountId: string; lineNumber?: number | null; actionId?: string | null;
  entryType: 'payer_promise' | 'request_accepted' | 'adjudication_changed' | 'adjudication_unchanged' | 'reversal' | 'cash_posted' | 'contradiction';
  amountCents?: number | null; deltaCents?: number | null;
  attribution: 'attributable' | 'not_attributable' | 'not_applicable'; attributionRule?: string | null; attributionReason: string;
  sourceType: string; sourceId: string; evidenceId?: string | null; matchStatus?: string;
}

function entryBody(r: Record<string, unknown>) {
  const keys = ['entry_id', 'tenant_id', 'client_id', 'account_id', 'line_number', 'action_id', 'entry_type', 'amount_cents', 'delta_cents', 'attribution',
    'attribution_rule', 'attribution_reason', 'source_type', 'source_id', 'evidence_id', 'recorded_by', 'recorded_at'];
  return canonicalJson(Object.fromEntries(keys.map((k) => [k, r[k] ?? null])));
}

export function recordLedger(db: Db, actor: Actor, e: LedgerInput): string {
  const prev = one<{ entry_hash: string }>(db, 'SELECT entry_hash FROM outcome_ledger WHERE tenant_id=? ORDER BY seq DESC LIMIT 1', actor.tenantId);
  const row: Record<string, unknown> = {
    entry_id: newId('led'), tenant_id: actor.tenantId, client_id: actor.clientId, account_id: e.accountId, line_number: e.lineNumber ?? null, action_id: e.actionId ?? null,
    entry_type: e.entryType, amount_cents: e.amountCents ?? null, delta_cents: e.deltaCents ?? null, attribution: e.attribution, attribution_rule: e.attributionRule ?? null,
    attribution_reason: e.attributionReason, source_type: e.sourceType, source_id: e.sourceId, evidence_id: e.evidenceId ?? null, recorded_by: actor.userId, recorded_at: nowIso(),
  };
  const prevHash = prev?.entry_hash ?? GENESIS;
  const hash = sha256(prevHash + entryBody(row));
  run(db, `INSERT INTO outcome_ledger (entry_id, tenant_id, client_id, account_id, line_number, action_id, entry_type, amount_cents, delta_cents, attribution, attribution_rule,
    attribution_reason, source_type, source_id, evidence_id, recorded_by, recorded_at, prev_hash, entry_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.entry_id, row.tenant_id, row.client_id, row.account_id, row.line_number, row.action_id, row.entry_type, row.amount_cents, row.delta_cents, row.attribution,
    row.attribution_rule, row.attribution_reason, row.source_type, row.source_id, row.evidence_id, row.recorded_by, row.recorded_at, prevHash, hash);
  if (RECONCILED.has(e.entryType)) {
    audit(db, { tenantId: actor.tenantId, clientId: actor.clientId, actorId: actor.userId, objectType: 'outcome', objectId: row.entry_id as string, accountId: e.accountId,
      eventType: 'outcome_reconciled', details: { entryType: e.entryType, attribution: e.attribution, matchStatus: e.matchStatus ?? 'matched' } });
  }
  return row.entry_id as string;
}

export function verifyLedger(db: Db, tenantId: string): { ok: boolean; entries: number; brokenAt?: string } {
  const rows = all<Record<string, unknown>>(db, 'SELECT * FROM outcome_ledger WHERE tenant_id=? ORDER BY seq', tenantId);
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || sha256(prev + entryBody(r)) !== r.entry_hash) return { ok: false, entries: rows.length, brokenAt: r.entry_id as string };
    prev = r.entry_hash as string;
  }
  return { ok: true, entries: rows.length };
}

function ledgerRows(db: Db, scope: Scope, accountId?: string) {
  const params: unknown[] = [scope.tenantId, scope.clientId];
  let where = 'l.tenant_id=? AND l.client_id=?';
  if (accountId) { where += ' AND l.account_id=?'; params.push(accountId); }
  return all<Record<string, unknown>>(db, `SELECT l.*, a.external_id FROM outcome_ledger l JOIN accounts a ON a.tenant_id=l.tenant_id AND a.client_id=l.client_id AND a.account_id=l.account_id
    WHERE ${where} ORDER BY l.seq`, ...params).map((r) => ({
    entryId: r.entry_id, seq: r.seq, accountId: r.account_id, externalId: r.external_id, lineNumber: r.line_number, actionId: r.action_id, entryType: r.entry_type,
    amountCents: r.amount_cents, deltaCents: r.delta_cents, attribution: r.attribution, attributionRule: r.attribution_rule, attributionReason: r.attribution_reason,
    sourceType: r.source_type, sourceId: r.source_id, evidenceId: r.evidence_id, recordedBy: r.recorded_by, recordedAt: r.recorded_at, entryHash: r.entry_hash,
  }));
}

export function listLedger(db: Db, scope: Scope, accountId?: string) {
  requirePerm(scope, 'view');
  return { entries: ledgerRows(db, scope, accountId), rule: activeRule(db) };
}

export function exportLedger(db: Db, scope: Scope) {
  requirePerm(scope, 'audit_export');
  return tx(db, () => {
    const entries = ledgerRows(db, scope);
    const exportEventId = audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'outcome_ledger', objectId: scope.clientId,
      eventType: 'outcome_ledger_exported', details: { entries: entries.length } });
    const packet = {
      format: 'ar-resolve.outcome-ledger.v1', environment: 'synthetic', exportedAt: nowIso(), exportedBy: scope.userId, exportEventId,
      scope: { tenantId: scope.tenantId, clientId: scope.clientId }, attributionRule: activeRule(db), chain: verifyLedger(db, scope.tenantId),
      note: 'Synthetic data. Entry types are distinct: a payer promise or accepted request is never recovery. Attribution follows the draft rule shown.',
      entries,
    };
    return { ...packet, packetSha256: hashJson(packet) };
  });
}

// ---------------------------------------------------------------- reconciliation

interface AccountLite { account_id: string; state: string; payer_id: string }

function matchAccount(db: Db, scope: Actor, claimReference: string, payerId: string): { status: 'matched' | 'unmatched' | 'ambiguous'; account?: AccountLite } {
  const rows = all<AccountLite>(db, 'SELECT account_id, state, payer_id FROM accounts WHERE tenant_id=? AND client_id=? AND claim_reference=? AND payer_id=?', scope.tenantId, scope.clientId, claimReference, payerId);
  if (rows.length === 1) return { status: 'matched', account: rows[0] };
  return { status: rows.length ? 'ambiguous' : 'unmatched' };
}

function validLine(l: RemittanceLine, i: number): string[] {
  const e: string[] = [];
  const int = (v: unknown) => Number.isInteger(v);
  if (typeof l?.claimReference !== 'string' || !/^[A-Z0-9-]{3,40}$/.test(l.claimReference)) e.push('claimReference missing or malformed');
  if (typeof l?.payerId !== 'string' || !/^[\w-]{1,40}$/.test(l.payerId)) e.push('payerId missing or malformed');
  if (!int(l?.lineNumber) || l.lineNumber < 1) e.push('lineNumber must be a positive integer');
  if (!isDate(l?.adjudicatedDate)) e.push('adjudicatedDate must be YYYY-MM-DD');
  if (!['original', 'corrected', 'reversal'].includes(l?.status)) e.push('status must be original, corrected or reversal');
  if (!int(l?.allowedCents) || !int(l?.paidCents)) e.push('allowedCents and paidCents must be integer cents');
  if (!Array.isArray(l?.adjustments) || !l.adjustments.every((a) => ['PR', 'CO', 'OA', 'PI', 'CR'].includes(a?.group) && typeof a.carc === 'string' && /^[A-Z0-9]{1,4}$/.test(a.carc) && int(a.amountCents)))
    e.push('adjustments must be [{group, carc, amountCents}]');
  return e.map((m) => `line ${i + 1}: ${m}`);
}

const deductibleOf = (l: Pick<RemittanceLine, 'adjustments'>) => l.adjustments.filter((a) => a.group === 'PR' && a.carc === '1').reduce((s, a) => s + a.amountCents, 0);

interface Receipt { action_id: string; kind: string; receipt_at: string; payload: string }

function eligibleReceipts(db: Db, a: Actor, accountId: string, rule: AttributionRule): Receipt[] {
  return all<Receipt>(db, `SELECT p.action_id, p.kind, e.observed_at receipt_at, p.payload FROM action_outbox o
    JOIN proposed_actions p ON p.tenant_id=o.tenant_id AND p.client_id=o.client_id AND p.action_id=o.action_id
    JOIN evidence e ON e.tenant_id=o.tenant_id AND e.client_id=o.client_id AND e.evidence_id=o.receipt_evidence_id
    WHERE o.tenant_id=? AND o.client_id=? AND p.account_id=? AND o.state IN (${rule.receiptStates.map(() => '?').join(',')})
      AND p.kind IN (${rule.eligibleActionKinds.map(() => '?').join(',')})
      AND EXISTS (SELECT 1 FROM review_decisions d WHERE d.tenant_id=o.tenant_id AND d.client_id=o.client_id AND d.action_id=o.action_id AND d.decision='approved')
    ORDER BY e.observed_at DESC`, a.tenantId, a.clientId, accountId, ...rule.receiptStates, ...rule.eligibleActionKinds);
}

export function reopenAccount(db: Db, actor: Actor, accountId: string, cause: string, detail: string, sourceType: string, sourceId: string, lineNumber: number | null, evidenceId: string | null) {
  recordLedger(db, actor, { accountId, lineNumber, entryType: 'contradiction', attribution: 'not_applicable', attributionReason: detail, sourceType, sourceId, evidenceId });
  // A reopened account needs a human, and any approval not yet dispatched loses authority (revision bump).
  run(db, `UPDATE accounts SET state='specialist_review', revision=revision+1, updated_at=? WHERE tenant_id=? AND client_id=? AND account_id=?`, nowIso(), actor.tenantId, actor.clientId, accountId);
  audit(db, { tenantId: actor.tenantId, clientId: actor.clientId, actorId: actor.userId, objectType: 'account', objectId: accountId, accountId,
    eventType: 'account_reopened', details: { cause, detail, sourceType, sourceId } });
}

function reconcileLine(db: Db, scope: Scope, batchId: string, l: RemittanceLine, lineHash: string, pairedCorrection = false) {
  const rule = activeRule(db);
  const ruleRef = `${rule.id}@${rule.version}`;
  const m = matchAccount(db, scope, l.claimReference, l.payerId);
  const remitLineId = newId('rl');
  const ded = deductibleOf(l);
  if (!m.account) {
    run(db, 'INSERT INTO remittance_lines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, remitLineId, batchId, l.claimReference, l.payerId, l.lineNumber,
      l.adjudicatedDate, l.status, l.allowedCents, l.paidCents, ded, canonicalJson(l.adjustments), null, m.status, null, lineHash, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'remittance_line', objectId: remitLineId,
      eventType: 'remittance_unmatched', details: { matchStatus: m.status, lineNumber: l.lineNumber } });
    return { remitLineId, matchStatus: m.status, outcome: null as string | null, reopened: false };
  }
  const accountId = m.account.account_id;
  const prior = one<{ paid_cents: number; deductible_cents: number; remit_line_id: string }>(db,
    `SELECT paid_cents, deductible_cents, remit_line_id FROM remittance_lines WHERE tenant_id=? AND client_id=? AND account_id=? AND line_number=? AND status <> 'reversal' ORDER BY rowid DESC LIMIT 1`,
    scope.tenantId, scope.clientId, accountId, l.lineNumber);
  const ev = addEvidence(db, scope, { accountId, kind: 'remittance' as never, title: `Synthetic remittance ${l.claimReference} line ${l.lineNumber} (${l.status}, ${l.adjudicatedDate})`,
    source: `remittance:${batchId}`, content: { ...l, deductibleCents: ded }, effectiveAt: l.adjudicatedDate });
  const evidenceId = ev?.evidenceId ?? null;
  run(db, 'INSERT INTO remittance_lines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, remitLineId, batchId, l.claimReference, l.payerId, l.lineNumber,
    l.adjudicatedDate, l.status, l.allowedCents, l.paidCents, ded, canonicalJson(l.adjustments), accountId, 'matched', evidenceId, lineHash, nowIso());
  const base = { accountId, lineNumber: l.lineNumber, sourceType: 'remittance_line', sourceId: remitLineId, evidenceId, attributionRule: ruleRef };
  const receipts = eligibleReceipts(db, scope, accountId, rule);
  const inWindow = receipts.find((r) => r.receipt_at.slice(0, 10) < l.adjudicatedDate && dayDiff(r.receipt_at.slice(0, 10), l.adjudicatedDate) <= rule.windowDays);

  if (l.status === 'reversal') {
    // A reversal paired with a corrected adjudication of the same line in the same remittance is the
    // payer's correction mechanism: it is recorded, and the corrected line is judged on its own merits.
    if (pairedCorrection) {
      recordLedger(db, scope, { ...base, entryType: 'reversal', amountCents: l.paidCents, deltaCents: l.paidCents, attribution: 'not_attributable',
        attributionReason: 'Reversal paired with a corrected adjudication of the same line in the same remittance; the corrected line is reconciled separately.' });
      return { remitLineId, matchStatus: 'matched', outcome: 'reversal_paired', reopened: false };
    }
    recordLedger(db, scope, { ...base, entryType: 'reversal', amountCents: l.paidCents, deltaCents: l.paidCents, attribution: 'not_attributable',
      attributionReason: 'Reversal of a prior adjudication. Linked to the original line; never deleted.' });
    reopenAccount(db, scope, accountId, 'reversal', `Payer reversed line ${l.lineNumber} on ${l.adjudicatedDate}`, 'remittance_line', remitLineId, l.lineNumber, evidenceId);
    return { remitLineId, matchStatus: 'matched', outcome: 'reversal', reopened: true };
  }

  // Baseline: the previous remittance for this line, else the verified EOB deductible fact.
  let baseDed: number | null = prior?.deductible_cents ?? null;
  const basePaid: number | null = prior?.paid_cents ?? null;
  if (baseDed === null && l.lineNumber === 1) {
    const f = one<{ value: string; status: string }>(db, `SELECT value, status FROM facts WHERE tenant_id=? AND client_id=? AND account_id=? AND fact_key='appliedCents' ORDER BY version DESC LIMIT 1`,
      scope.tenantId, scope.clientId, accountId);
    if (f && f.status === 'verified') baseDed = JSON.parse(f.value) as number;
  }
  if (baseDed === null && basePaid === null) {
    recordLedger(db, scope, { ...base, entryType: 'adjudication_unchanged', amountCents: l.paidCents, attribution: 'not_applicable',
      attributionReason: 'First adjudication on record for this line; it becomes the baseline. No change can be measured.' });
    return { remitLineId, matchStatus: 'matched', outcome: 'baseline', reopened: false };
  }
  const dedDelta = baseDed === null ? 0 : ded - baseDed;
  const paidDelta = basePaid === null ? null : l.paidCents - basePaid;
  const changed = dedDelta !== 0 || (paidDelta ?? 0) !== 0;

  if (!changed) {
    recordLedger(db, scope, { ...base, entryType: 'adjudication_unchanged', amountCents: l.paidCents, deltaCents: 0, attribution: 'not_applicable',
      attributionReason: 'Adjudication matches the baseline.' });
    if (inWindow) {
      reopenAccount(db, scope, accountId, 'request_not_reflected', `An accepted ${inWindow.kind} request (receipt ${inWindow.receipt_at.slice(0, 10)}) is not reflected in the ${l.adjudicatedDate} adjudication`,
        'remittance_line', remitLineId, l.lineNumber, evidenceId);
      return { remitLineId, matchStatus: 'matched', outcome: 'unchanged', reopened: true };
    }
    return { remitLineId, matchStatus: 'matched', outcome: 'unchanged', reopened: false };
  }

  const unfavorable = dedDelta > 0 || (paidDelta ?? 0) < 0;
  let attribution: 'attributable' | 'not_attributable' = 'not_attributable';
  let reason: string;
  if (unfavorable) reason = `Unfavourable change (deductible ${dedDelta >= 0 ? '+' : ''}${dedDelta}, paid ${paidDelta ?? 'unknown'}) is not recovery`;
  else if (!receipts.length) reason = 'No approved request with a recorded receipt exists for this account';
  else if (!inWindow) reason = `No eligible receipt dated before ${l.adjudicatedDate} within ${rule.windowDays} days`;
  else { attribution = 'attributable'; reason = `Favourable change after approved ${inWindow.kind} (${inWindow.action_id}) receipt on ${inWindow.receipt_at.slice(0, 10)}; deductible delta ${dedDelta}, paid delta ${paidDelta ?? 'unknown'}`; }
  recordLedger(db, scope, { ...base, actionId: inWindow?.action_id ?? null, entryType: 'adjudication_changed', amountCents: l.paidCents, deltaCents: paidDelta ?? -dedDelta,
    attribution, attributionReason: reason });
  if (unfavorable) {
    reopenAccount(db, scope, accountId, 'unfavorable_adjudication', reason, 'remittance_line', remitLineId, l.lineNumber, evidenceId);
    return { remitLineId, matchStatus: 'matched', outcome: 'changed', reopened: true };
  }
  // The request asked for a specific expected deductible; reaching it resolves the account operationally.
  const expected = inWindow ? (JSON.parse(inWindow.payload).request?.expectedDeductibleCents as number | undefined) : undefined;
  if (attribution === 'attributable' && typeof expected === 'number' && ded === expected) {
    run(db, `UPDATE accounts SET state='resolved', updated_at=? WHERE tenant_id=? AND client_id=? AND account_id=?`, nowIso(), scope.tenantId, scope.clientId, accountId);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'account', objectId: accountId, accountId,
      eventType: 'account_resolved', details: { basis: 'adjudication_matches_requested_correction', remitLineId, expectedDeductibleCents: expected } });
  }
  return { remitLineId, matchStatus: 'matched', outcome: 'changed', reopened: false };
}

export function importRemittance(db: Db, scope: Scope, input: Partial<RemittanceInput>) {
  requirePerm(scope, 'import');
  return tx(db, () => reconcileRemittance(db, scope, input));
}

export type RemittanceResult = { lineNumber: number; claimReference: string; status: string; matchStatus?: string; outcome?: string | null; reopened?: boolean; accountId?: string | null };

// Validates and reconciles a remittance batch. Callers check permissions and own the transaction
// (the JSON import route above, and EDI 835 ingestion in server/connectors/remit-835.ts).
export function reconcileRemittance(db: Db, scope: Scope, input: Partial<RemittanceInput>): { batchId: string; results: RemittanceResult[] } {
  if (input.format !== 'ar-resolve.synthetic-remittance.v1' && input.format !== 'ar-resolve.remittance-lines.v1') throw invalid('Unknown remittance format');
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 500) throw invalid('lines must contain 1-500 remittance lines');
  const errors = input.lines.flatMap((l, i) => validLine(l, i));
  if (errors.length) throw invalid('Remittance file rejected; nothing was imported', errors);
  const sourceName = String(input.sourceName ?? 'remittance.json').slice(0, 120);
  const lines = input.lines;
  const batchId = newId('rb');
  const results: RemittanceResult[] = [];
  const key = (l: RemittanceLine) => `${l.claimReference}|${l.payerId}|${l.lineNumber}`;
  const corrected = new Set(lines.filter((l) => l.status === 'corrected').map(key));
  for (const l of lines) {
    const lineHash = sha256(canonicalJson(l));
    if (one(db, 'SELECT 1 FROM remittance_lines WHERE tenant_id=? AND client_id=? AND line_sha256=?', scope.tenantId, scope.clientId, lineHash)) {
      results.push({ lineNumber: l.lineNumber, claimReference: l.claimReference, status: 'duplicate' });
      continue;
    }
    const r = reconcileLine(db, scope, batchId, l, lineHash, l.status === 'reversal' && corrected.has(key(l)));
    const accountId = one<{ account_id: string | null }>(db, 'SELECT account_id FROM remittance_lines WHERE tenant_id=? AND client_id=? AND remit_line_id=?', scope.tenantId, scope.clientId, r.remitLineId)?.account_id ?? null;
    results.push({ lineNumber: l.lineNumber, claimReference: l.claimReference, status: 'processed', matchStatus: r.matchStatus, outcome: r.outcome, reopened: r.reopened, accountId });
  }
  const matched = results.filter((r) => r.matchStatus === 'matched').length;
  run(db, 'INSERT INTO remittance_batches VALUES (?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, batchId, sourceName, input.format, sha256(canonicalJson(lines)),
    lines.length, matched, scope.userId, nowIso());
  audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'remittance_batch', objectId: batchId,
    eventType: 'remittance_imported', details: { lines: lines.length, matched, duplicates: results.filter((r) => r.status === 'duplicate').length } });
  return { batchId, results };
}

export function importCash(db: Db, scope: Scope, body: { postings?: CashPostingInput[] }) {
  requirePerm(scope, 'import');
  const postings = body.postings;
  if (!Array.isArray(postings) || !postings.length || postings.length > 500) throw invalid('postings must contain 1-500 entries');
  for (const p of postings) {
    if (typeof p?.claimReference !== 'string' || typeof p.payerId !== 'string' || !Number.isInteger(p.lineNumber) || !Number.isInteger(p.amountCents) || !isDate(p.postedDate)
      || typeof p.depositReference !== 'string' || !/^[\w-]{1,40}$/.test(p.depositReference)) throw invalid('Each posting needs claimReference, payerId, lineNumber, amountCents, postedDate, depositReference');
  }
  const rule = activeRule(db);
  return tx(db, () => postings.map((p) => {
    const h = sha256(canonicalJson(p));
    if (one(db, 'SELECT 1 FROM cash_postings WHERE tenant_id=? AND client_id=? AND sha256=?', scope.tenantId, scope.clientId, h)) return { depositReference: p.depositReference, status: 'duplicate' };
    const m = matchAccount(db, scope, p.claimReference, p.payerId);
    const postingId = newId('cash');
    run(db, 'INSERT INTO cash_postings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, postingId, p.claimReference, p.payerId, p.lineNumber, p.amountCents,
      p.postedDate, p.depositReference, m.account?.account_id ?? null, m.status, h, scope.userId, nowIso());
    if (!m.account) return { depositReference: p.depositReference, status: 'processed', matchStatus: m.status };
    const accountId = m.account.account_id;
    const remit = one<{ paid_cents: number }>(db, `SELECT paid_cents FROM remittance_lines WHERE tenant_id=? AND client_id=? AND account_id=? AND line_number=? ORDER BY rowid DESC LIMIT 1`,
      scope.tenantId, scope.clientId, accountId, p.lineNumber);
    const attributed = one<{ delta_cents: number; action_id: string }>(db, `SELECT delta_cents, action_id FROM outcome_ledger WHERE tenant_id=? AND client_id=? AND account_id=? AND line_number=?
      AND entry_type='adjudication_changed' AND attribution='attributable' ORDER BY seq DESC LIMIT 1`, scope.tenantId, scope.clientId, accountId, p.lineNumber);
    const base = { accountId, lineNumber: p.lineNumber, sourceType: 'cash_posting', sourceId: postingId, attributionRule: `${rule.id}@${rule.version}` };
    if (!remit || remit.paid_cents !== p.amountCents) {
      recordLedger(db, scope, { ...base, entryType: 'cash_posted', amountCents: p.amountCents, attribution: 'not_attributable',
        attributionReason: remit ? `Posted cash ${p.amountCents} differs from remitted paid ${remit.paid_cents}` : 'No remittance on record for this line' });
      reopenAccount(db, scope, accountId, 'cash_mismatch', remit ? `Cash ${p.amountCents} does not equal remitted ${remit.paid_cents}` : 'Cash posted without a matching remittance',
        'cash_posting', postingId, p.lineNumber, null);
      return { depositReference: p.depositReference, status: 'processed', matchStatus: 'matched', reopened: true };
    }
    const ok = !!attributed && attributed.delta_cents > 0;
    recordLedger(db, scope, { ...base, actionId: attributed?.action_id ?? null, entryType: 'cash_posted', amountCents: p.amountCents, deltaCents: ok ? attributed!.delta_cents : null,
      attribution: ok ? 'attributable' : 'not_attributable',
      attributionReason: ok ? `Attributable portion limited to the paid increase (${attributed!.delta_cents}) of the attributable adjudication change` : 'No attributable paid increase on this line' });
    return { depositReference: p.depositReference, status: 'processed', matchStatus: 'matched', reopened: false };
  }));
}

export function remittanceView(db: Db, scope: Scope) {
  requirePerm(scope, 'view');
  return {
    batches: all(db, 'SELECT batch_id, source_name, format, lines, matched, created_by, created_at FROM remittance_batches WHERE tenant_id=? AND client_id=? ORDER BY created_at DESC', scope.tenantId, scope.clientId),
    unmatched: all(db, `SELECT remit_line_id, claim_reference, payer_id, line_number, adjudicated_date, match_status FROM remittance_lines WHERE tenant_id=? AND client_id=? AND match_status <> 'matched' ORDER BY created_at DESC`,
      scope.tenantId, scope.clientId),
  };
}
