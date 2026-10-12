// Routes for follow-ups (FR13), outcomes (FR14), note write-back (FR12),
// payer/workflow pauses (FR16) and insights. Every route resolves scope server-side.
import type { ModuleApi } from '../app.ts';
import { one, all } from '../../db/db.ts';
import { conflict, invalid, notFound } from '../../util.ts';
import { can, requirePerm } from '../../services/auth.ts';
import { emit } from '../../services/analytics.ts';
import { computeDue, isDate, resolveCalendar, visibleCalendars, createCalendarVersion } from '../../services/calendar.ts';
import { captureCommitment, commitmentsFor, completeFollowup, currentPolicy, listFollowups, schedulePolicyFollowup, setPolicy, snoozeFollowup, tickFollowups, today } from '../../services/followup.ts';
import { exportLedger, importCash, importRemittance, listLedger, remittanceView } from '../../services/outcomes.ts';
import { listWritebacks, proposeWriteback, readBackNow, reviewWriteback, writebackTarget } from '../../services/writeback.ts';
import { controlsView } from '../../services/holds.ts';
import { setPause } from '../../services/controls.ts';
import { computeKpis, economics } from '../../services/kpis.ts';
import { correctPmNote, PM_FAULTS, setPmFault, touchPmRecord, type PmFault } from '../../connectors/sim-pm.ts';
import { getAccountRow } from '../../services/workflow.ts';

