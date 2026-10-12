// Account workspace panels for the operations workstream: note write-back with an
// exact destination preview and hash-bound approval (FR12), payer commitments and
// follow-ups (FR13), and this account's outcome ledger (FR14).
import { useCallback, useEffect, useState } from 'react';
import { api, errorText, money, when } from '../api.ts';
import { Overlay, Panel, toast } from '../ui.tsx';

interface Writeback {
  actionId: string; state: string; displayState: string; payloadSha256: string; expectedRevision: number; payload: any;
  destination: { system: string; recordId: string; recordVersion: number; field: string; noteType: string; mode: string };
  originalDraft: string; finalText: string; edited: boolean; editReason: string | null; editedBy: string | null; diff: { added: string[]; removed: string[] } | null;
  createdBy: string; createdAt: string; approver: string | null; decisions: { decision: string; actor_id: string; rationale: string; created_at: string }[];
  outbox: { state: string; attempts: number; last_error: string | null; hold_reason: string | null } | null;
  readBack: { found: boolean; matched: boolean; problems: string[] } | null;
}
interface Followup { followupId: string; basis: string; dueDate: string; label: string; state: string; snoozedUntil: string | null; computation: { steps: string[]; warnings: string[] } }
interface Ops {
  writeback: { system: string; record: { pmRecordId: string; recordVersion: number; notes: { pmNoteId: string; text: string; writtenAt: string }[] }; field: string; fieldLabel: string; noteType: string; mode: string;
    accountRevision: number; draft: { sourceActionId: string; text: string } | null };
  writebacks: Writeback[]; followups: Followup[];
  commitments: { commitment_id: string; kind: string; value: number; unit: string; basis: string; status: string; capture_method: string; quote: string; anchor_date: string; evidence_id: string }[];
  ledger: { entryId: string; entryType: string; amountCents: number | null; deltaCents: number | null; attribution: string; attributionReason: string; recordedAt: string; lineNumber: number | null }[];
  permissions: { propose: boolean; approve: boolean; followups: boolean; capture: boolean; operate: boolean };
}

const WB_TONE: Record<string, [string, string]> = {
  awaiting_review: ['b-review', 'Awaiting write-back approval'], queued: ['b-review', 'Approved, queued'], held: ['b-review', 'Held by pause'],
  dispatching: ['b-review', 'Writing'], writeback_uncertain: ['b-danger', 'Write-back uncertain: read-back pending'], written_verified: ['b-verified', 'Written, read-back verified'],
  failed: ['b-danger', 'Failed: needs human'], blocked: ['b-danger', 'Blocked by re-check'], rejected: ['b-neutral', 'Rejected'], superseded: ['b-neutral', 'Superseded'],
  stale_blocked: ['b-danger', 'Blocked: stale'], expired: ['b-neutral', 'Expired'],
};
export function WbBadge({ s }: { s: string }) {
  const [cls, text] = WB_TONE[s] ?? ['b-neutral', s.replace(/_/g, ' ')];
  return <span className={`badge ${cls}`}>{text}</span>;
}

export const OPS_EVENT_TEXT: Record<string, string> = {
  writeback_proposed: 'Note write-back drafted', payer_commitment_captured: 'Payer commitment captured', followup_scheduled: 'Follow-up scheduled',
  followup_superseded: 'Follow-up superseded', followup_due: 'Follow-up due', followup_overdue: 'Follow-up overdue', followup_snoozed: 'Follow-up snoozed',
  followup_completed: 'Follow-up completed', outcome_reconciled: 'Outcome reconciled', account_reopened: 'Account reopened by contradictory outcome',
  account_resolved: 'Resolved: adjudication matches the requested correction', dispatch_held: 'Dispatch held by pause', dispatch_released: 'Held dispatch released after re-check',
  dispatch_still_held: 'Dispatch still held by another pause', reconcile_failed: 'Read-back did not reconcile',
};

