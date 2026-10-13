// Sealed columns, tombstones and permitted one-way rewrites (ADR 0080).
//
// One registry of every column that holds sealed free text (phi.ts) is shared by three jobs:
// the PHI key re-encryption job (phi-keys.ts), the retention purge and account deletion
// (retention.ts). Rows in immutable tables are changed only through `rewrite()`, which inserts a
// permit for that exact row, column, old value and new value, performs the update and deletes the
// permit inside one transaction. The triggers in migration 080 refuse any other change.
//
// Tombstone format: "tombstone:v1:<reason>:<basis>:<sha256>:<at>"
//   reason  retention | account_deletion
//   basis   plaintext (sha256 of the removed plaintext) | stored (sha256 of the stored, still
//           sealed value, when its key was not available to open it)
// The hash lets an auditor confirm what was removed against an earlier export without keeping it.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { canonicalJson, newId, nowIso, sha256 } from '../util.ts';
import { isSealed, open, seal, sealedKeyId, type Keyring } from './phi.ts';

export interface SealedColumn {
  id: string;
  table: string;
  column: string;
  /** Primary key columns, tenant_id and client_id first (row_key order in the permit triggers). */
  key: string[];
  /** Sealed values live inside a JSON document at SEALED_PAYLOAD_PATHS (proposal payloads). */
  json?: boolean;
  /** Immutable table: a rewrite needs a permit (migration 080 triggers). */
  permit: boolean;
}

export const SEALED_COLUMNS: SealedColumn[] = [
  { id: 'evidence.content', table: 'evidence', column: 'content', key: ['tenant_id', 'client_id', 'evidence_id'], permit: true },
  { id: 'voice_call_events.text', table: 'voice_call_events', column: 'text', key: ['tenant_id', 'client_id', 'call_id', 'seq'], permit: true },
  { id: 'voice_calls.handoff', table: 'voice_calls', column: 'handoff', key: ['tenant_id', 'client_id', 'call_id'], permit: false },
  { id: 'note_writebacks.original_draft', table: 'note_writebacks', column: 'original_draft', key: ['tenant_id', 'client_id', 'action_id'], permit: true },
  { id: 'note_writebacks.final_text', table: 'note_writebacks', column: 'final_text', key: ['tenant_id', 'client_id', 'action_id'], permit: true },
  { id: 'proposed_actions.payload', table: 'proposed_actions', column: 'payload', key: ['tenant_id', 'client_id', 'action_id'], json: true, permit: true },
  { id: 'proposed_actions.note_draft', table: 'proposed_actions', column: 'note_draft', key: ['tenant_id', 'client_id', 'action_id'], permit: false },
  { id: 'notification_channels.config', table: 'notification_channels', column: 'config', key: ['tenant_id', 'client_id', 'channel_id'], permit: false },
  { id: 'notification_deliveries.payload', table: 'notification_deliveries', column: 'payload', key: ['tenant_id', 'client_id', 'delivery_id'], permit: false },
  { id: 'notification_sink.text', table: 'notification_sink', column: 'text', key: ['tenant_id', 'client_id', 'message_id'], permit: false },
  { id: 'notification_sink.body', table: 'notification_sink', column: 'body', key: ['tenant_id', 'client_id', 'message_id'], permit: false },
  { id: 'call_recordings.storage_ref', table: 'call_recordings', column: 'storage_ref', key: ['tenant_id', 'client_id', 'recording_id'], permit: false },
];

/** Free-text fields of a proposal payload that are sealed at rest (item 4, ADR 0080). */
export const SEALED_PAYLOAD_PATHS = ['request.summary', 'note.text'] as const;

// ---------------------------------------------------------------- tombstones

export const TOMBSTONE_PREFIX = 'tombstone:v1:';
export type TombstoneReason = 'retention' | 'account_deletion';

export function isTombstone(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(TOMBSTONE_PREFIX);
}

/** Tombstone for a stored value (sealed or plain). Opens it when the key is available, to hash the plaintext. */
export function tombstoneFor(stored: string, reason: TombstoneReason, at = nowIso(), ring?: Keyring): string {
  let basis = 'plaintext';
  let digest: string;
  try { digest = sha256(open(stored, ring)); } catch { basis = 'stored'; digest = sha256(stored); }
  return `${TOMBSTONE_PREFIX}${reason}:${basis}:${digest}:${at}`;
}

export function parseTombstone(v: string): { reason: string; basis: string; sha256: string; at: string } | null {
  if (!isTombstone(v)) return null;
  const [reason, basis, digest, ...rest] = v.slice(TOMBSTONE_PREFIX.length).split(':');
  return { reason, basis, sha256: digest, at: rest.join(':') };
}

/** Reads a sealed JSON column; a tombstoned value comes back as { tombstone } instead of throwing. */
export function readSealedJson(stored: string): any {
  if (isTombstone(stored)) return { tombstone: parseTombstone(stored) };
  return JSON.parse(open(stored));
}

// ---------------------------------------------------------------- proposal payloads

