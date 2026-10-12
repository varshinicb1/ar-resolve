// Follow-up calendar (FR13). A follow-up date comes from a payer commitment that
// was captured from evidence (value + unit + business/calendar basis + source
// evidence and locator). Without one, the task says "no verified commitment" and
// uses the client's supervisor-configured review interval, labelled as internal
// policy. Generic turnaround assumptions are never used.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { canonicalJson, conflict, invalid, newId, notFound, nowIso } from '../util.ts';
import { audit } from './audit.ts';
import { open as openSealed } from './phi.ts';
import { requirePerm, type Scope } from './auth.ts';
import { addDays, computeDue, dayDiff, isDate, resolveCalendar } from './calendar.ts';
import { recordLedger } from './outcomes.ts';

export interface Actor { tenantId: string; clientId: string; userId: string }

const OPEN = ['scheduled', 'due', 'overdue', 'snoozed'];
const SYSTEM = 'system:followup';
export const today = () => nowIso().slice(0, 10);

export interface Policy { version: number; intervalValue: number; intervalUnit: 'days' | 'weeks'; basis: 'business' | 'calendar'; reason: string; createdBy: string; createdAt: string }

export function currentPolicy(db: Db, tenantId: string, clientId: string): Policy | null {
  const r = one<{ version: number; interval_value: number; interval_unit: 'days' | 'weeks'; basis: 'business' | 'calendar'; reason: string; created_by: string; created_at: string }>(db,
    'SELECT * FROM followup_policies WHERE tenant_id=? AND client_id=? ORDER BY version DESC LIMIT 1', tenantId, clientId);
  return r ? { version: r.version, intervalValue: r.interval_value, intervalUnit: r.interval_unit, basis: r.basis, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at } : null;
}

export function setPolicy(db: Db, scope: Scope, body: { intervalValue?: number; intervalUnit?: string; basis?: string; reason?: string }) {
  requirePerm(scope, 'operate');
  const v = Number(body.intervalValue);
  if (!Number.isInteger(v) || v < 1 || v > 120) throw invalid('intervalValue must be a whole number from 1 to 120');
  if (body.intervalUnit !== 'days' && body.intervalUnit !== 'weeks') throw invalid('intervalUnit must be days or weeks');
  if (body.basis !== 'business' && body.basis !== 'calendar') throw invalid('basis must be business or calendar');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 5) throw invalid('A reason is required');
  return tx(db, () => {
    const version = (currentPolicy(db, scope.tenantId, scope.clientId)?.version ?? 0) + 1;
    run(db, 'INSERT INTO followup_policies VALUES (?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, version, v, body.intervalUnit, body.basis, reason, scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'followup_policy', objectId: `${scope.clientId}@${version}`,
      eventType: 'followup_policy_set', details: { version, intervalValue: v, intervalUnit: body.intervalUnit as string, basis: body.basis as string, reason } });
    return currentPolicy(db, scope.tenantId, scope.clientId);
  });
}

// ---------------------------------------------------------------- commitments

interface EvidenceRow { evidence_id: string; account_id: string; kind: string; title: string; content: string; observed_at: string; effective_at: string | null }

function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export interface CommitmentInput { kind: 'turnaround' | 'reprocess' | 'callback'; value: number; unit: 'days' | 'weeks'; basis: 'business' | 'calendar' }

function validateCommitment(c: Partial<CommitmentInput>): CommitmentInput {
  if (!['turnaround', 'reprocess', 'callback'].includes(c.kind as string)) throw invalid('kind must be turnaround, reprocess or callback');
  if (!Number.isInteger(c.value) || (c.value as number) < 1 || (c.value as number) > 365) throw invalid('value must be a whole number from 1 to 365');
  if (c.unit !== 'days' && c.unit !== 'weeks') throw invalid('unit must be days or weeks');
  if (c.basis !== 'business' && c.basis !== 'calendar') throw invalid('basis must be business or calendar (state what the payer said; do not assume)');
  return c as CommitmentInput;
}

