// Pause holds (FR16). Pausing any dimension (global, tenant, client, payer,
// workflow) moves matching outbox rows that have not been dispatched into a held
// state with the reason. Resuming releases them only after the same authority
// re-check the executor performs, plus proposal expiry; a row that fails goes to
// 'blocked' and never dispatches. Dispatching, uncertain and accepted rows are
// never touched: a request the connector already received still reconciles.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { hashJson, nowIso } from '../util.ts';
import { audit } from './audit.ts';
import { approverStillAuthorized, requirePerm, type Scope } from './auth.ts';
import { activePause, type PauseDims } from './controls.ts';
import { openPayload } from './sealed-store.ts';

interface Row { tenant_id: string; client_id: string; action_id: string; connector: string; state: string; held_at?: string | null; hold_scope_key?: string | null }

const SYSTEM = 'system:controls';

export function outboxDims(db: Db, o: Pick<Row, 'tenant_id' | 'client_id' | 'action_id'>): PauseDims {
  const r = one<{ payer_id: string; scenario: string }>(db, `SELECT a.payer_id, a.scenario FROM proposed_actions p JOIN accounts a ON a.tenant_id=p.tenant_id AND a.client_id=p.client_id AND a.account_id=p.account_id
    WHERE p.tenant_id=? AND p.client_id=? AND p.action_id=?`, o.tenant_id, o.client_id, o.action_id);
  return r ? { payerId: r.payer_id, scenario: r.scenario } : {};
}

function accountOf(db: Db, o: Row): string | null {
  return one<{ account_id: string }>(db, 'SELECT account_id FROM proposed_actions WHERE tenant_id=? AND client_id=? AND action_id=?', o.tenant_id, o.client_id, o.action_id)?.account_id ?? null;
}

export function holdRow(db: Db, o: Row, pause: { scopeKey: string; reason: string }): boolean {
  return tx(db, () => {
    const changed = run(db, `UPDATE action_outbox SET held_at=?, hold_scope_key=?, hold_reason=?, updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=? AND state='pending' AND held_at IS NULL`,
      nowIso(), pause.scopeKey, pause.reason, nowIso(), o.tenant_id, o.client_id, o.action_id);
    if (changed === 1) {
      audit(db, { tenantId: o.tenant_id, clientId: o.client_id, actorId: SYSTEM, objectType: 'action', objectId: o.action_id, accountId: accountOf(db, o),
        eventType: 'dispatch_held', details: { scopeKey: pause.scopeKey, reason: pause.reason } });
    }
    return changed === 1;
  });
}

// Rows a pause key covers. Keys are built server-side (see controls.scopeKeys).
function rowsForKey(db: Db, key: string, where: string, ...wp: unknown[]): Row[] {
  const base = `SELECT o.* FROM action_outbox o JOIN proposed_actions p ON p.tenant_id=o.tenant_id AND p.client_id=o.client_id AND p.action_id=o.action_id
    JOIN accounts a ON a.tenant_id=p.tenant_id AND a.client_id=p.client_id AND a.account_id=p.account_id WHERE ${where}`;
  if (key === 'global') return all<Row>(db, base, ...wp);
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const parts = rest.split('/');
  if (kind === 'tenant') return all<Row>(db, `${base} AND o.tenant_id=?`, ...wp, parts[0]);
  if (kind === 'client') return all<Row>(db, `${base} AND o.tenant_id=? AND o.client_id=?`, ...wp, parts[0], parts[1]);
  if (kind === 'payer') return all<Row>(db, `${base} AND o.tenant_id=? AND o.client_id=? AND a.payer_id=?`, ...wp, parts[0], parts[1], parts.slice(2).join('/'));
  if (kind === 'workflow') return all<Row>(db, `${base} AND o.tenant_id=? AND o.client_id=? AND a.scenario=?`, ...wp, parts[0], parts[1], parts.slice(2).join('/'));
  return [];
}

// The same authority conditions the executor checks at dispatch, plus expiry.
export function releaseProblems(db: Db, o: Row): string[] {
  const a = one<{ account_id: string; state: string; payload: string; payload_sha256: string; expected_revision: number; kind: string; expires_at: string }>(db,
    'SELECT account_id, state, payload, payload_sha256, expected_revision, kind, expires_at FROM proposed_actions WHERE tenant_id=? AND client_id=? AND action_id=?', o.tenant_id, o.client_id, o.action_id);
  if (!a) return ['action not found'];
  const acct = one<{ revision: number }>(db, 'SELECT revision FROM accounts WHERE tenant_id=? AND client_id=? AND account_id=?', o.tenant_id, o.client_id, a.account_id)!;
  const d = one<{ actor_id: string; payload_sha256: string; account_revision: number }>(db,
    `SELECT actor_id, payload_sha256, account_revision FROM review_decisions WHERE tenant_id=? AND client_id=? AND action_id=? AND decision='approved'`, o.tenant_id, o.client_id, o.action_id);
  const problems: string[] = [];
  if (a.state !== 'approved') problems.push(`action state is ${a.state}`);
  if (!d) problems.push('no approval decision on record');
  if (d && d.payload_sha256 !== a.payload_sha256) problems.push('approval hash does not match payload');
  if (hashJson(openPayload(a.payload)) !== a.payload_sha256) problems.push('payload integrity check failed');
  if (acct.revision !== a.expected_revision || (d && d.account_revision !== acct.revision)) problems.push(`account revision changed (${a.expected_revision} -> ${acct.revision})`);
  if (d && !approverStillAuthorized(db, d.actor_id, o.tenant_id, o.client_id, a.kind)) problems.push('approver no longer holds an approving role');
  if (a.expires_at <= nowIso()) problems.push('proposal expired while held');
  return problems;
}

