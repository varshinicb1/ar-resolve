// EDI ingestion into evidence: parse → map → match identity → preview → ingest.
// Identity is matched on claim reference + patient token + date of service (271: patient
// token + an eligibility period covering the DOS). Anything that does not match exactly is
// blocked and reported; nothing is attached to an account by guesswork.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { AppError, conflict, invalid, newId, nowIso, sha256 } from '../util.ts';
import { audit } from '../services/audit.ts';
import { requirePerm, type Scope } from '../services/auth.ts';
import { addEvidence } from '../services/evidence.ts';
import { resolveFacts } from '../services/facts.ts';
import { activePause } from '../services/controls.ts';
import { evaluateAndPropose } from '../services/workflow.ts';
import { X12Error, type Interchange } from './x12/core.ts';
import { parseEdi, type MappedTransaction } from './x12/index.ts';
import { type Extracted, type IntegrationKind, type Opts271, covers, observe271, observe277, observe835 } from './observations.ts';
import { ensureMappings, mappingRef } from './mappings.ts';
import { getConfig, newRequest, recordEvent } from './framework.ts';
import { reconcile835 } from './remit-835.ts';

export type MatchStatus = 'matched' | 'unmatched' | 'ambiguous' | 'identity_mismatch' | 'insufficient_identity' | 'not_applicable';

export interface MatchResult { status: MatchStatus; accountId: string | null; externalId: string | null; checks: { field: string; source: string | null; account: string | null; match: boolean }[]; reason: string }

interface AcctRow { account_id: string; external_id: string; claim_reference: string; patient_token: string; service_date: string; state: string; revision: number }

export function matchClaim(db: Db, scope: Scope, id: { claimReference: string | null; patientToken: string | null; serviceDate: string | null }): MatchResult {
  const none = (status: MatchStatus, reason: string): MatchResult => ({ status, accountId: null, externalId: null, checks: [], reason });
  if (!id.claimReference) return none('insufficient_identity', 'Source has no claim reference');
  const rows = all<AcctRow>(db, 'SELECT account_id, external_id, claim_reference, patient_token, service_date, state, revision FROM accounts WHERE tenant_id=? AND client_id=? AND claim_reference=?',
    scope.tenantId, scope.clientId, id.claimReference);
  if (!rows.length) return none('unmatched', `No account in this client has claim reference ${id.claimReference}`);
  if (rows.length > 1) return none('ambiguous', `${rows.length} accounts share claim reference ${id.claimReference}`);
  const a = rows[0];
  const checks = [
    { field: 'claim reference', source: id.claimReference, account: a.claim_reference, match: id.claimReference === a.claim_reference },
    { field: 'patient token', source: id.patientToken, account: a.patient_token, match: id.patientToken === a.patient_token },
    { field: 'date of service', source: id.serviceDate, account: a.service_date, match: id.serviceDate === a.service_date },
  ];
  const missing = checks.filter((c) => c.source === null || c.source === '');
  if (missing.length) return { status: 'insufficient_identity', accountId: a.account_id, externalId: a.external_id, checks, reason: `Source lacks ${missing.map((m) => m.field).join(', ')}` };
  const bad = checks.filter((c) => !c.match);
  if (bad.length) return { status: 'identity_mismatch', accountId: a.account_id, externalId: a.external_id, checks, reason: `Mismatch on ${bad.map((b) => b.field).join(', ')}` };
  return { status: 'matched', accountId: a.account_id, externalId: a.external_id, checks, reason: 'Claim reference, patient token and date of service all match' };
}

export function matchEligibility(db: Db, scope: Scope, id: { patientToken: string; period: { from: string | null; to: string | null } | undefined; trace: string[] }): MatchResult {
  const none = (status: MatchStatus, reason: string): MatchResult => ({ status, accountId: null, externalId: null, checks: [], reason });
  if (!id.patientToken) return none('insufficient_identity', 'Source has no member identifier');
  if (!id.period?.from) return none('insufficient_identity', 'Source has no eligibility date (DTP*291) to compare with the date of service');
  const rows = all<AcctRow>(db, 'SELECT account_id, external_id, claim_reference, patient_token, service_date, state, revision FROM accounts WHERE tenant_id=? AND client_id=? AND patient_token=?',
    scope.tenantId, scope.clientId, id.patientToken);
  if (!rows.length) return none('unmatched', `No account in this client has patient token ${id.patientToken}`);
  let cands = rows.filter((r) => covers(id.period, r.service_date));
  if (!cands.length) return { status: 'identity_mismatch', accountId: rows[0].account_id, externalId: rows[0].external_id, reason: 'Eligibility period does not cover any date of service for this patient token',
    checks: [{ field: 'eligibility period', source: `${id.period.from}..${id.period.to}`, account: rows.map((r) => r.service_date).join(', '), match: false }] };
  // Several accounts for the same patient in the period: only our own echoed trace (E-<external id>) may disambiguate.
  if (cands.length > 1) cands = cands.filter((r) => id.trace.includes(traceFor(r.external_id)));
  if (cands.length !== 1) return none('ambiguous', 'More than one account for this patient token falls in the eligibility period');
  const a = cands[0];
  return { status: 'matched', accountId: a.account_id, externalId: a.external_id, reason: 'Patient token matches and the eligibility period covers the date of service',
    checks: [{ field: 'patient token', source: id.patientToken, account: a.patient_token, match: true }, { field: 'eligibility period covers DOS', source: `${id.period.from}..${id.period.to}`, account: a.service_date, match: true }] };
}