function insertCommitment(db: Db, actor: Actor, accountId: string, ev: EvidenceRow, c: CommitmentInput, locator: unknown, quote: string,
  method: 'structured' | 'specialist', actionId: string | null): string {
  const id = newId('cmt');
  const anchor = (ev.effective_at ?? ev.observed_at).slice(0, 10);
  run(db, 'INSERT INTO payer_commitments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', actor.tenantId, actor.clientId, id, accountId, actionId, c.kind, c.value, c.unit, c.basis,
    anchor, ev.evidence_id, canonicalJson(locator), quote.slice(0, 400), method, method === 'structured' ? 'verified' : 'reported', actor.userId, nowIso());
  audit(db, { tenantId: actor.tenantId, clientId: actor.clientId, actorId: actor.userId, objectType: 'commitment', objectId: id, accountId,
    eventType: 'payer_commitment_captured', details: { kind: c.kind, value: c.value, unit: c.unit, basis: c.basis, evidenceId: ev.evidence_id, locator: locator as never, method } });
  recordLedger(db, actor, { accountId, actionId, entryType: 'payer_promise', attribution: 'not_applicable',
    attributionReason: 'A payer promise is a commitment, not an outcome. It is never counted as recovery.', sourceType: 'commitment', sourceId: id, evidenceId: ev.evidence_id });
  return id;
}

// Specialist captures a commitment they read in an evidence item. The locator must
// resolve inside that evidence; the quoted source text is stored for the reviewer.
export function captureCommitment(db: Db, scope: Scope, accountId: string, body: { evidenceId?: string; locator?: { turn?: number; path?: string } } & Partial<CommitmentInput>) {
  requirePerm(scope, 'investigate');
  const c = validateCommitment(body);
  return tx(db, () => {
    const ev = one<EvidenceRow>(db, 'SELECT * FROM evidence WHERE tenant_id=? AND client_id=? AND account_id=? AND evidence_id=?', scope.tenantId, scope.clientId, accountId, String(body.evidenceId ?? ''));
    if (!ev) throw notFound('Evidence on this account');
    const content = JSON.parse(openSealed(ev.content));
    let locator: Record<string, unknown>;
    let quote: string;
    if (ev.kind === 'call_transcript') {
      const turn = (content.turns ?? []).find((t: { turn: number }) => t.turn === body.locator?.turn);
      if (!turn) throw invalid('locator.turn does not exist in this transcript');
      if (turn.speaker !== 'rep') throw invalid('A payer commitment must come from a representative turn');
      locator = { turn: turn.turn, speaker: 'rep' };
      quote = String(turn.text);
    } else {
      const path = String(body.locator?.path ?? '');
      const v = path ? at(content, path) : undefined;
      if (v === undefined) throw invalid('locator.path does not resolve in this evidence');
      locator = { path };
      quote = typeof v === 'string' ? v : canonicalJson(v);
    }
    const commitmentId = insertCommitment(db, scope, accountId, ev, c, locator, quote, 'specialist', null);
    const followup = schedule(db, scope, accountId, null, commitmentId);
    return { commitmentId, followup };
  });
}

// ---------------------------------------------------------------- scheduling

interface AccountLite { payer_id: string }