export const ENTRY_LABEL: Record<string, string> = {
  payer_promise: 'Payer promise', request_accepted: 'Request accepted', adjudication_changed: 'Adjudication changed', adjudication_unchanged: 'Adjudication unchanged',
  reversal: 'Reversal', cash_posted: 'Cash posted', contradiction: 'Contradiction (reopened)',
};

export function AccountOps({ accountId, revision, currentAction, canReview, evidence, onChange }: {
  accountId: string; revision: number; currentAction?: { actionId: string; state: string }; canReview: boolean;
  evidence: { evidenceId: string; kind: string; title: string }[]; onChange: () => void;
}) {
  const [ops, setOps] = useState<Ops | null>(null);
  const [text, setText] = useState('');
  const [editReason, setEditReason] = useState('');
  const [busy, setBusy] = useState('');
  const [deciding, setDeciding] = useState<{ wb: Writeback; decision: 'approved' | 'rejected' } | null>(null);
  const [capturing, setCapturing] = useState(false);

  const load = useCallback(async () => {
    try { const o = await api.get<Ops>(`/api/accounts/${accountId}/operations`); setOps(o); setText((t) => t || o.writeback.draft?.text || ''); } catch (e) { toast(errorText(e), true); }
  }, [accountId]);
  useEffect(() => { load(); }, [load, revision]);
  // A reviewer looking at a proposal awaiting review is the review_opened analytics event.
  useEffect(() => {
    if (canReview && currentAction?.state === 'awaiting_review') api.post(`/api/actions/${currentAction.actionId}/review-opened`).catch(() => {});
  }, [canReview, currentAction?.actionId, currentAction?.state]);
  useEffect(() => {
    if (!ops?.writebacks.some((w) => ['queued', 'dispatching', 'writeback_uncertain'].includes(w.displayState))) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [ops, load]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); toast(label); await load(); onChange(); } catch (e) { toast(errorText(e), true); await load(); } finally { setBusy(''); }
  };
  if (!ops) return null;
  const draft = ops.writeback.draft;
  const edited = !!draft && text !== draft.text;
  const latest = ops.writebacks[0];

  return (
    <>
      <Panel title="Note write-back" id="wb-h" actions={<span className="small muted">Separate permission from financial actions</span>}>
        <div className="stack">
          <dl className="kv">
            <dt>Destination</dt><dd>{ops.writeback.system}</dd>
            <dt>PM record</dt><dd className="mono">{ops.writeback.record.pmRecordId} · version {ops.writeback.record.recordVersion}</dd>
            <dt>Field</dt><dd>{ops.writeback.fieldLabel} (<span className="mono">{ops.writeback.field}</span>, {ops.writeback.mode})</dd>
            <dt>Notes on record</dt><dd>{ops.writeback.record.notes.length}</dd>
          </dl>
          {!draft ? <p className="muted">No system-drafted note yet. Run an investigation first.</p> : ops.permissions.propose && (
            <>
              <div><label htmlFor="wbtext">Note text (system draft; edits are kept with your name and reason)</label>
                <textarea id="wbtext" value={text} onChange={(e) => setText(e.target.value)} rows={8} /></div>
              {edited && <div><label htmlFor="wbreason">Reason for the edit (required)</label><input id="wbreason" value={editReason} onChange={(e) => setEditReason(e.target.value)} style={{ width: '100%' }} /></div>}
              <div className="gap8">
                <button className="primary" disabled={!!busy || (edited && editReason.trim().length < 5)} onClick={() => run('Write-back drafted for approval', () =>
                  api.post(`/api/accounts/${accountId}/writebacks`, { sourceActionId: draft.sourceActionId, text, editReason: edited ? editReason : undefined, expectedRevision: revision }))}>Draft write-back for approval</button>
                {edited && <button disabled={!!busy} onClick={() => { setText(draft.text); setEditReason(''); }}>Restore system draft</button>}
              </div>
            </>
          )}
          {latest && <WritebackCard wb={latest} ops={ops} busy={busy} onDecide={(decision) => setDeciding({ wb: latest, decision })}
            onReadBack={() => run('Read-back reconciliation ran', () => api.post(`/api/writebacks/${latest.actionId}/readback`))}
            onSimFix={() => run('Simulated PM admin restored the approved text', () => api.post(`/api/sim-pm/correct/${latest.actionId}`))} />}
          {ops.writebacks.length > 1 && (
            <details><summary>Earlier write-backs ({ops.writebacks.length - 1})</summary>
              <table><tbody>{ops.writebacks.slice(1).map((w) => <tr key={w.actionId}><td className="small">{when(w.createdAt)} by {w.createdBy}{w.edited ? ' (edited)' : ''}</td><td><WbBadge s={w.displayState} /></td></tr>)}</tbody></table>
            </details>
          )}
        </div>
      </Panel>

      <Panel title="Follow-up" id="fu-h">
        <div className="stack">
          {ops.followups.length === 0 ? <p className="muted">No follow-up scheduled. A follow-up date needs a payer commitment captured from evidence; otherwise the client's review interval applies and is labelled as policy.</p>
            : ops.followups.filter((f) => f.state !== 'superseded').map((f) => (
              <div key={f.followupId} className={`callout ${f.state === 'overdue' ? 'danger' : f.basis === 'payer_commitment' ? 'ok' : 'info'}`}>
                <b>{f.state === 'completed' ? 'Completed' : `Due ${f.dueDate}`}</b> · {f.state}{f.snoozedUntil ? ` until ${f.snoozedUntil}` : ''}
                <div className="small">{f.label}</div>
                <details><summary>How this date was computed</summary><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{[...f.computation.steps, ...f.computation.warnings].map((s) => <li key={s}>{s}</li>)}</ul></details>
              </div>
            ))}
          {ops.commitments.length > 0 && (
            <table><thead><tr><th>Commitment</th><th>Source</th><th>Status</th></tr></thead><tbody>{ops.commitments.map((c) => (
              <tr key={c.commitment_id}><td className="small">{c.kind}: {c.value} {c.basis} {c.unit} from {c.anchor_date}<div className="muted">"{c.quote.slice(0, 120)}"</div></td>
                <td className="small">{evidence.find((e) => e.evidenceId === c.evidence_id)?.title ?? c.evidence_id}<div className="muted">{c.capture_method}</div></td>
                <td><span className={`badge b-${c.status}`}>{c.status}</span></td></tr>))}</tbody></table>
          )}
          <div className="gap8">
            {ops.permissions.capture && <button disabled={!!busy} onClick={() => setCapturing(true)}>Capture payer commitment</button>}
            {ops.permissions.followups && <button disabled={!!busy} onClick={() => run('Review-interval follow-up scheduled (no verified commitment)', () => api.post(`/api/accounts/${accountId}/followups/policy-interval`))}>Schedule review interval (no commitment)</button>}
          </div>
        </div>
      </Panel>

      {ops.ledger.length > 0 && (
        <Panel title="Outcome ledger" id="led-h">
          <table><thead><tr><th>Entry</th><th className="r">Amount</th><th>Attribution</th></tr></thead><tbody>{ops.ledger.map((e) => (
            <tr key={e.entryId}><td className="small">{ENTRY_LABEL[e.entryType] ?? e.entryType}{e.lineNumber ? ` · line ${e.lineNumber}` : ''}<div className="muted">{when(e.recordedAt)}</div></td>
              <td className="r num small">{e.amountCents === null ? '—' : money(e.amountCents)}{e.deltaCents ? <div className="muted">Δ {money(e.deltaCents)}</div> : null}</td>
              <td className="small"><span className={`badge ${e.attribution === 'attributable' ? 'b-verified' : 'b-neutral'}`}>{e.attribution.replace(/_/g, ' ')}</span><div className="muted">{e.attributionReason}</div></td></tr>))}</tbody></table>
        </Panel>
      )}

      {deciding && <DecideDialog wb={deciding.wb} decision={deciding.decision} revision={revision} onClose={() => setDeciding(null)}
        onSubmit={(rationale) => run(deciding.decision === 'approved' ? 'Write-back approved; it is reported only after read-back' : 'Write-back rejected', async () => {
          await api.post(`/api/writebacks/${deciding.wb.actionId}/review`, { decision: deciding.decision, rationale, payloadSha256: deciding.wb.payloadSha256, accountRevision: revision });
          setDeciding(null);
        })} />}
      {capturing && <CaptureDialog evidence={evidence} onClose={() => setCapturing(false)}
        onSubmit={(body) => run('Commitment captured; follow-up scheduled from it', async () => { await api.post(`/api/accounts/${accountId}/commitments`, body); setCapturing(false); })} />}
    </>
  );
}

