// Account lifecycle: import, investigate, simulated call, fact correction and
// rule evaluation that produces an immutable proposed action or an abstention.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { AppError, canonicalJson, conflict, hashJson, invalid, newId, notFound, now, nowIso, sha256 } from '../util.ts';
import { actionSpec, type RuleDefinition } from '../../shared/rules/catalog.ts';
import { moduleFor, outcomeLabel } from '../../shared/rules/registry.ts';
import { labelFor } from '../../shared/rules/types.ts';
import { audit } from './audit.ts';
import { requirePerm, type Scope } from './auth.ts';
import { activePause } from './controls.ts';
import { addEvidence, validateCorrectionValue } from './evidence.ts';
import { currentFacts, resolveFacts, type FactRow } from './facts.ts';
import { evaluateAccount, type RuleEvaluation } from './rules.ts';
import { missingRequiredCount, selectForAccount } from './scenario.ts';
import { callScript, fetchDocuments } from '../connectors/synthetic-source.ts';

// Phase 0 default pack. Since ADR 0020 the pack and version per account come from
// scenario selection (./scenario.ts); this constant remains for callers that label DED01.
export const ACTIVE_RULE = { id: 'DED01', version: 1 };
export const PROPOSAL_TTL_HOURS = 72;

export interface AccountRow {
  tenant_id: string; client_id: string; account_id: string; external_id: string; payer_id: string; provider_id: string;
  patient_token: string; service_date: string; claim_reference: string; claim_type: string; balance_cents: number;
  currency: string; scenario: string; state: string; revision: number; batch_id: string; source_row_sha256: string;
  followup_due: string | null; created_at: string; updated_at: string;
}

export function getAccountRow(db: Db, scope: Scope, accountId: string): AccountRow {
  const a = one<AccountRow>(db, 'SELECT * FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', scope.tenantId, scope.clientId, accountId);
  if (!a) throw notFound('Account');
  return a;
}

function setAccountState(db: Db, scope: Scope, accountId: string, state: string) {
  run(db, 'UPDATE accounts SET state=?, updated_at=? WHERE tenant_id=? AND client_id=? AND account_id=?', state, nowIso(), scope.tenantId, scope.clientId, accountId);
}

function ensureNotPaused(db: Db, scope: Scope, accountId?: string) {
  const dims = accountId ? one<{ payer_id: string; scenario: string }>(db, 'SELECT payer_id, scenario FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', scope.tenantId, scope.clientId, accountId) : undefined;
  const p = activePause(db, scope.tenantId, scope.clientId, { payerId: dims?.payer_id, scenario: dims?.scenario });
  if (p) throw new AppError(423, 'automation_paused', `Automation is paused (${p.scopeKey}): ${p.reason}`);
}

// ---------------------------------------------------------------- import (FR01)

const COLUMNS = ['external_id', 'payer_id', 'provider_id', 'patient_token', 'service_date', 'claim_reference', 'claim_type', 'balance_cents', 'scenario'];

export interface ImportRowReport { line: number; externalId: string | null; status: 'accepted' | 'duplicate' | 'rejected'; errors: string[] }

function validDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d <= now();
}