export const traceFor = (externalId: string) => `E-${externalId}`;

export interface PreviewItem {
  transaction: string; setId: string; index: number; kind: IntegrationKind | null; label: string;
  identity: { claimReference: string | null; patientToken: string | null; serviceDate: string | null };
  match: MatchResult; extracted: Extracted[]; record: unknown; notes: string[];
}

export interface EdiPreview {
  valid: true; rawSha256: string; filename: string; sizeBytes: number;
  envelope: { control: string; sender: string; receiver: string; usage: string; groups: { functionalId: string; control: string; version: string; transactions: { setId: string; control: string; implementationRef: string }[] }[] };
  transactionSets: string[]; items: PreviewItem[]; fileLevel: Record<string, unknown>[]; summary: Record<MatchStatus, number> & { ingestable: number };
  alreadyIngested: { fileId: string; createdAt: string } | null; mappingOptions: Opts271;
}

export interface EdiInvalid { valid: false; rawSha256: string; filename: string; error: { code: string; message: string; issues: unknown[] } }

const MAX_EDI = 900_000;

export function optionsFor(db: Db, scope: Scope, connectorId = 'edi_upload'): Opts271 {
  const o = (getConfig(db, scope, connectorId).settings.mappingOptions ?? {}) as Partial<Opts271>;
  return { deriveMetBeforeFromRemaining: o.deriveMetBeforeFromRemaining === true, otherPayerMeansSecondary: o.otherPayerMeansSecondary !== false };
}