function WritebackCard({ wb, ops, busy, onDecide, onReadBack, onSimFix }: { wb: Writeback; ops: Ops; busy: string; onDecide: (d: 'approved' | 'rejected') => void; onReadBack: () => void; onSimFix: () => void }) {
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div className="row"><WbBadge s={wb.displayState} /><span className="small muted">Drafted by {wb.createdBy} {when(wb.createdAt)}{wb.approver ? ` · approved by ${wb.approver}` : ''}</span></div>
      <dl className="kv">
        <dt>Writes to</dt><dd className="mono">{wb.destination.recordId} v{wb.destination.recordVersion} · {wb.destination.field} · {wb.destination.noteType} · {wb.destination.mode}</dd>
        <dt>Account revision</dt><dd>{wb.expectedRevision}</dd>
        <dt>Payload hash</dt><dd className="mono">{wb.payloadSha256.slice(0, 16)}…</dd>
        {wb.edited && <><dt>Edited</dt><dd>by {wb.editedBy}: {wb.editReason}</dd></>}
      </dl>
      <div className="note">{wb.finalText}</div>
      {wb.edited && wb.diff && (
        <details><summary>Original system draft and changes</summary>
          <div className="small"><b>Removed:</b> {wb.diff.removed.length ? wb.diff.removed.join(' / ') : 'none'}</div>
          <div className="small"><b>Added:</b> {wb.diff.added.length ? wb.diff.added.join(' / ') : 'none'}</div>
          <div className="note">{wb.originalDraft}</div>
        </details>
      )}
      {wb.outbox?.hold_reason && wb.displayState === 'held' && <div className="callout">Held: {wb.outbox.hold_reason}</div>}
      {wb.outbox?.last_error && <div className="callout danger small">{wb.outbox.last_error}</div>}
      {wb.readBack && !wb.readBack.matched && <div className="callout danger small">Read-back: {wb.readBack.problems.join('; ')}. The note is not reported as written.</div>}
      {wb.state === 'awaiting_review' && ops.permissions.approve && (
        <div className="gap8"><button className="primary" disabled={!!busy} onClick={() => onDecide('approved')}>Approve write-back</button><button disabled={!!busy} onClick={() => onDecide('rejected')}>Reject</button></div>
      )}
      {wb.state === 'awaiting_review' && !ops.permissions.approve && <p className="small muted">A reviewer or supervisor who did not draft this note must approve it.</p>}
      {wb.displayState === 'writeback_uncertain' && ops.permissions.operate && (
        <div className="gap8"><button disabled={!!busy} onClick={onReadBack}>Run read-back now</button><button disabled={!!busy} onClick={onSimFix}>Simulator: PM admin restores approved text</button></div>
      )}
    </div>
  );
}

