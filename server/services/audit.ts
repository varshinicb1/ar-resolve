// Append-only, hash-chained audit log. Each event's hash covers the previous
// event's hash within the same tenant, so a gap or edit breaks verification.
import { type Db, all, one, run } from '../db/db.ts';
import { canonicalJson, newId, nowIso, sha256 } from '../util.ts';
import { analyticsFromAudit } from './analytics.ts';
import { notifyFromAudit } from './notifications.ts';

export interface AuditInput {
  tenantId: string;
  clientId: string;
  actorId: string;
  objectType: string;
  objectId: string;
  accountId?: string | null;
  eventType: string;
  details?: Record<string, unknown>;
}

const GENESIS = '0'.repeat(64);

export function audit(db: Db, e: AuditInput): string {
  const prev = one<{ event_hash: string }>(db, 'SELECT event_hash FROM audit_events WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1', e.tenantId);
  const eventId = newId('evt');
  const eventAt = nowIso();
  const body = {
    tenantId: e.tenantId, clientId: e.clientId, eventId, actorId: e.actorId, objectType: e.objectType,
    objectId: e.objectId, accountId: e.accountId ?? null, eventType: e.eventType, eventAt, details: e.details ?? {},
  };
  const prevHash = prev?.event_hash ?? GENESIS;
  const eventHash = sha256(prevHash + canonicalJson(body));
  run(db, `INSERT INTO audit_events (tenant_id, client_id, event_id, actor_id, object_type, object_id, account_id, event_type, event_at, details, prev_hash, event_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    e.tenantId, e.clientId, eventId, e.actorId, e.objectType, e.objectId, e.accountId ?? null, e.eventType, eventAt,
    canonicalJson(body.details), prevHash, eventHash);
  analyticsFromAudit(db, e); // product analytics (opaque ids only), same transaction
  notifyFromAudit(db, e, eventId); // notification outbox (opaque ids only), same transaction (ADR 0070)
  return eventId;
}

interface AuditRow {
  seq: number; tenant_id: string; client_id: string; event_id: string; actor_id: string; object_type: string;
  object_id: string; account_id: string | null; event_type: string; event_at: string; details: string;
  prev_hash: string; event_hash: string;
}

export function verifyChain(db: Db, tenantId: string): { ok: boolean; events: number; brokenAt?: string } {
  const rows = all<AuditRow>(db, 'SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY seq', tenantId);
  let prev = GENESIS;
  for (const r of rows) {
    const body = {
      tenantId: r.tenant_id, clientId: r.client_id, eventId: r.event_id, actorId: r.actor_id, objectType: r.object_type,
      objectId: r.object_id, accountId: r.account_id, eventType: r.event_type, eventAt: r.event_at, details: JSON.parse(r.details),
    };
    if (r.prev_hash !== prev || sha256(prev + canonicalJson(body)) !== r.event_hash) return { ok: false, events: rows.length, brokenAt: r.event_id };
    prev = r.event_hash;
  }
  return { ok: true, events: rows.length };
}

export function accountEvents(db: Db, tenantId: string, clientId: string, accountId: string) {
  return all<AuditRow>(db, 'SELECT * FROM audit_events WHERE tenant_id = ? AND client_id = ? AND account_id = ? ORDER BY seq',
    tenantId, clientId, accountId).map((r) => ({
    eventId: r.event_id, actorId: r.actor_id, objectType: r.object_type, objectId: r.object_id,
    eventType: r.event_type, eventAt: r.event_at, details: JSON.parse(r.details), eventHash: r.event_hash,
  }));
}