export function buildPreview(db: Db, scope: Scope, filename: string, raw: string, opts?: Opts271): EdiPreview | EdiInvalid {
  const rawSha256 = sha256(raw);
  let parsed: { interchange: Interchange; transactions: MappedTransaction[] };
  try { parsed = parseEdi(raw); } catch (err) {
    if (err instanceof X12Error) return { valid: false, rawSha256, filename, error: { code: err.code, message: err.message, issues: err.issues } };
    throw err;
  }
  const options = opts ?? optionsFor(db, scope);
  const x = parsed.interchange;
  const items: PreviewItem[] = [];
  const fileLevel: Record<string, unknown>[] = [];
  const base = { file: rawSha256.slice(0, 16), interchange: x.control };
  for (const t of parsed.transactions) {
    if (t.setId === '835') {
      const r = t.data;
      fileLevel.push({ setId: '835', control: t.control, payer: r.payer, payee: r.payee, payment: r.payment, trace: r.trace, productionDate: r.productionDate,
        providerAdjustments: r.providerAdjustments, balance: r.balance });
      r.claims.forEach((c, i) => {
        const identity = { claimReference: c.claimId, patientToken: c.patient?.qualifier === 'MI' ? c.patient.id : null, serviceDate: c.lines[0]?.serviceDate ?? c.claimDates.statementFrom };
        const notes: string[] = [];
        if (c.reversal) notes.push(`Reversal (CLP02=22) of payer claim ${c.payerControlNumber}: reported, no observations.`);
        const corrected = r.claims.find((o) => o !== c && !o.reversal && o.claimId === c.claimId);
        if (c.reversal && corrected) notes.push(`Corrected adjudication follows as payer claim ${corrected.payerControlNumber}.`);
        if (c.balanced === false) notes.push(`Claim does not balance: ${c.balanceNote}.`);
        if (c.lines[0] && c.lines[0].balanced === false) notes.push('Service line 1 does not balance; a zero deductible is not derived.');
        items.push({ transaction: `835 ${t.control}`, setId: '835', index: i, kind: c.reversal ? null : 'edi_835', label: `${c.claimId} (CLP02 ${c.statusCode}${c.reversal ? ' reversal' : ''})`,
          identity, match: c.reversal ? { ...matchClaim(db, scope, identity), status: 'not_applicable' } : matchClaim(db, scope, identity),
          extracted: observe835(r, c, base), record: { remittance: { control: r.control, payer: r.payer, trace: r.trace, productionDate: r.productionDate }, claim: c }, notes });
      });
    } else if (t.setId === '277') {
      const r = t.data;
      if (r.receiverStatuses.length) fileLevel.push({ setId: '277', variant: r.variant, control: t.control, receiverStatuses: r.receiverStatuses });
      r.claims.forEach((c, i) => {
        const identity = { claimReference: c.patientAccount || (r.variant === '277CA' ? c.trace : '') || null, patientToken: c.memberId || c.patientId || null, serviceDate: c.serviceDate?.from ?? null };
        items.push({ transaction: `277 ${t.control}`, setId: r.variant, index: i, kind: 'edi_277', label: `${identity.claimReference ?? c.trace} ${c.statuses.map((s) => `${s.category}:${s.code}`).join(', ')}`,
          identity, match: matchClaim(db, scope, identity), extracted: observe277(r, c, base), record: { status: { control: r.control, variant: r.variant, payer: r.payer }, claim: c }, notes: r.variant === '277CA' ? ['Acknowledgment only: not adjudication or payment.'] : [] });
      });
    } else if (t.setId === '271') {
      const r = t.data;
      if (r.sourceErrors.length) fileLevel.push({ setId: '271', control: t.control, sourceErrors: r.sourceErrors });
      r.subjects.forEach((s, i) => {
        const period = s.dates['291'];
        const match = matchEligibility(db, scope, { patientToken: s.memberId, period, trace: s.traces });
        const dos = match.accountId ? one<{ service_date: string }>(db, 'SELECT service_date FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', scope.tenantId, scope.clientId, match.accountId)?.service_date ?? '' : '';
        const notes = [...s.deductible.ambiguous];
        if (s.errors.length) notes.push(`AAA rejection ${s.errors.map((e) => e.code).join(', ')}: no observations.`);
        items.push({ transaction: `271 ${t.control}`, setId: '271', index: i, kind: 'edi_271', label: `${s.memberId} eligibility`,
          identity: { claimReference: null, patientToken: s.memberId, serviceDate: period?.from ? `${period.from}..${period.to}` : null }, match,
          extracted: match.status === 'matched' ? observe271(s, dos, options, base) : [], record: { eligibility: { control: r.control, payer: r.payer }, subject: s }, notes });
      });
    } else if (t.setId === '999') {
      fileLevel.push({ setId: '999', control: t.control, acknowledgment: t.data });
    } else {
      fileLevel.push({ setId: t.setId, control: t.control, note: 'Request transaction: nothing to ingest', request: t.data });
    }
  }
  const summary = { matched: 0, unmatched: 0, ambiguous: 0, identity_mismatch: 0, insufficient_identity: 0, not_applicable: 0, ingestable: 0 };
  for (const it of items) { summary[it.match.status]++; if (it.match.status === 'matched' && it.kind) summary.ingestable++; }
  const prior = one<{ file_id: string; created_at: string }>(db, 'SELECT file_id, created_at FROM edi_files WHERE tenant_id=? AND client_id=? AND raw_sha256=?', scope.tenantId, scope.clientId, rawSha256);
  return {
    valid: true, rawSha256, filename, sizeBytes: Buffer.byteLength(raw),
    envelope: { control: x.control, sender: x.sender, receiver: x.receiver, usage: x.usage,
      groups: x.groups.map((g) => ({ functionalId: g.functionalId, control: g.control, version: g.version, transactions: g.transactions.map((t) => ({ setId: t.setId, control: t.control, implementationRef: t.implementationRef })) })) },
    transactionSets: [...new Set(parsed.transactions.map((t) => t.setId))], items, fileLevel, summary,
    alreadyIngested: prior ? { fileId: prior.file_id, createdAt: prior.created_at } : null, mappingOptions: options,
  };
}

function checkInput(body: { filename?: unknown; content?: unknown }) {
  const filename = String(body.filename ?? 'upload.edi').replace(/[^\w.\- ]/g, '_').slice(0, 120);
  if (typeof body.content !== 'string' || !body.content.trim()) throw invalid('content (the raw X12 text) is required');
  if (body.content.length > MAX_EDI) throw new AppError(413, 'too_large', 'EDI file too large for this endpoint');
  return { filename, raw: body.content };
}

