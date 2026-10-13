// SIMULATED practice-management (PM) system for note write-back (FR12).
// Stands in for the customer's PM/EHR, which is Blocked until a design partner
// grants access. It behaves like a careful real target: per-record versions for
// preflight, idempotency keys, and a read-back endpoint. Faults let tests rehearse
// a lost read-back and a target that silently alters (truncates) the note.
//
// The connector never reports success without reading the note back and
// comparing it with the approved text and destination field.
import { type Db, all, one, run } from '../db/db.ts';
import { newId, nowIso, sha256 } from '../util.ts';
import { ConnectorTimeout, PreflightFailed, type Connector, type SubmitResult } from './executors.ts';
import { openPayload } from '../services/sealed-store.ts';

export const PM_FIELDS = { account_notes: 'Account notes (append-only collection notes)' } as const;
export type PmFault = 'pm_readback_lag' | 'pm_alters_note' | 'pm_timeout_before_write';
export const PM_FAULTS: PmFault[] = ['pm_readback_lag', 'pm_alters_note', 'pm_timeout_before_write'];

export interface PmRecord { pmRecordId: string; externalId: string; recordVersion: number; updatedAt: string; notes: { pmNoteId: string; field: string; noteType: string; text: string; writtenAt: string; updatedAt: string }[] }

function takeFault(db: Db, fault: PmFault): boolean {
  return run(db, 'UPDATE sim_faults SET remaining = remaining - 1 WHERE fault = ? AND remaining > 0', fault) === 1;
}

export function setPmFault(db: Db, fault: PmFault, remaining: number) {
  run(db, 'INSERT INTO sim_faults VALUES (?, ?) ON CONFLICT(fault) DO UPDATE SET remaining = excluded.remaining', fault, remaining);
}

export function ensurePmRecord(db: Db, tenantId: string, clientId: string, accountId: string, externalId: string): PmRecord {
  if (!one(db, 'SELECT 1 FROM sim_pm_records WHERE tenant_id=? AND client_id=? AND account_id=?', tenantId, clientId, accountId)) {
    run(db, 'INSERT INTO sim_pm_records VALUES (?,?,?,?,?,?,?)', tenantId, clientId, accountId, `PM-SYN-${newId('r').slice(2, 10).toUpperCase()}`, externalId, 1, nowIso());
  }
  return pmRecord(db, tenantId, clientId, accountId)!;
}

export function pmRecord(db: Db, tenantId: string, clientId: string, accountId: string): PmRecord | null {
  const r = one<{ pm_record_id: string; external_id: string; record_version: number; updated_at: string }>(db,
    'SELECT pm_record_id, external_id, record_version, updated_at FROM sim_pm_records WHERE tenant_id=? AND client_id=? AND account_id=?', tenantId, clientId, accountId);
  if (!r) return null;
  const notes = all<{ pm_note_id: string; field: string; note_type: string; text: string; written_at: string; updated_at: string }>(db,
    'SELECT pm_note_id, field, note_type, text, written_at, updated_at FROM sim_pm_notes WHERE pm_record_id=? ORDER BY written_at, rowid', r.pm_record_id)
    .map((n) => ({ pmNoteId: n.pm_note_id, field: n.field, noteType: n.note_type, text: n.text, writtenAt: n.written_at, updatedAt: n.updated_at }));
  return { pmRecordId: r.pm_record_id, externalId: r.external_id, recordVersion: r.record_version, updatedAt: r.updated_at, notes };
}

// Simulates someone editing the PM record outside AR Resolve (bumps its version).
export function touchPmRecord(db: Db, tenantId: string, clientId: string, accountId: string): number {
  run(db, 'UPDATE sim_pm_records SET record_version = record_version + 1, updated_at=? WHERE tenant_id=? AND client_id=? AND account_id=?', nowIso(), tenantId, clientId, accountId);
  return pmRecord(db, tenantId, clientId, accountId)?.recordVersion ?? 0;
}

// Simulates a PM administrator correcting an altered note to the approved text.
export function correctPmNote(db: Db, idempotencyKey: string, text: string): boolean {
  return run(db, 'UPDATE sim_pm_notes SET text=?, updated_at=? WHERE idempotency_key=?', text, nowIso(), idempotencyKey) === 1;
}