function DecideDialog({ wb, decision, revision, onClose, onSubmit }: { wb: Writeback; decision: 'approved' | 'rejected'; revision: number; onClose: () => void; onSubmit: (r: string) => void }) {
  const [rationale, setRationale] = useState('');
  const stale = wb.expectedRevision !== revision;
  return (
    <Overlay kind="dialog" label="Confirm write-back decision" onClose={onClose}>
      <div className="stack">
        <h2>{decision === 'approved' ? 'Approve note write-back' : 'Reject note write-back'}</h2>
        <p className="small">Record <span className="mono">{wb.destination.recordId}</span> version {wb.destination.recordVersion}, field <span className="mono">{wb.destination.field}</span>. Approval binds to payload hash <span className="mono">{wb.payloadSha256.slice(0, 12)}</span> and account revision {wb.expectedRevision}.</p>
        {stale && <div className="callout danger">The account changed since this note was drafted. Draft it again.</div>}
        <div><label htmlFor="wbr">Rationale (required)</label><textarea id="wbr" value={rationale} onChange={(e) => setRationale(e.target.value)} /></div>
        <div className="gap8"><button className="primary" disabled={stale || rationale.trim().length < 5} onClick={() => onSubmit(rationale)}>Confirm</button><button onClick={onClose}>Cancel</button></div>
      </div>
    </Overlay>
  );
}