export function previewEdi(db: Db, scope: Scope, body: { filename?: unknown; content?: unknown }) {
  requirePerm(scope, 'integration_admin');
  const { filename, raw } = checkInput(body);
  return buildPreview(db, scope, filename, raw);
}

const MAPPING_FOR: Record<IntegrationKind, string> = { edi_835: 'x12-835-claim', edi_277: 'x12-277-status', edi_271: 'x12-271-benefits', fhir_eob: 'fhir-r4-eob', fhir_coverage: 'fhir-r4-coverage' };

// Attaches matched items as evidence, resolves facts and, for accounts already under
// investigation, re-evaluates the rule so stale proposals are superseded. Runs inside the caller's tx.
export function attachItems(db: Db, scope: Scope, items: PreviewItem[], source: string, fileRef: Record<string, unknown>, options: Opts271, connectorId: string, reevaluate = true, settled: Map<string, string> = new Map()) {
  const touched = new Map<string, { added: number }>();
  const results: { label: string; accountId: string | null; externalId: string | null; status: MatchStatus; evidenceId: string | null; observations: number }[] = [];
  for (const it of items) {
    if (it.match.status !== 'matched' || !it.kind) {
      if (it.match.accountId && (it.match.status === 'identity_mismatch' || it.match.status === 'insufficient_identity')) {
        audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'account', objectId: it.match.accountId, accountId: it.match.accountId,
          eventType: 'integration_identity_mismatch', details: { source, item: it.label, status: it.match.status, reason: it.match.reason, checks: it.match.checks as never } });
      }
      results.push({ label: it.label, accountId: it.match.accountId, externalId: it.match.externalId, status: it.match.status, evidenceId: null, observations: 0 });
      continue;
    }
    const accountId = it.match.accountId!;
    const content = { schema: 'ar-resolve.integration.v1', kind: it.kind, mapping: mappingRef(MAPPING_FOR[it.kind]), mappingOptions: options, source: fileRef,
      identity: it.identity, match: { status: it.match.status, checks: it.match.checks }, record: it.record, extracted: it.extracted, notes: it.notes };
    const effectiveAt = (it.extracted.find((e) => e.factKey === 'processedDate')?.value as string | undefined) ?? null;
    const ev = addEvidence(db, scope, { accountId, kind: it.kind, title: `${it.setId} ${it.label}`, source, content, effectiveAt });
    if (ev) touched.set(accountId, { added: (touched.get(accountId)?.added ?? 0) + 1 });
    results.push({ label: it.label, accountId, externalId: it.match.externalId, status: 'matched', evidenceId: ev?.evidenceId ?? null, observations: ev?.observations ?? 0 });
  }
  const paused = !!activePause(db, scope.tenantId, scope.clientId);
  const evaluations: Record<string, unknown> = {};
  for (const accountId of touched.keys()) {
    const a = one<AcctRow>(db, 'SELECT account_id, external_id, claim_reference, patient_token, service_date, state, revision FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', scope.tenantId, scope.clientId, accountId)!;
    const resolved = resolveFacts(db, scope, accountId);
    const inflight = one(db, `SELECT 1 FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND state IN ('dispatching','uncertain')`, scope.tenantId, scope.clientId, accountId);
    if (reevaluate && resolved.changed.length && a.state !== 'ready' && !inflight && !paused && !settled.has(accountId)) {
      const r = evaluateAndPropose(db, scope, accountId, { trigger: 'integration_evidence', connector: connectorId });
      evaluations[accountId] = { state: r.state, outcome: r.outcome, superseded: r.superseded };
    } else {
      evaluations[accountId] = { changedFacts: resolved.changed, reevaluated: false, reason: !reevaluate ? 'Caller evaluates' : settled.has(accountId) ? settled.get(accountId) : a.state === 'ready' ? 'Account not yet investigated' : inflight ? 'Action in flight' : paused ? 'Automation paused' : 'No fact changed' };
    }
  }
  return { results, evaluations };
}