function schedule(db: Db, actor: Actor, accountId: string, actionId: string | null, commitmentId: string | null) {
  const acct = one<AccountLite>(db, 'SELECT payer_id FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', actor.tenantId, actor.clientId, accountId);
  if (!acct) throw notFound('Account');
  const cal = resolveCalendar(db, actor.tenantId, actor.clientId, acct.payer_id);
  let basis: 'payer_commitment' | 'policy_interval';
  let anchor: string;
  let label: string;
  let comp;
  let policyVersion: number | null = null;
  if (commitmentId) {
    const c = one<{ kind: string; value: number; unit: 'days' | 'weeks'; basis: 'business' | 'calendar'; anchor_date: string; status: string; action_id: string | null }>(db,
      'SELECT * FROM payer_commitments WHERE tenant_id=? AND client_id=? AND commitment_id=?', actor.tenantId, actor.clientId, commitmentId)!;
    basis = 'payer_commitment';
    anchor = c.anchor_date;
    actionId = actionId ?? c.action_id;
    comp = computeDue(anchor, c.value, c.unit, c.basis, cal);
    label = `Payer commitment (${c.status}): ${c.kind} within ${c.value} ${c.basis} ${c.unit} from ${anchor}`;
  } else {
    const p = currentPolicy(db, actor.tenantId, actor.clientId);
    if (!p) throw conflict('no_policy', 'No verified commitment and no review-interval policy is configured for this client');
    basis = 'policy_interval';
    policyVersion = p.version;
    anchor = today();
    comp = computeDue(anchor, p.intervalValue, p.intervalUnit, p.basis, cal);
    label = `No verified commitment. Internal review interval: ${p.intervalValue} ${p.basis} ${p.intervalUnit} (policy v${p.version}, not a payer promise)`;
  }
  // One open follow-up per account: a new basis supersedes the previous one.
  for (const prev of all<{ followup_id: string }>(db, `SELECT followup_id FROM followup_tasks WHERE tenant_id=? AND client_id=? AND account_id=? AND state IN (${OPEN.map(() => '?').join(',')})`,
    actor.tenantId, actor.clientId, accountId, ...OPEN)) {
    run(db, `UPDATE followup_tasks SET state='superseded', updated_at=? WHERE tenant_id=? AND client_id=? AND followup_id=?`, nowIso(), actor.tenantId, actor.clientId, prev.followup_id);
    audit(db, { tenantId: actor.tenantId, clientId: actor.clientId, actorId: actor.userId, objectType: 'followup', objectId: prev.followup_id, accountId, eventType: 'followup_superseded', details: { by: basis } });
  }
  const id = newId('fu');
  const state = comp.dueDate < today() ? 'overdue' : comp.dueDate === today() ? 'due' : 'scheduled';
  run(db, `INSERT INTO followup_tasks (tenant_id, client_id, followup_id, account_id, action_id, basis, commitment_id, policy_version, calendar_id, calendar_version,
    anchor_date, due_date, computation, label, state, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    actor.tenantId, actor.clientId, id, accountId, actionId, basis, commitmentId, policyVersion, cal.calendarId, cal.version, anchor, comp.dueDate,
    canonicalJson(comp), label, 'scheduled', actor.userId, nowIso(), nowIso());
  run(db, 'UPDATE accounts SET followup_due=?, updated_at=? WHERE tenant_id=? AND client_id=? AND account_id=?', comp.dueDate, nowIso(), actor.tenantId, actor.clientId, accountId);
  audit(db, { tenantId: actor.tenantId, clientId: actor.clientId, actorId: actor.userId, objectType: 'followup', objectId: id, accountId,
    eventType: 'followup_scheduled', details: { basis, commitmentId, policyVersion, dueDate: comp.dueDate, calendar: `${cal.calendarId}@${cal.version}`, warnings: comp.warnings } });
  if (state !== 'scheduled') transition(db, { tenant_id: actor.tenantId, client_id: actor.clientId, followup_id: id, account_id: accountId, basis, due_date: comp.dueDate, state: 'scheduled', due_emitted: 0 }, state);
  return { followupId: id, basis, dueDate: comp.dueDate, label, computation: comp };
}

// Policy-based follow-up for an account with no captured commitment (e.g. after a
// call that gave no turnaround). Requires the specialist to choose it explicitly.
export function schedulePolicyFollowup(db: Db, scope: Scope, accountId: string) {
  requirePerm(scope, 'manage_followups');
  return tx(db, () => schedule(db, scope, accountId, null, null));
}

// Hook called by the outbox worker after a receipt is recorded (same transaction).
// Payer-facing receipts get a follow-up; a structured commitment in the receipt is
// captured with its exact path. Internal worklist and note write-back do not.
export function afterReceipt(db: Db, o: { tenant_id: string; client_id: string; action_id: string; connector: string }, accountId: string, evidenceId: string) {
  if (o.connector === 'internal_worklist' || o.connector === 'sim_pm') return;
  const actor: Actor = { tenantId: o.tenant_id, clientId: o.client_id, userId: SYSTEM };
  if (one(db, 'SELECT 1 FROM followup_tasks WHERE tenant_id=? AND client_id=? AND action_id=?', o.tenant_id, o.client_id, o.action_id)) return;
  recordLedger(db, actor, { accountId, actionId: o.action_id, entryType: 'request_accepted', attribution: 'not_applicable',
    attributionReason: 'The payer accepted the request for review. This is not an adjudication or a payment.', sourceType: 'receipt', sourceId: evidenceId, evidenceId });
  const ev = one<EvidenceRow>(db, 'SELECT * FROM evidence WHERE tenant_id=? AND client_id=? AND evidence_id=?', o.tenant_id, o.client_id, evidenceId)!;
  const content = JSON.parse(openSealed(ev.content));
  let commitmentId: string | null = null;
  const c = content.commitment;
  if (c && typeof c === 'object') {
    try {
      const valid = validateCommitment({ kind: c.kind, value: c.value, unit: c.unit, basis: c.basis });
      commitmentId = insertCommitment(db, actor, accountId, ev, valid, { path: 'commitment' }, String(c.statement ?? canonicalJson(c)), 'structured', o.action_id);
    } catch { /* malformed commitment: ignored, policy interval applies and says so */ }
  }
  schedule(db, actor, accountId, o.action_id, commitmentId);
}

// ---------------------------------------------------------------- queue and lifecycle

interface TaskRow {
  tenant_id: string; client_id: string; followup_id: string; account_id: string; action_id: string | null; basis: string; commitment_id: string | null;
  policy_version: number | null; calendar_id: string; calendar_version: number; anchor_date: string; due_date: string; computation: string; label: string;
  state: string; snoozed_until: string | null; due_emitted: number; completed_by: string | null; completed_at: string | null; completion_code: string | null;
  created_by: string; created_at: string; updated_at: string;
}

function transition(db: Db, t: Pick<TaskRow, 'tenant_id' | 'client_id' | 'followup_id' | 'account_id' | 'basis' | 'due_date' | 'state' | 'due_emitted'>, to: string) {
  run(db, 'UPDATE followup_tasks SET state=?, snoozed_until=NULL, due_emitted=?, updated_at=? WHERE tenant_id=? AND client_id=? AND followup_id=?',
    to, to === 'due' || to === 'overdue' ? 1 : t.due_emitted, nowIso(), t.tenant_id, t.client_id, t.followup_id);
  if ((to === 'due' || to === 'overdue') && !t.due_emitted) {
    audit(db, { tenantId: t.tenant_id, clientId: t.client_id, actorId: SYSTEM, objectType: 'followup', objectId: t.followup_id, accountId: t.account_id,
      eventType: 'followup_due', details: { basis: t.basis, daysLate: Math.max(0, dayDiff(t.due_date, today())) } });
  }
  if (to === 'overdue') {
    audit(db, { tenantId: t.tenant_id, clientId: t.client_id, actorId: SYSTEM, objectType: 'followup', objectId: t.followup_id, accountId: t.account_id,
      eventType: 'followup_overdue', details: { dueDate: t.due_date } });
  }
}

// Worker tick: scheduled -> due on the due date, due -> overdue after it, and a
// snooze that has ended returns the task to its date-derived state.
export function tickFollowups(db: Db): { due: number; overdue: number; unsnoozed: number } {
  const rep = { due: 0, overdue: 0, unsnoozed: 0 };
  const d = today();
  for (const t of all<TaskRow>(db, `SELECT * FROM followup_tasks WHERE state IN ('scheduled','due','snoozed') AND (due_date <= ? OR state='snoozed')`, d)) {
    if (t.state === 'snoozed' && t.snoozed_until && t.snoozed_until > d) continue;
    const target = t.due_date < d ? 'overdue' : t.due_date === d ? 'due' : 'scheduled';
    if (target === t.state) continue;
    tx(db, () => transition(db, t, target));
    if (t.state === 'snoozed') rep.unsnoozed++;
    if (target === 'due') rep.due++;
    if (target === 'overdue') rep.overdue++;
  }
  return rep;
}

function view(t: TaskRow, externalId: string, payerId: string) {
  const d = today();
  const effective = t.state === 'snoozed' ? 'snoozed' : t.state;
  return {
    followupId: t.followup_id, accountId: t.account_id, externalId, payerId, actionId: t.action_id, basis: t.basis, commitmentId: t.commitment_id,
    policyVersion: t.policy_version, calendar: { id: t.calendar_id, version: t.calendar_version }, anchorDate: t.anchor_date, dueDate: t.due_date,
    computation: JSON.parse(t.computation), label: t.label, state: effective, snoozedUntil: t.snoozed_until, daysUntilDue: dayDiff(d, t.due_date),
    completedBy: t.completed_by, completedAt: t.completed_at, completionCode: t.completion_code, createdBy: t.created_by, createdAt: t.created_at,
  };
}

export function listFollowups(db: Db, scope: Scope, opts: { bucket?: string; accountId?: string } = {}) {
  requirePerm(scope, 'view');
  const d = today();
  const params: unknown[] = [scope.tenantId, scope.clientId];
  let where = 'f.tenant_id=? AND f.client_id=?';
  if (opts.accountId) { where += ' AND f.account_id=?'; params.push(opts.accountId); }
  const rows = all<TaskRow & { external_id: string; payer_id: string }>(db, `SELECT f.*, a.external_id, a.payer_id FROM followup_tasks f
    JOIN accounts a ON a.tenant_id=f.tenant_id AND a.client_id=f.client_id AND a.account_id=f.account_id WHERE ${where} ORDER BY f.due_date, f.created_at`, ...params);
  const items = rows.map((r) => view(r, r.external_id, r.payer_id));
  const buckets = {
    overdue: items.filter((i) => i.state === 'overdue'),
    due_today: items.filter((i) => i.state === 'due'),
    upcoming: items.filter((i) => i.state === 'scheduled'),
    snoozed: items.filter((i) => i.state === 'snoozed'),
    completed: items.filter((i) => i.state === 'completed'),
  };
  const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
  if (opts.bucket && opts.bucket !== 'all') {
    const b = buckets[opts.bucket as keyof typeof buckets];
    if (!b) throw invalid('Unknown bucket');
    return { today: d, counts, items: b, policy: currentPolicy(db, scope.tenantId, scope.clientId) };
  }
  return { today: d, counts, items: items.filter((i) => i.state !== 'superseded'), policy: currentPolicy(db, scope.tenantId, scope.clientId) };
}

function getTask(db: Db, scope: Scope, id: string): TaskRow {
  const t = one<TaskRow>(db, 'SELECT * FROM followup_tasks WHERE tenant_id=? AND client_id=? AND followup_id=?', scope.tenantId, scope.clientId, id);
  if (!t) throw notFound('Follow-up');
  return t;
}

export function snoozeFollowup(db: Db, scope: Scope, id: string, body: { until?: string; reason?: string }) {
  requirePerm(scope, 'manage_followups');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 5) throw invalid('A snooze reason is required');
  if (!isDate(body.until)) throw invalid('until must be a date (YYYY-MM-DD)');
  const d = today();
  if (body.until <= d) throw invalid('Snooze until a future date');
  if (body.until > addDays(d, 30)) throw invalid('A snooze cannot exceed 30 days; reschedule from a new commitment instead');
  return tx(db, () => {
    const t = getTask(db, scope, id);
    if (!OPEN.includes(t.state)) throw conflict('not_open', `This follow-up is ${t.state}`);
    run(db, `UPDATE followup_tasks SET state='snoozed', snoozed_until=?, updated_at=? WHERE tenant_id=? AND client_id=? AND followup_id=?`, body.until, nowIso(), scope.tenantId, scope.clientId, id);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'followup', objectId: id, accountId: t.account_id,
      eventType: 'followup_snoozed', details: { until: body.until as string, reason, dueDate: t.due_date } });
    return { followupId: id, state: 'snoozed', snoozedUntil: body.until, dueDate: t.due_date };
  });
}

export const COMPLETION_CODES = ['status_obtained', 'payer_actioned', 'escalated', 'no_longer_needed'] as const;

export function completeFollowup(db: Db, scope: Scope, id: string, body: { code?: string; note?: string }) {
  requirePerm(scope, 'manage_followups');
  if (!COMPLETION_CODES.includes(body.code as never)) throw invalid(`code must be one of ${COMPLETION_CODES.join(', ')}`);
  return tx(db, () => {
    const t = getTask(db, scope, id);
    if (!OPEN.includes(t.state)) throw conflict('not_open', `This follow-up is ${t.state}`);
    const at = nowIso();
    run(db, `UPDATE followup_tasks SET state='completed', snoozed_until=NULL, completed_by=?, completed_at=?, completion_code=?, updated_at=? WHERE tenant_id=? AND client_id=? AND followup_id=?`,
      scope.userId, at, body.code, at, scope.tenantId, scope.clientId, id);
    run(db, 'UPDATE accounts SET followup_due=NULL, updated_at=? WHERE tenant_id=? AND client_id=? AND account_id=? AND followup_due=?', at, scope.tenantId, scope.clientId, t.account_id, t.due_date);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'followup', objectId: id, accountId: t.account_id,
      eventType: 'followup_completed', details: { code: body.code as string, onTime: at.slice(0, 10) <= t.due_date, note: String(body.note ?? '').slice(0, 500) } });
    return { followupId: id, state: 'completed', onTime: at.slice(0, 10) <= t.due_date };
  });
}

export function commitmentsFor(db: Db, scope: Scope, accountId: string) {
  return all<Record<string, unknown>>(db, 'SELECT * FROM payer_commitments WHERE tenant_id=? AND client_id=? AND account_id=? ORDER BY captured_at', scope.tenantId, scope.clientId, accountId)
    .map((r) => ({ ...r, locator: JSON.parse(r.locator as string) }));
}