function getPath(o: any, path: string): unknown {
  return path.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
}
function setPath(o: any, path: string, v: unknown): void {
  const ks = path.split('.');
  const parent = ks.slice(0, -1).reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
  if (parent && typeof parent === 'object' && ks[ks.length - 1] in parent) parent[ks[ks.length - 1]] = v;
}

/**
 * Stored form of a proposal payload: canonical JSON with the free-text fields sealed. The payload
 * hash is always computed by the caller over the plaintext payload (hashJson(payload)), so approval
 * semantics are unchanged; without a key the stored form is byte-identical to canonicalJson(payload).
 */
export function sealPayload(payload: Record<string, unknown>, ring?: Keyring): string {
  const copy = JSON.parse(JSON.stringify(payload));
  for (const p of SEALED_PAYLOAD_PATHS) {
    const v = getPath(copy, p);
    if (typeof v === 'string' && !isSealed(v) && !isTombstone(v)) setPath(copy, p, seal(v, ring));
  }
  return canonicalJson(copy);
}

/** Plaintext payload. Tombstoned fields stay tombstones (the payload hash then no longer verifies). */
export function openPayload(stored: string, ring?: Keyring): any {
  const o = JSON.parse(stored);
  for (const p of SEALED_PAYLOAD_PATHS) {
    const v = getPath(o, p);
    if (isSealed(v)) setPath(o, p, open(v, ring));
  }
  return o;
}

/** Payload with its free-text fields replaced by tombstones. */
export function tombstonePayload(stored: string, reason: TombstoneReason, at = nowIso()): { payload: string; fields: { path: string; tombstone: string }[] } {
  const o = JSON.parse(stored);
  const fields: { path: string; tombstone: string }[] = [];
  for (const p of SEALED_PAYLOAD_PATHS) {
    const v = getPath(o, p);
    if (typeof v === 'string' && !isTombstone(v)) { const t = tombstoneFor(v, reason, at); setPath(o, p, t); fields.push({ path: p, tombstone: t }); }
  }
  return { payload: canonicalJson(o), fields };
}

export function payloadKeyIds(stored: string): string[] {
  try {
    const o = JSON.parse(stored);
    return SEALED_PAYLOAD_PATHS.map((p) => sealedKeyId(getPath(o, p))).filter((k): k is string => !!k);
  } catch { return []; }
}

// ---------------------------------------------------------------- rewrites

export function rowKey(col: SealedColumn, row: Record<string, unknown>): string {
  return col.key.map((k) => String(row[k])).join('|');
}

/**
 * Replace one column value of one row, guarded by the old value (optimistic). Immutable tables get a
 * permit for exactly this change. Returns false when the row changed underneath (nothing written).
 */
export function rewrite(db: Db, col: Pick<SealedColumn, 'table' | 'column' | 'key' | 'permit'>, row: Record<string, unknown>, oldValue: string | null, newValue: string,
  purpose: 'reseal' | 'tombstone'): boolean {
  return tx(db, () => {
    const where = col.key.map((k) => `${k} = ?`).join(' AND ');
    const keyVals = col.key.map((k) => row[k]);
    let permitId: string | null = null;
    if (col.permit) {
      permitId = newId('prm');
      run(db, 'INSERT INTO immutable_rewrite_permits VALUES (?,?,?,?,?,?,?,?)', permitId, col.table, col.column, col.key.map((k) => String(row[k])).join('|'), oldValue, newValue, purpose, nowIso());
    }
    try {
      return run(db, `UPDATE ${col.table} SET ${col.column} = ? WHERE ${where} AND ${col.column} IS ?`, newValue, ...keyVals, oldValue) === 1;
    } finally {
      if (permitId) run(db, 'DELETE FROM immutable_rewrite_permits WHERE permit_id = ?', permitId);
    }
  });
}

/** Number of sealed values per key id in one column (optionally within one scope). */
export function keyUsage(db: Db, col: SealedColumn, scope?: { tenantId: string; clientId: string }): Record<string, number> {
  const where = scope ? 'WHERE tenant_id = ? AND client_id = ?' : '';
  const params = scope ? [scope.tenantId, scope.clientId] : [];
  const out: Record<string, number> = {};
  const like = col.json ? `%"enc:v%` : 'enc:v%';
  for (const r of all<{ v: string }>(db, `SELECT ${col.column} v FROM ${col.table} ${where ? `${where} AND` : 'WHERE'} ${col.column} LIKE ?`, ...params, like)) {
    const ids = col.json ? payloadKeyIds(r.v) : [sealedKeyId(r.v)].filter((k): k is string => !!k);
    for (const id of ids) out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

export function sealedColumn(id: string): SealedColumn {
  const c = SEALED_COLUMNS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown sealed column ${id}`);
  return c;
}

/** Leftover permits would mean a rewrite escaped its transaction; tests assert there are none. */
export function openPermits(db: Db): number {
  return one<{ n: number }>(db, 'SELECT COUNT(*) n FROM immutable_rewrite_permits')!.n;
}