function CaptureDialog({ evidence, onClose, onSubmit }: { evidence: { evidenceId: string; kind: string; title: string }[]; onClose: () => void; onSubmit: (b: unknown) => void }) {
  const sources = evidence.filter((e) => ['call_transcript', 'action_receipt', 'eob', 'clearinghouse_status'].includes(e.kind));
  const [evidenceId, setEvidenceId] = useState(sources[0]?.evidenceId ?? '');
  const [locator, setLocator] = useState('');
  const [kind, setKind] = useState('reprocess');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('days');
  const [basis, setBasis] = useState('');
  const src = sources.find((s) => s.evidenceId === evidenceId);
  const isTranscript = src?.kind === 'call_transcript';
  return (
    <Overlay kind="dialog" label="Capture payer commitment" onClose={onClose}>
      <div className="stack">
        <h2>Capture payer commitment</h2>
        <p className="small muted">Record only what the payer said, with the exact source. Do not convert a generic turnaround into a promise.</p>
        <div><label htmlFor="cev">Source evidence</label><select id="cev" value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} style={{ width: '100%' }}>{sources.map((s) => <option key={s.evidenceId} value={s.evidenceId}>{s.title}</option>)}</select></div>
        <div><label htmlFor="cloc">{isTranscript ? 'Representative turn number' : 'Field path in the source (e.g. commitment)'}</label><input id="cloc" value={locator} onChange={(e) => setLocator(e.target.value)} /></div>
        <div className="gap8">
          <div><label htmlFor="ckind">Kind</label><select id="ckind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="reprocess">Reprocess</option><option value="turnaround">Turnaround</option><option value="callback">Callback</option></select></div>
          <div><label htmlFor="cval">Within</label><input id="cval" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 80 }} /></div>
          <div><label htmlFor="cunit">Unit</label><select id="cunit" value={unit} onChange={(e) => setUnit(e.target.value)}><option value="days">days</option><option value="weeks">weeks</option></select></div>
          <div><label htmlFor="cbasis">Basis stated by payer</label><select id="cbasis" value={basis} onChange={(e) => setBasis(e.target.value)}><option value="">Choose…</option><option value="business">business</option><option value="calendar">calendar</option></select></div>
        </div>
        <div className="gap8"><button className="primary" disabled={!evidenceId || !locator || !basis || !/^\d+$/.test(value)}
          onClick={() => onSubmit({ evidenceId, locator: isTranscript ? { turn: Number(locator) } : { path: locator }, kind, value: Number(value), unit, basis })}>Capture</button><button onClick={onClose}>Cancel</button></div>
      </div>
    </Overlay>
  );
}
