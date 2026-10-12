// Halt controls (FR16). A pause stops new runs and new dispatches in scope; it
// never cancels a request the payer already accepted — those still reconcile.
import { type Db, all, run } from '../db/db.ts';
import { nowIso } from '../util.ts';
import { audit } from './audit.ts';
import type { Scope } from './auth.ts';
import { applyPauseHolds } from './holds.ts';

// Optional payer and workflow (scenario) dimensions for FR16 pauses.
export interface PauseDims { payerId?: string | null; scenario?: string | null }

export function scopeKeys(tenantId: string, clientId: string, dims: PauseDims = {}): string[] {
  const keys = ['global', `tenant:${tenantId}`, `client:${tenantId}/${clientId}`];
  if (dims.payerId) keys.push(`payer:${tenantId}/${clientId}/${dims.payerId}`);
  if (dims.scenario) keys.push(`workflow:${tenantId}/${clientId}/${dims.scenario}`);
  return keys;
}

export function activePause(db: Db, tenantId: string, clientId: string, dims: PauseDims = {}): { scopeKey: string; reason: string } | null {
  const keys = scopeKeys(tenantId, clientId, dims);
  const rows = all<{ scope_key: string; reason: string }>(db,
    `SELECT scope_key, reason FROM controls WHERE paused = 1 AND scope_key IN (${keys.map(() => '?').join(',')})`, ...keys);
  return rows.length ? { scopeKey: rows[0].scope_key, reason: rows[0].reason } : null;
}

export function setPause(db: Db, scope: Scope | null, scopeKey: string, paused: boolean, reason: string, actorId: string): void {
  run(db, `INSERT INTO controls VALUES (?,?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET paused=excluded.paused, reason=excluded.reason, actor_id=excluded.actor_id, updated_at=excluded.updated_at`,
    scopeKey, paused ? 1 : 0, reason, actorId, nowIso());
  applyPauseHolds(db, scopeKey, paused, reason, actorId); // hold pending dispatches, or release them after re-check
  if (scope) {
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId, objectType: 'control', objectId: scopeKey,
      eventType: paused ? 'automation_paused' : 'automation_resumed', details: { reason } });
  }
}

export function listControls(db: Db, tenantId: string, clientId: string) {
  const keys = scopeKeys(tenantId, clientId);
  return all<{ scope_key: string; paused: number; reason: string; actor_id: string; updated_at: string }>(db,
    `SELECT * FROM controls WHERE scope_key IN (${keys.map(() => '?').join(',')})`, ...keys)
    .map((r) => ({ scopeKey: r.scope_key, paused: !!r.paused, reason: r.reason, actorId: r.actor_id, updatedAt: r.updated_at }));
}