export function register({ db, route, scoped }: ModuleApi): void {
  // ---------------------------------------------------------------- follow-ups
  route('GET', '/api/followups', (ctx) => listFollowups(db, scoped(ctx), { bucket: ctx.query.get('bucket') ?? undefined }));
  route('POST', '/api/followups/tick', (ctx) => { requirePerm(scoped(ctx), 'operate'); return tickFollowups(db); });
  route('POST', '/api/followups/:id/snooze', (ctx) => snoozeFollowup(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));
  route('POST', '/api/followups/:id/complete', (ctx) => completeFollowup(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));
  route('POST', '/api/accounts/:id/commitments', (ctx) => captureCommitment(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));
  route('POST', '/api/accounts/:id/followups/policy-interval', (ctx) => schedulePolicyFollowup(db, scoped(ctx), ctx.params.id));
  route('GET', '/api/followup-policy', (ctx) => { const s = scoped(ctx); requirePerm(s, 'view'); return currentPolicy(db, s.tenantId, s.clientId); });
  route('POST', '/api/followup-policy', (ctx) => setPolicy(db, scoped(ctx), ctx.body ?? {}));
  route('GET', '/api/calendars', (ctx) => { const s = scoped(ctx); requirePerm(s, 'view'); return visibleCalendars(db, s.tenantId, s.clientId); });
  route('POST', '/api/calendars', (ctx) => createCalendarVersion(db, scoped(ctx), ctx.body ?? {}));
  route('GET', '/api/calendars/compute', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'view');
    const anchor = ctx.query.get('anchor') ?? today();
    const value = Number(ctx.query.get('value'));
    const unit = ctx.query.get('unit'), basis = ctx.query.get('basis');
    if (!isDate(anchor) || !Number.isInteger(value) || value < 1 || value > 365 || (unit !== 'days' && unit !== 'weeks') || (basis !== 'business' && basis !== 'calendar')) throw invalid('anchor, value, unit and basis are required');
    const cal = resolveCalendar(db, s.tenantId, s.clientId, ctx.query.get('payerId'));
    return { calendar: { id: cal.calendarId, version: cal.version, name: cal.name, status: cal.status }, ...computeDue(anchor, value, unit, basis, cal) };
  });

  // ---------------------------------------------------------------- account operations panel
  route('GET', '/api/accounts/:id/operations', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'view');
    getAccountRow(db, s, ctx.params.id);
    return {
      writeback: writebackTarget(db, s, ctx.params.id),
      writebacks: listWritebacks(db, s, ctx.params.id),
      commitments: commitmentsFor(db, s, ctx.params.id),
      followups: listFollowups(db, s, { accountId: ctx.params.id }).items,
      ledger: listLedger(db, s, ctx.params.id).entries,
      permissions: { propose: can(s, 'propose_writeback'), approve: can(s, 'approve_writeback'), followups: can(s, 'manage_followups'), capture: can(s, 'investigate'), operate: can(s, 'operate') },
    };
  });

  // ---------------------------------------------------------------- note write-back
  route('GET', '/api/accounts/:id/writebacks', (ctx) => listWritebacks(db, scoped(ctx), ctx.params.id));
  route('POST', '/api/accounts/:id/writebacks', (ctx) => proposeWriteback(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));
  route('POST', '/api/writebacks/:id/review', (ctx) => reviewWriteback(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));
  route('POST', '/api/writebacks/:id/readback', (ctx) => readBackNow(db, scoped(ctx), ctx.params.id));
  route('POST', '/api/sim-pm/faults', (ctx) => {
    requirePerm(scoped(ctx), 'operate');
    const fault = ctx.body?.fault as PmFault;
    if (!PM_FAULTS.includes(fault)) throw invalid(`fault must be one of ${PM_FAULTS.join(', ')}`);
    setPmFault(db, fault, Math.max(0, Math.min(5, Number(ctx.body?.remaining ?? 1))));
    return all(db, 'SELECT fault, remaining FROM sim_faults');
  });
  route('POST', '/api/sim-pm/:accountId/touch', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'operate');
    getAccountRow(db, s, ctx.params.accountId);
    return { recordVersion: touchPmRecord(db, s.tenantId, s.clientId, ctx.params.accountId) };
  });
  route('POST', '/api/sim-pm/correct/:actionId', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'operate');
    const r = one<{ idempotency_key: string; payload: string }>(db, `SELECT o.idempotency_key, p.payload FROM action_outbox o JOIN proposed_actions p USING (tenant_id, client_id, action_id)
      WHERE o.tenant_id=? AND o.client_id=? AND o.action_id=? AND o.connector='sim_pm'`, s.tenantId, s.clientId, ctx.params.actionId);
    if (!r) throw notFound('Write-back dispatch');
    if (!correctPmNote(db, r.idempotency_key, JSON.parse(r.payload).note.text)) throw conflict('no_note', 'The simulated PM holds no note for this write-back');
    return { corrected: true, note: 'Simulated PM administrator restored the approved text. Run read-back to reconcile.' };
  });

  // ---------------------------------------------------------------- outcomes
  route('GET', '/api/remittance', (ctx) => remittanceView(db, scoped(ctx)));
  route('POST', '/api/remittance', (ctx) => importRemittance(db, scoped(ctx), ctx.body ?? {}));
  route('POST', '/api/cash-postings', (ctx) => importCash(db, scoped(ctx), ctx.body ?? {}));
  route('GET', '/api/remittance/sample', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'import');
    // Builds a synthetic corrected remittance for each in-scope account whose
    // clarify_allocation request was accepted, plus one unmatched line.
    const rows = all<{ claim_reference: string; payer_id: string; payload: string }>(db, `SELECT a.claim_reference, a.payer_id, p.payload FROM proposed_actions p
      JOIN action_outbox o USING (tenant_id, client_id, action_id) JOIN accounts a ON a.tenant_id=p.tenant_id AND a.client_id=p.client_id AND a.account_id=p.account_id
      WHERE p.tenant_id=? AND p.client_id=? AND p.kind='clarify_allocation' AND o.state IN ('accepted','confirmed')`, s.tenantId, s.clientId);
    const d = today();
    const lines = rows.map((r) => {
      const req = JSON.parse(r.payload).request;
      const allowed = (req.expectedDeductibleCents ?? 0) + (req.differenceCents ?? 0);
      return { claimReference: r.claim_reference, payerId: r.payer_id, lineNumber: 1, adjudicatedDate: d, status: 'corrected', allowedCents: allowed,
        paidCents: allowed - (req.expectedDeductibleCents ?? 0), adjustments: req.expectedDeductibleCents ? [{ group: 'PR', carc: '1', amountCents: req.expectedDeductibleCents }] : [] };
    });
    lines.push({ claimReference: 'SYN-C9999', payerId: 'demo-payer', lineNumber: 1, adjudicatedDate: d, status: 'original', allowedCents: 10000, paidCents: 10000, adjustments: [] });
    return { format: 'ar-resolve.synthetic-remittance.v1', sourceName: `synthetic-remittance-${d}.json`, lines, notice: 'Synthetic remittance generated from this environment. Not a real 835.' };
  });
  route('GET', '/api/outcomes/ledger', (ctx) => listLedger(db, scoped(ctx), ctx.query.get('accountId') ?? undefined));
  route('GET', '/api/outcomes/ledger/export', (ctx) => exportLedger(db, scoped(ctx)));

  // ---------------------------------------------------------------- controls
  route('GET', '/api/controls', (ctx) => controlsView(db, scoped(ctx)));
  route('POST', '/api/controls/pause', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'operate');
    const reason = String(ctx.body?.reason ?? '').trim();
    if (reason.length < 3) throw invalid('A reason is required');
    const dim = ctx.body?.dimension;
    const value = String(ctx.body?.value ?? '');
    let key: string;
    if (dim === 'client') key = `client:${s.tenantId}/${s.clientId}`;
    else if (dim === 'payer' || dim === 'workflow') {
      const col = dim === 'payer' ? 'payer_id' : 'scenario';
      if (!one(db, `SELECT 1 FROM accounts WHERE tenant_id=? AND client_id=? AND ${col}=?`, s.tenantId, s.clientId, value)) throw invalid(`Unknown ${dim} for this client`);
      key = `${dim}:${s.tenantId}/${s.clientId}/${value}`;
    } else throw invalid('dimension must be client, payer or workflow (tenant and global pauses are platform operations)');
    setPause(db, s, key, !!ctx.body?.paused, reason, s.userId);
    return controlsView(db, s);
  });

  // ---------------------------------------------------------------- analytics and insights
  route('POST', '/api/actions/:id/review-opened', (ctx) => {
    const s = scoped(ctx);
    const a = one<{ account_id: string; kind: string; state: string }>(db, 'SELECT account_id, kind, state FROM proposed_actions WHERE tenant_id=? AND client_id=? AND action_id=?', s.tenantId, s.clientId, ctx.params.id);
    if (!a) throw notFound('Action');
    requirePerm(s, a.kind === 'note_writeback' ? 'approve_writeback' : 'review');
    if (a.state !== 'awaiting_review') return { recorded: false };
    if (one(db, `SELECT 1 FROM analytics_events WHERE tenant_id=? AND client_id=? AND event_name='review_opened' AND object_id=? AND actor_id=?`, s.tenantId, s.clientId, ctx.params.id, s.userId)) return { recorded: false };
    emit(db, 'review_opened', { tenantId: s.tenantId, clientId: s.clientId, accountId: a.account_id, objectId: ctx.params.id, actorId: s.userId, properties: { kind: a.kind } });
    return { recorded: true };
  });
  route('GET', '/api/analytics/events', (ctx) => {
    const s = scoped(ctx);
    requirePerm(s, 'view');
    return all(db, 'SELECT event_id, event_name, account_id, object_id, actor_kind, actor_id, properties, occurred_at FROM analytics_events WHERE tenant_id=? AND client_id=? ORDER BY seq DESC LIMIT 200', s.tenantId, s.clientId)
      .map((r) => ({ ...(r as Record<string, unknown>), properties: JSON.parse((r as { properties: string }).properties) }));
  });
  route('GET', '/api/insights/kpis', (ctx) => computeKpis(db, scoped(ctx)));
  route('GET', '/api/insights/economics', (ctx) => economics(scoped(ctx)));
  route('POST', '/api/insights/economics', (ctx) => economics(scoped(ctx), ctx.body?.overrides ?? {}));
}