interface WritebackPayload {
  destination: { recordId: string; recordVersion: number; field: string; noteType: string };
  note: { text: string; sha256: string };
}

function approvedPayload(db: Db, key: string): WritebackPayload | null {
  const r = one<{ payload: string }>(db, `SELECT p.payload FROM action_outbox o JOIN proposed_actions p USING (tenant_id, client_id, action_id) WHERE o.idempotency_key=?`, key);
  return r ? openPayload(r.payload) as WritebackPayload : null;
}

// Read-back: fetch the note the target holds for this key and compare it with the approved payload.
export function readBack(db: Db, key: string, expected: WritebackPayload): { found: boolean; matched: boolean; problems: string[]; result?: SubmitResult } {
  const n = one<{ pm_note_id: string; pm_record_id: string; field: string; note_type: string; text: string; updated_at: string }>(db,
    'SELECT pm_note_id, pm_record_id, field, note_type, text, updated_at FROM sim_pm_notes WHERE idempotency_key=?', key);
  if (!n) return { found: false, matched: false, problems: ['note not found at target'] };
  const problems: string[] = [];
  if (n.pm_record_id !== expected.destination.recordId) problems.push('note is on a different PM record');
  if (n.field !== expected.destination.field) problems.push(`field is ${n.field}, expected ${expected.destination.field}`);
  if (n.note_type !== expected.destination.noteType) problems.push('note type differs');
  const textSha = sha256(n.text);
  if (textSha !== expected.note.sha256) problems.push(`stored text differs from the approved text (${n.text.length} vs ${expected.note.text.length} characters)`);
  const result: SubmitResult = {
    externalReference: n.pm_note_id, status: 'confirmed',
    receipt: { system: 'simulated PM (synthetic)', pmRecordId: n.pm_record_id, pmNoteId: n.pm_note_id, field: n.field, readBack: { matched: problems.length === 0, textSha256: textSha, readAt: nowIso() } },
  };
  return { found: true, matched: problems.length === 0, problems, result };
}

export const simPm: Connector = {
  name: 'sim_pm',
  live: false,
  submit(db, key, _payloadSha256, raw) {
    const payload = raw as unknown as WritebackPayload;
    if (takeFault(db, 'pm_timeout_before_write')) throw new ConnectorTimeout('Simulated PM timeout before the note was written');
    const rec = one<{ pm_record_id: string; record_version: number }>(db, 'SELECT pm_record_id, record_version FROM sim_pm_records WHERE pm_record_id=?', payload.destination.recordId);
    if (!rec) throw new PreflightFailed('Preflight failed: PM record not found');
    const already = one(db, 'SELECT 1 FROM sim_pm_notes WHERE idempotency_key=?', key);
    if (!already) {
      if (rec.record_version !== payload.destination.recordVersion) {
        throw new PreflightFailed(`Preflight failed: PM record changed since the write-back was previewed (version ${payload.destination.recordVersion} -> ${rec.record_version})`);
      }
      const text = takeFault(db, 'pm_alters_note') ? payload.note.text.slice(0, 120) + ' [truncated by PM]' : payload.note.text;
      run(db, 'INSERT INTO sim_pm_notes VALUES (?,?,?,?,?,?,?,?)', newId('pmn'), rec.pm_record_id, key, payload.destination.field, payload.destination.noteType, text, nowIso(), nowIso());
      run(db, 'UPDATE sim_pm_records SET record_version = record_version + 1, updated_at=? WHERE pm_record_id=?', nowIso(), rec.pm_record_id);
    }
    if (takeFault(db, 'pm_readback_lag')) throw new ConnectorTimeout('Note sent, but the read-back did not show it yet (simulated replication lag)');
    const rb = readBack(db, key, payload);
    if (!rb.found) throw new ConnectorTimeout('Read-back did not find the note');
    if (!rb.matched) throw new ConnectorTimeout(`Read-back mismatch: ${rb.problems.join('; ')}`);
    return rb.result!;
  },
  lookup(db, key) {
    const payload = approvedPayload(db, key);
    if (!payload) throw new Error('No approved write-back payload for this key');
    const rb = readBack(db, key, payload);
    if (!rb.found) return null;
    if (!rb.matched) throw new Error(`Read-back mismatch: ${rb.problems.join('; ')}. Human reconciliation required; the note is not reported as written.`);
    return rb.result!;
  },
};