export function applyPauseHolds(db: Db, scopeKey: string, paused: boolean, reason: string, actorId: string): { held: number; released: number; blocked: number; stillHeld: number } {
  const rep = { held: 0, released: 0, blocked: 0, stillHeld: 0 };
  tx(db, () => {
    if (paused) {
      for (const o of rowsForKey(db, scopeKey, `o.state='pending' AND o.held_at IS NULL`)) if (holdRow(db, o, { scopeKey, reason })) rep.held++;
      return;
    }
    for (const o of rowsForKey(db, scopeKey, `o.state='pending' AND o.held_at IS NOT NULL AND o.hold_scope_key=?`, scopeKey)) {
      const accountId = accountOf(db, o);
      const other = activePause(db, o.tenant_id, o.client_id, outboxDims(db, o));
      if (other) {
        run(db, 'UPDATE action_outbox SET hold_scope_key=?, hold_reason=?, updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=?', other.scopeKey, other.reason, nowIso(), o.tenant_id, o.client_id, o.action_id);
        audit(db, { tenantId: o.tenant_id, clientId: o.client_id, actorId, objectType: 'action', objectId: o.action_id, accountId, eventType: 'dispatch_still_held', details: { scopeKey: other.scopeKey } });
        rep.stillHeld++;
        continue;
      }
      const problems = releaseProblems(db, o);
      if (problems.length) {
        run(db, `UPDATE action_outbox SET state='blocked', held_at=NULL, last_error=?, updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=?`, `Re-check on resume failed: ${problems.join('; ')}`, nowIso(), o.tenant_id, o.client_id, o.action_id);
        run(db, `UPDATE proposed_actions SET state='stale_blocked', updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=? AND state='approved'`, nowIso(), o.tenant_id, o.client_id, o.action_id);
        audit(db, { tenantId: o.tenant_id, clientId: o.client_id, actorId, objectType: 'action', objectId: o.action_id, accountId, eventType: 'dispatch_blocked', details: { problems, at: 'resume' } });
        rep.blocked++;
        continue;
      }
      run(db, 'UPDATE action_outbox SET held_at=NULL, hold_scope_key=NULL, hold_reason=NULL, updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=?', nowIso(), o.tenant_id, o.client_id, o.action_id);
      audit(db, { tenantId: o.tenant_id, clientId: o.client_id, actorId, objectType: 'action', objectId: o.action_id, accountId, eventType: 'dispatch_released', details: { scopeKey } });
      rep.released++;
    }
  });
  return rep;
}

// ---------------------------------------------------------------- read model for Operations

export function controlsView(db: Db, scope: Scope) {
  requirePerm(scope, 'operate');
  const t = scope.tenantId, c = scope.clientId;
  const pauses = all<{ scope_key: string; paused: number; reason: string; actor_id: string; updated_at: string }>(db,
    `SELECT * FROM controls WHERE scope_key IN ('global', ?, ?) OR scope_key LIKE ? OR scope_key LIKE ? ORDER BY scope_key`,
    `tenant:${t}`, `client:${t}/${c}`, `payer:${t}/${c}/%`, `workflow:${t}/${c}/%`)
    .map((r) => ({ scopeKey: r.scope_key, dimension: r.scope_key.split(':')[0], value: r.scope_key.split('/').slice(r.scope_key.startsWith('client') ? 1 : 2).join('/') || null,
      paused: !!r.paused, reason: r.reason, actorId: r.actor_id, updatedAt: r.updated_at }));
  const held = all<{ action_id: string; held_at: string; hold_scope_key: string; hold_reason: string; connector: string; kind: string; account_id: string; external_id: string; payer_id: string; scenario: string }>(db,
    `SELECT o.action_id, o.held_at, o.hold_scope_key, o.hold_reason, o.connector, p.kind, p.account_id, a.external_id, a.payer_id, a.scenario FROM action_outbox o
     JOIN proposed_actions p ON p.tenant_id=o.tenant_id AND p.client_id=o.client_id AND p.action_id=o.action_id
     JOIN accounts a ON a.tenant_id=p.tenant_id AND a.client_id=p.client_id AND a.account_id=p.account_id
     WHERE o.tenant_id=? AND o.client_id=? AND o.state='pending' AND o.held_at IS NOT NULL ORDER BY o.held_at`, t, c);
  const dims = {
    payers: all<{ payer_id: string }>(db, 'SELECT DISTINCT payer_id FROM accounts WHERE tenant_id=? AND client_id=? ORDER BY payer_id', t, c).map((r) => r.payer_id),
    workflows: all<{ scenario: string }>(db, 'SELECT DISTINCT scenario FROM accounts WHERE tenant_id=? AND client_id=? ORDER BY scenario', t, c).map((r) => r.scenario),
  };
  return { pauses, held, dimensions: dims };
}