export function ingestEdi(db: Db, scope: Scope, body: { filename?: unknown; content?: unknown; expectedSha256?: unknown }) {
  requirePerm(scope, 'integration_admin');
  ensureMappings(db);
  const { filename, raw } = checkInput(body);
  const rawSha256 = sha256(raw);
  if (body.expectedSha256 !== rawSha256) throw conflict('preview_mismatch', 'Ingest must name the sha256 of the previewed file; the content differs from what was previewed', { rawSha256 });
  return tx(db, () => {
    const prior = one<{ file_id: string }>(db, 'SELECT file_id FROM edi_files WHERE tenant_id=? AND client_id=? AND raw_sha256=?', scope.tenantId, scope.clientId, rawSha256);
    if (prior) return { ...fileView(db, scope, prior.file_id), duplicate: true };
    const preview = buildPreview(db, scope, filename, raw);
    if (!preview.valid) throw new AppError(422, 'edi_invalid', preview.error.message, preview.error);
    const fileId = newId('edi');
    const options = preview.mappingOptions;
    // 835 claim payments are reconciled into the outcome ledger first (ADR 0060), against the facts as they
    // stood before this file. An account the remittance reopened or resolved is not re-evaluated here:
    // the reconciliation outcome is the latest word and a human takes it from there.
    const paymentDates = Object.fromEntries(preview.fileLevel.filter((f) => f.setId === '835').map((f) => [f.control as string, (f.payment as { date: string | null }).date]));
    const remittance = reconcile835(db, scope, preview.items, preview.envelope.sender, paymentDates, `edi:${fileId} ${filename}`);
    const settled = new Map<string, string>([
      ...remittance.resolved.map((id) => [id, 'Resolved by remittance reconciliation'] as [string, string]),
      ...remittance.reopened.map((id) => [id, 'Reopened by remittance reconciliation'] as [string, string]),
    ]);
    const attached = attachItems(db, scope, preview.items, `edi:${fileId}`, { fileId, filename, rawSha256, interchangeControl: preview.envelope.control }, options, 'edi_upload', true, settled);
    const ingested = attached.results.filter((r) => r.evidenceId).length;
    const state = preview.summary.ingestable === 0 ? (preview.items.length ? 'nothing_matched' : 'ingested') : preview.summary.ingestable === preview.items.filter((i) => i.kind).length ? 'ingested' : 'partially_ingested';
    const report = { summary: preview.summary, results: attached.results, evaluations: attached.evaluations, fileLevel: preview.fileLevel, ingested, remittance };
    run(db, 'INSERT INTO edi_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, fileId, filename, JSON.stringify(preview.transactionSets), rawSha256, raw,
      JSON.stringify(preview.envelope), JSON.stringify(report), state, JSON.stringify({ options, mappings: ['x12-835-claim', 'x12-277-status', 'x12-271-benefits'].map(mappingRef) }), scope.userId, nowIso());
    const req = newRequest(scope, 'ingest_file', { filename, transactionSets: preview.transactionSets });
    const ev = recordEvent(db, scope, 'edi_upload', req, { outcome: state === 'ingested' ? 'success' : state === 'partially_ingested' ? 'partially_completed' : 'not_found',
      externalRefs: { interchangeControl: preview.envelope.control, fileId }, evidenceLocator: { fileId }, sourceTime: null, receivedTime: nowIso(), rawSha256,
      normalized: { summary: preview.summary, transactionSets: preview.transactionSets }, latencyMs: 0, error: null });
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'edi_file', objectId: fileId, eventType: 'edi_file_ingested',
      details: { filename, rawSha256, state, summary: preview.summary as never, connectorEventId: ev.connectorEventId } });
    return { duplicate: false, fileId, state, report, preview };
  });
}

export function fileView(db: Db, scope: Scope, fileId: string) {
  const r = one<{ file_id: string; filename: string; transaction_sets: string; raw_sha256: string; envelope: string; report: string; state: string; mapping: string; created_by: string; created_at: string; raw: string }>(db,
    'SELECT * FROM edi_files WHERE tenant_id=? AND client_id=? AND file_id=?', scope.tenantId, scope.clientId, fileId);
  if (!r) throw new AppError(404, 'not_found', 'EDI file not found');
  return { fileId: r.file_id, filename: r.filename, transactionSets: JSON.parse(r.transaction_sets), rawSha256: r.raw_sha256, envelope: JSON.parse(r.envelope), report: JSON.parse(r.report),
    state: r.state, mapping: JSON.parse(r.mapping), createdBy: r.created_by, createdAt: r.created_at, raw: r.raw };
}

export function listFiles(db: Db, scope: Scope) {
  return all<{ file_id: string; filename: string; transaction_sets: string; raw_sha256: string; state: string; created_by: string; created_at: string; report: string }>(db,
    'SELECT file_id, filename, transaction_sets, raw_sha256, state, created_by, created_at, report FROM edi_files WHERE tenant_id=? AND client_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50', scope.tenantId, scope.clientId)
    .map((r) => ({ fileId: r.file_id, filename: r.filename, transactionSets: JSON.parse(r.transaction_sets), rawSha256: r.raw_sha256, state: r.state, createdBy: r.created_by, createdAt: r.created_at, summary: JSON.parse(r.report).summary }));
}