export function importInventory(db: Db, scope: Scope, input: { sourceName: string; csv: string; commit: boolean }) {
  requirePerm(scope, 'import');
  const text = input.csv.replace(/\r\n/g, '\n').trim();
  if (!text) throw invalid('The file is empty');
  const [headerLine, ...lines] = text.split('\n');
  const header = headerLine.split(',').map((h) => h.trim());
  const missingCols = COLUMNS.filter((c) => !header.includes(c));
  const unknownCols = header.filter((h) => !COLUMNS.includes(h));
  const mapping = COLUMNS.map((c) => ({ field: c, column: header.includes(c) ? c : null }));
  if (missingCols.length) return { committed: false, sourceSha256: sha256(input.csv), mapping, unknownColumns: unknownCols, rows: [], fatal: `Missing columns: ${missingCols.join(', ')}` };

  const parsed = lines.filter((l) => l.trim()).map((l, i) => {
    const cells = l.split(',').map((c) => c.trim());
    const rec: Record<string, string> = {};
    header.forEach((h, j) => (rec[h] = cells[j] ?? ''));
    return { line: i + 2, rec, cellCount: cells.length };
  });
  const counts = new Map<string, number>();
  for (const p of parsed) counts.set(p.rec.external_id, (counts.get(p.rec.external_id) ?? 0) + 1);

  const reports: ImportRowReport[] = [];
  const toInsert: { rec: Record<string, string>; rowHash: string }[] = [];
  for (const p of parsed) {
    const r = p.rec;
    const errors: string[] = [];
    if (p.cellCount !== header.length) errors.push(`Expected ${header.length} cells, found ${p.cellCount}`);
    if (!/^[A-Z0-9-]{3,40}$/.test(r.external_id ?? '')) errors.push('external_id missing or malformed');
    if ((counts.get(r.external_id) ?? 0) > 1) errors.push('external_id appears more than once in this file (ambiguous)');
    for (const f of ['payer_id', 'provider_id', 'patient_token', 'claim_reference', 'claim_type', 'scenario']) if (!r[f]) errors.push(`${f} is required`);
    if (!validDate(r.service_date ?? '')) errors.push('service_date must be a real past date (YYYY-MM-DD)');
    if (!/^\d+$/.test(r.balance_cents ?? '')) errors.push('balance_cents must be a non-negative whole number of cents');
    const rowHash = sha256(canonicalJson(Object.fromEntries(COLUMNS.map((c) => [c, r[c]]))));
    if (!errors.length) {
      const existing = one<{ source_row_sha256: string }>(db, 'SELECT source_row_sha256 FROM accounts WHERE tenant_id=? AND client_id=? AND external_id=?', scope.tenantId, scope.clientId, r.external_id);
      if (existing && existing.source_row_sha256 === rowHash) { reports.push({ line: p.line, externalId: r.external_id, status: 'duplicate', errors: ['Already imported with identical content; skipped'] }); continue; }
      if (existing) errors.push('An account with this external_id exists with different content (ambiguous); not overwritten');
    }
    if (errors.length) reports.push({ line: p.line, externalId: r.external_id || null, status: 'rejected', errors });
    else { reports.push({ line: p.line, externalId: r.external_id, status: 'accepted', errors: [] }); toInsert.push({ rec: r, rowHash }); }
  }

  const summary = { accepted: toInsert.length, rejected: reports.filter((r) => r.status === 'rejected').length, duplicates: reports.filter((r) => r.status === 'duplicate').length };
  if (!input.commit) return { committed: false, sourceSha256: sha256(input.csv), mapping, unknownColumns: unknownCols, rows: reports, summary };

  const batchId = newId('batch');
  tx(db, () => {
    run(db, 'INSERT INTO import_batches VALUES (?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, batchId, input.sourceName, sha256(input.csv),
      summary.accepted, summary.rejected, summary.duplicates, JSON.stringify(reports), scope.userId, nowIso());
    for (const { rec, rowHash } of toInsert) {
      const accountId = newId('acct');
      const ts = nowIso();
      run(db, `INSERT INTO accounts (tenant_id, client_id, account_id, external_id, payer_id, provider_id, patient_token, service_date, claim_reference,
               claim_type, balance_cents, scenario, state, revision, batch_id, source_row_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        scope.tenantId, scope.clientId, accountId, rec.external_id, rec.payer_id, rec.provider_id, rec.patient_token, rec.service_date,
        rec.claim_reference, rec.claim_type, Number(rec.balance_cents), rec.scenario, 'ready', 1, batchId, rowHash, ts, ts);
      addEvidence(db, scope, { accountId, kind: 'import_row', title: `Inventory row from ${input.sourceName}`, source: `import:${batchId}`, content: { batchId, row: rec, rowSha256: rowHash } });
      audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'account', objectId: accountId, accountId,
        eventType: 'account_imported', details: { batchId, externalId: rec.external_id, rowSha256: rowHash } });
    }
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'import_batch', objectId: batchId,
      eventType: 'import_committed', details: { sourceSha256: sha256(input.csv), ...summary } });
  });
  return { committed: true, batchId, sourceSha256: sha256(input.csv), mapping, unknownColumns: unknownCols, rows: reports, summary };
}

// ---------------------------------------------------------------- queue (FR03)

const STATE_WEIGHT: Record<string, [number, string]> = {
  receipt_uncertain: [60, 'Receipt uncertain: reconcile before any retry'],
  blocked: [50, 'Identity conflict blocks all action'],
  awaiting_review: [40, 'Proposal awaiting review'],
  specialist_review: [30, 'Needs specialist review'],
  needs_information: [25, 'Evidence missing'],
  ready: [20, 'Not yet investigated'],
  approved: [10, 'Approved, waiting for dispatch'],
  awaiting_receipt: [8, 'Waiting for payer receipt'],
  monitoring: [2, 'Monitoring follow-up'],
};

export const QUEUE_VIEWS: Record<string, string[] | null> = {
  all: null,
  awaiting_review: ['awaiting_review'],
  evidence_missing: ['needs_information', 'specialist_review', 'blocked'],
  receipt_uncertain: ['receipt_uncertain'],
  in_flight: ['approved', 'awaiting_receipt', 'monitoring'],
  not_started: ['ready'],
};

export function priorityOf(a: Pick<AccountRow, 'state' | 'service_date' | 'balance_cents'>) {
  const ageDays = Math.max(0, Math.floor((now().getTime() - new Date(a.service_date + 'T00:00:00Z').getTime()) / 86_400_000));
  const [w, why] = STATE_WEIGHT[a.state] ?? [0, a.state];
  const ageScore = Math.min(30, Math.floor(ageDays / 7));
  const balanceScore = Math.min(20, Math.floor(a.balance_cents / 5000));
  return {
    score: w + ageScore + balanceScore,
    ageDays,
    explanation: [
      `${why} (+${w})`,
      `${ageDays} days since service (+${ageScore})`,
      `Balance weight (+${balanceScore})`,
      'No verified payer deadline on file (deadline not estimated)',
    ],
  };
}

export function listAccounts(db: Db, scope: Scope, opts: { view?: string; q?: string; page?: number; pageSize?: number }) {
  requirePerm(scope, 'view');
  const states = QUEUE_VIEWS[opts.view ?? 'all'];
  if (states === undefined) throw invalid('Unknown view');
  const params: unknown[] = [scope.tenantId, scope.clientId];
  let where = 'tenant_id=? AND client_id=?';
  if (states) { where += ` AND state IN (${states.map(() => '?').join(',')})`; params.push(...states); }
  if (opts.q) { where += ' AND (external_id LIKE ? OR claim_reference LIKE ?)'; params.push(`%${opts.q}%`, `%${opts.q}%`); }
  const rows = all<AccountRow>(db, `SELECT * FROM accounts WHERE ${where}`, ...params);
  const requiredCache = new Map<string, string[]>();
  const items = rows.map((a) => {
    const p = priorityOf(a);
    const action = one<{ kind: string; state: string }>(db, "SELECT kind, state FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND kind <> 'note_writeback' ORDER BY created_at DESC, rowid DESC LIMIT 1", scope.tenantId, scope.clientId, a.account_id);
    // Missing is counted against the account's selected pack (ADR 0020).
    const missing = missingRequiredCount(db, scope, a.account_id, requiredCache);
    const conflicting = one<{ n: number }>(db, `SELECT COUNT(*) n FROM facts f WHERE tenant_id=? AND client_id=? AND account_id=? AND status='conflicting'
      AND version=(SELECT MAX(version) FROM facts g WHERE g.tenant_id=f.tenant_id AND g.client_id=f.client_id AND g.account_id=f.account_id AND g.fact_key=f.fact_key)`, scope.tenantId, scope.clientId, a.account_id)!.n;
    return {
      accountId: a.account_id, externalId: a.external_id, payerId: a.payer_id, claimReference: a.claim_reference, scenario: a.scenario,
      balanceCents: a.balance_cents, serviceDate: a.service_date, state: a.state, revision: a.revision,
      nextStep: action ? { kind: action.kind, label: outcomeLabel(action.kind), state: action.state } : null,
      evidenceState: conflicting ? 'conflicting' : missing ? 'incomplete' : a.state === 'ready' ? 'not_collected' : 'complete',
      priority: p,
    };
  });
  items.sort((x, y) => y.priority.score - x.priority.score || x.externalId.localeCompare(y.externalId));
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const page = Math.max(1, opts.page ?? 1);
  const counts = Object.fromEntries(Object.entries(QUEUE_VIEWS).map(([k, s]) => [k,
    s ? one<{ n: number }>(db, `SELECT COUNT(*) n FROM accounts WHERE tenant_id=? AND client_id=? AND state IN (${s.map(() => '?').join(',')})`, scope.tenantId, scope.clientId, ...s)!.n
      : one<{ n: number }>(db, 'SELECT COUNT(*) n FROM accounts WHERE tenant_id=? AND client_id=?', scope.tenantId, scope.clientId)!.n]));
  return { total: items.length, page, pageSize, items: items.slice((page - 1) * pageSize, page * pageSize), counts };
}

// ---------------------------------------------------------------- investigation

function ensureNoActionInFlight(db: Db, scope: Scope, accountId: string) {
  const inflight = one<{ action_id: string; state: string }>(db,
    `SELECT action_id, state FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND state IN ('dispatching','uncertain')`,
    scope.tenantId, scope.clientId, accountId);
  if (inflight) throw conflict('action_in_flight', `An approved action is ${inflight.state}; reconcile it before starting new work`, inflight);
}

export function investigate(db: Db, scope: Scope, accountId: string) {
  requirePerm(scope, 'investigate');
  ensureNotPaused(db, scope, accountId);
  return tx(db, () => {
    const a = getAccountRow(db, scope, accountId);
    ensureNoActionInFlight(db, scope, accountId);
    let added = 0;
    for (const d of fetchDocuments(scope.clientId, a.external_id)) {
      if (addEvidence(db, scope, { accountId, kind: d.kind, title: d.title, source: d.source, content: d.content, effectiveAt: d.effectiveAt })) added++;
    }
    resolveFacts(db, scope, accountId);
    return evaluateAndPropose(db, scope, accountId, { trigger: 'investigation', evidenceAdded: added });
  });
}

const CALL_STATES = ['queued', 'dialing', 'ivr', 'hold', 'representative', 'wrapping', 'completed'];

export function simulateCall(db: Db, scope: Scope, accountId: string) {
  requirePerm(scope, 'investigate');
  ensureNotPaused(db, scope, accountId);
  return tx(db, () => {
    const a = getAccountRow(db, scope, accountId);
    if (a.state === 'blocked') throw conflict('identity_blocked', 'Identity conflict: calls are blocked until the account identity is resolved');
    ensureNoActionInFlight(db, scope, accountId);
    const script = callScript(scope.clientId, a.external_id);
    if (!script) throw new AppError(422, 'no_call_needed', 'No synthetic call script exists for this account; the available evidence is the complete synthetic record');
    const interactionId = newId('call');
    const start = now().getTime();
    const transitions = CALL_STATES.map((s, i) => ({ state: s, at: new Date(start + i * 1000).toISOString() }));
    const content = {
      mocked: true, channel: 'voice', destination: `${a.payer_id} provider services (synthetic)`, callReference: script.ref,
      notice: 'Pre-scripted synthetic transcript. No telephony, speech or model was used.',
      turns: script.turns.map(([speaker, text, extracts], i) => ({ turn: i + 1, speaker, text, ...(extracts ? { extracts } : {}) })),
    };
    const ev = addEvidence(db, scope, { accountId, kind: 'call_transcript', title: `Simulated payer call ${script.ref}`, source: 'mock-voice-adapter', content, effectiveAt: nowIso() });
    run(db, 'INSERT INTO interactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, accountId, interactionId, 'voice',
      content.destination, 'completed', JSON.stringify(transitions), ev?.evidenceId ?? null, script.ref, 1, scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'interaction', objectId: interactionId, accountId,
      eventType: 'call_completed', details: { mocked: true, callReference: script.ref, duplicateTranscript: !ev } });
    resolveFacts(db, scope, accountId);
    return evaluateAndPropose(db, scope, accountId, { trigger: 'call', interactionId });
  });
}

export function correctFact(db: Db, scope: Scope, accountId: string, factKey: string, body: { value: unknown; reason: string; expectedRevision: number }) {
  requirePerm(scope, 'correct_fact');
  if (!body.reason || body.reason.trim().length < 5) throw invalid('A correction reason is required');
  validateCorrectionValue(factKey, body.value);
  return tx(db, () => {
    const a = getAccountRow(db, scope, accountId);
    if (body.expectedRevision !== a.revision) throw conflict('stale_revision', 'The account changed since you opened it. Refresh to see the new evidence.', { currentRevision: a.revision });
    ensureNoActionInFlight(db, scope, accountId);
    const prev = currentFacts(db, scope, accountId).get(factKey);
    addEvidence(db, scope, { accountId, kind: 'reviewer_correction', title: `Correction of ${factKey} by ${scope.displayName}`, source: `user:${scope.userId}`,
      content: { factKey, value: body.value, reason: body.reason.trim(), previous: prev ? { value: prev.value, status: prev.status, version: prev.version } : null, correctedBy: scope.userId, correctedAt: nowIso() } });
    resolveFacts(db, scope, accountId);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'fact', objectId: factKey, accountId,
      eventType: 'fact_corrected', details: { factKey, previous: prev?.value ?? null, previousStatus: prev?.status ?? 'missing', value: body.value as never, reason: body.reason.trim() } });
    return evaluateAndPropose(db, scope, accountId, { trigger: 'fact_correction', factKey });
  });
}

// ---------------------------------------------------------------- evaluation and proposal

function fmt(c: unknown) {
  return typeof c === 'number' ? `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(c);
}

export function draftNote(a: AccountRow, facts: Map<string, FactRow>, ev: RuleEvaluation, evidenceTitles: Map<string, string>, def?: RuleDefinition): string {
  const mod = def ? moduleFor(def) : moduleFor({ logicModule: 'ded01.v1' } as RuleDefinition);
  const lines: string[] = [];
  lines.push('SYSTEM-DRAFTED NOTE (deterministic template, synthetic data). Not yet reviewed.');
  lines.push(`Account ${a.external_id}, claim ${a.claim_reference}, payer ${a.payer_id}, DOS ${a.service_date}.`);
  const show = (k: string, label: string, money = false) => {
    const f = facts.get(k);
    if (!f || f.status === 'missing') return `${label}: MISSING`;
    if (f.status === 'conflicting') return `${label}: CONFLICTING (${f.candidates.map((c) => `${money ? fmt(c.value) : String(c.value)} from ${evidenceTitles.get(c.evidenceId) ?? c.evidenceId}`).join(' vs ')})`;
    const v = money ? fmt(f.value) : typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value);
    return `${label}: ${v} [${f.status.toUpperCase()}; ${evidenceTitles.get(f.evidenceId ?? '') ?? 'source'}]`;
  };
  lines.push('Facts:');
  for (const [k, label, money] of mod.noteFacts) lines.push(`  - ${show(k, label, money)}`);
  const calc = mod.calculationText?.(ev.result);
  if (calc) lines.push(calc);
  lines.push(`Reasons: ${ev.result.reasonCodes.map(mod.reasonLabel).join('; ')}.`);
  lines.push(`Proposed next step: ${labelFor(def ?? null, mod, ev.result.outcome)}.`);
  lines.push('Action status: proposed only. Nothing has been submitted to the payer. No payment has been received.');
  for (const extra of def ? mod.noteExtras?.(def, ev.result) ?? [] : []) lines.push(extra);
  if (ev.unusableFacts.length) lines.push(`Unresolved: ${ev.unusableFacts.map((u) => `${u.key} (${u.status})`).join(', ')}.`);
  lines.push(`Rule ${ev.ruleId} ${ev.ruleState} v${ev.ruleVersion} (sha256 ${ev.ruleSha256.slice(0, 12)}).`);
  return lines.join('\n');
}

export function evaluateAndPropose(db: Db, scope: Scope, accountId: string, context: Record<string, unknown>) {
  const a = getAccountRow(db, scope, accountId);
  const facts = currentFacts(db, scope, accountId);
  // FR05: choose the pack from evidence; FR06: choose the runnable/pinned version.
  const choice = selectForAccount(db, scope, a, facts);
  const rule = choice.rule;
  const ev = evaluateAccount(rule, a, facts, { selection: choice.selection, asOf: nowIso().slice(0, 10) });
  const def: RuleDefinition = rule.definition;
  const mod = moduleFor(def);

  // Evidence changed: open proposals are superseded, and approvals not yet
  // dispatched lose their authority (FR11, docs/04 approval and concurrency).
  const superseded = all<{ action_id: string; state: string }>(db,
    `SELECT action_id, state FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND state IN ('awaiting_review','approved','needs_evidence') AND expected_revision <> ?`,
    scope.tenantId, scope.clientId, accountId, a.revision);
  for (const s of superseded) {
    run(db, `UPDATE proposed_actions SET state='superseded', updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=?`, nowIso(), scope.tenantId, scope.clientId, s.action_id);
    run(db, `UPDATE action_outbox SET state='blocked', last_error='Superseded by evidence revision', updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=? AND state='pending'`, nowIso(), scope.tenantId, scope.clientId, s.action_id);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: 'system', objectType: 'action', objectId: s.action_id, accountId,
      eventType: 'proposal_superseded', details: { previousState: s.state, newRevision: a.revision } });
  }
  // Same revision already evaluated with an open proposal: nothing new to decide.
  const open = one<{ action_id: string }>(db, `SELECT action_id FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND state IN ('awaiting_review') AND expected_revision=? AND kind <> 'note_writeback'`,
    scope.tenantId, scope.clientId, accountId, a.revision);

  const identityFalse = facts.get('identityVerified')?.status === 'verified' && facts.get('identityVerified')?.value === false;
  const outcome = ev.result.outcome;
  const spec = actionSpec(def, outcome)!;
  const runState = identityFalse ? 'blocked' : ev.result.abstained ? (outcome === 'collect_evidence' ? 'needs_information' : 'specialist_review') : 'awaiting_review';
  const runId = newId('run');
  run(db, 'INSERT INTO workflow_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, accountId, runId, a.revision,
    ev.ruleId, ev.ruleVersion, ev.ruleSha256, runState, canonicalJson(ev.result), canonicalJson({ input: ev.input, factRefs: ev.factRefs, scopeMatch: ev.scopeMatch, context, selection: choice.selection, resolution: choice.resolution, scenarioMap: choice.map }), scope.userId, nowIso());
  audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'run', objectId: runId, accountId,
    eventType: identityFalse ? 'identity_blocked' : ev.result.abstained ? 'run_abstained' : 'proposal_generated',
    details: { outcome, reasonCodes: ev.result.reasonCodes, accountRevision: a.revision, rule: `${ev.ruleId}@${ev.ruleVersion}`, trigger: context.trigger as string } });

  let actionId: string | null = open?.action_id ?? null;
  if (!identityFalse && !ev.result.abstained && !open) {
    const evidence = all<{ evidence_id: string; kind: string; sha256: string; title: string }>(db,
      'SELECT evidence_id, kind, sha256, title FROM evidence WHERE tenant_id=? AND client_id=? AND account_id=?', scope.tenantId, scope.clientId, accountId);
    const used = new Set(ev.factRefs.filter((f) => f.used && f.evidenceId).map((f) => f.evidenceId));
    const payload = {
      schema: 'ar-resolve.action.v1',
      environment: 'synthetic',
      actionKind: outcome,
      riskClass: spec.risk,
      account: { tenantId: scope.tenantId, clientId: scope.clientId, accountId, externalId: a.external_id, claimReference: a.claim_reference, payerId: a.payer_id, serviceDate: a.service_date },
      destination: spec.connector === 'sim_payer' ? { connector: 'sim_payer', payerId: a.payer_id, channel: 'simulated payer inquiry API' } : { connector: 'internal_worklist', worklist: `${scope.clientId} AR worklist` },
      request: mod.request(outcome, a, ev.result, def),
      basis: { ruleId: ev.ruleId, ruleVersion: ev.ruleVersion, ruleSha256: ev.ruleSha256, accountRevision: a.revision, reasonCodes: ev.result.reasonCodes,
        facts: ev.factRefs.filter((f) => f.used).map((f) => ({ key: f.key, version: f.version, status: f.status, evidenceId: f.evidenceId })) },
      evidence: evidence.filter((e) => used.has(e.evidence_id)).map((e) => ({ evidenceId: e.evidence_id, kind: e.kind, sha256: e.sha256 })),
      prohibited: def.prohibitedActions,
    };
    const titles = new Map(evidence.map((e) => [e.evidence_id, e.title]));
    actionId = newId('act');
    const expires = new Date(now().getTime() + PROPOSAL_TTL_HOURS * 3600_000).toISOString();
    run(db, `INSERT INTO proposed_actions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, scope.tenantId, scope.clientId, actionId, accountId, runId, a.revision,
      outcome, spec.risk, spec.connector!, canonicalJson(payload), hashJson(payload), draftNote(a, facts, ev, titles, def), 'awaiting_review', expires, scope.userId, nowIso(), nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'action', objectId: actionId, accountId,
      eventType: 'action_proposed', details: { kind: outcome, payloadSha256: hashJson(payload), expectedRevision: a.revision, expiresAt: expires } });
  }
  setAccountState(db, scope, accountId, runState);
  return { runId, state: runState, outcome, reasonCodes: ev.result.reasonCodes, actionId, accountRevision: a.revision, superseded: superseded.map((s) => s.action_id),
    rule: { id: ev.ruleId, version: ev.ruleVersion, via: choice.resolution.via }, scenario: { status: choice.selection.status, selected: choice.selection.scenario } };
}
