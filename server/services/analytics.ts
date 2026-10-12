// Product analytics events (build pack doc 03, "Product analytics events").
// Append-only. Payloads carry opaque identifiers and enumerated classifications
// only: every property is allow-listed by key and must be a short code, a number
// or a boolean. Free text (rationales, notes, transcript quotes, fact values,
// claim references, patient tokens) is never copied into an event.
import { type Db, one, run } from '../db/db.ts';
import { canonicalJson, newId, nowIso } from '../util.ts';

export const ANALYTICS_EVENTS = [
  'account_imported', 'identity_blocked', 'evidence_collected', 'evidence_conflict', 'proposal_generated', 'review_opened',
  'fact_corrected', 'proposal_approved', 'proposal_rejected', 'action_dispatched', 'action_receipt_received',
  'writeback_confirmed', 'followup_due', 'outcome_reconciled', 'account_reopened',
] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export const ANALYTICS_SCHEMA_VERSION = 1;

// Allowed property keys per event. Anything else is dropped before storage.
const ALLOWED: Record<AnalyticsEvent, string[]> = {
  account_imported: [],
  identity_blocked: ['ruleId', 'trigger'],
  evidence_collected: ['kind', 'observations'],
  evidence_conflict: ['factKey'],
  proposal_generated: ['outcome', 'ruleId', 'trigger', 'reasonCodes'],
  review_opened: ['kind'],
  fact_corrected: ['factKey', 'previousStatus'],
  proposal_approved: ['kind'],
  proposal_rejected: ['kind'],
  action_dispatched: ['connector', 'kind', 'attempt'],
  action_receipt_received: ['connector', 'kind', 'status', 'via'],
  writeback_confirmed: ['via'],
  followup_due: ['basis', 'daysLate'],
  outcome_reconciled: ['entryType', 'attribution', 'matchStatus'],
  account_reopened: ['cause'],
};

// Codes look like `clarify_allocation`, `sim_payer`, `DED01@1`, `ACCUMULATOR_MET`.
// The pattern deliberately rejects spaces, so sentences cannot pass.
const CODE = /^[A-Za-z0-9_.:@-]{1,48}$/;

export function sanitizeProperties(event: AnalyticsEvent, props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED[event]) {
    const v = props[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string' && CODE.test(v)) out[key] = v;
    else if (Array.isArray(v) && v.length <= 12 && v.every((x) => typeof x === 'string' && CODE.test(x))) out[key] = v;
  }
  return out;
}

export interface EmitInput {
  tenantId: string; clientId: string; accountId?: string | null; objectId?: string | null; actorId: string;
  properties?: Record<string, unknown>;
}

export function emit(db: Db, event: AnalyticsEvent, e: EmitInput): string {
  const eventId = newId('ae');
  const actorKind = e.actorId.startsWith('u_') ? 'user' : 'system';
  run(db, `INSERT INTO analytics_events (event_id, tenant_id, client_id, event_name, account_id, object_id, actor_kind, actor_id, properties, schema_version, occurred_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    eventId, e.tenantId, e.clientId, event, e.accountId ?? null, e.objectId ?? null, actorKind, actorKind === 'user' ? e.actorId : 'system',
    canonicalJson(sanitizeProperties(event, e.properties ?? {})), ANALYTICS_SCHEMA_VERSION, nowIso());
  return eventId;
}

// Called from audit(): maps audit event types that already exist on the core code
// paths to their analytics event, so instrumentation needs no edits per call site.
interface AuditLike { tenantId: string; clientId: string; actorId: string; objectType: string; objectId: string; accountId?: string | null; eventType: string; details?: Record<string, unknown> }

export function analyticsFromAudit(db: Db, e: AuditLike): void {
  const d = e.details ?? {};
  const base = { tenantId: e.tenantId, clientId: e.clientId, accountId: e.accountId ?? null, objectId: e.objectId, actorId: e.actorId };
  const actionInfo = () => one<{ kind: string; connector: string }>(db, 'SELECT kind, connector FROM proposed_actions WHERE tenant_id=? AND client_id=? AND action_id=?', e.tenantId, e.clientId, e.objectId);
  switch (e.eventType) {
    case 'account_imported': emit(db, 'account_imported', base); return;
    case 'identity_blocked': emit(db, 'identity_blocked', { ...base, properties: { ruleId: d.rule, trigger: d.trigger } }); return;
    case 'evidence_collected': emit(db, 'evidence_collected', { ...base, properties: d }); return;
    case 'proposal_generated': emit(db, 'proposal_generated', { ...base, properties: { outcome: d.outcome, ruleId: d.rule, trigger: d.trigger, reasonCodes: d.reasonCodes } }); return;
    case 'fact_corrected': emit(db, 'fact_corrected', { ...base, objectId: null, properties: { factKey: d.factKey, previousStatus: d.previousStatus } }); return;
    case 'proposal_approved': case 'proposal_rejected': {
      emit(db, e.eventType, { ...base, properties: { kind: actionInfo()?.kind } }); return;
    }
    case 'action_dispatched': {
      emit(db, 'action_dispatched', { ...base, properties: { connector: d.connector, kind: actionInfo()?.kind, attempt: d.attempt } }); return;
    }
    case 'action_receipt_received': {
      const a = actionInfo();
      if (a?.connector === 'sim_pm') {
        // A write-back receipt is only ever recorded after read-back matched.
        if (d.status === 'confirmed') emit(db, 'writeback_confirmed', { ...base, properties: { via: d.via } });
        return;
      }
      emit(db, 'action_receipt_received', { ...base, properties: { connector: a?.connector, kind: a?.kind, status: d.status, via: d.via } }); return;
    }
    case 'followup_due': emit(db, 'followup_due', { ...base, properties: d }); return;
    case 'outcome_reconciled': emit(db, 'outcome_reconciled', { ...base, properties: d }); return;
    case 'account_reopened': emit(db, 'account_reopened', { ...base, properties: d }); return;
    default: return;
  }
}

// Facts that newly resolve to 'conflicting' (called from facts.resolveFacts).
export function emitConflicts(db: Db, scope: { tenantId: string; clientId: string; userId: string }, accountId: string, changed: { factKey: string; status: string }[]): void {
  for (const c of changed) {
    if (c.status === 'conflicting') emit(db, 'evidence_conflict', { tenantId: scope.tenantId, clientId: scope.clientId, accountId, actorId: scope.userId, properties: { factKey: c.factKey } });
  }
}
