// ADR 0080: data governance. Retention policy (placeholder periods, versioned) and purge, two-person
// account deletion, PHI key rotation status, and the call recording policy with its gate.
// Every change takes a reason and is audited server-side; this page only displays and submits.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText, when } from '../api.ts';
import { Heading, Panel, toast } from '../ui.tsx';

interface RetentionClass { id: string; label: string; action: string; days: number }
interface Retention {
  version: string; current: { version: number; sha256: string; placeholder: boolean; reason: string; createdBy: string; createdAt: string | null; definition: { basis: string } };
  classes: RetentionClass[]; runs: { runId: string; policyVersion: number; dryRun: boolean; counts: Record<string, number>; startedBy: string; finishedAt: string }[];
}
interface Deletion {
  requestId: string; accountId: string; state: string; reason: string; requestedBy: string; requestedAt: string; decidedBy: string | null; decidedAt: string | null;
  decisionReason: string | null; summary: { counts: Record<string, number>; tombstoneDigest: string; tombstones: number; kept: string[] } | null; summarySha256: string | null;
}
interface KeyStatus {
  ring: { activeId: string | null; keyIds: string[]; error: string | null }; totals: Record<string, number>;
  retired: { key_id: string; retired_by: string; retired_at: string; reason: string }[];
  jobs: { jobId: string; targetKeyId: string; state: string; batches: number; rewritten: number; lastError: string | null; startedAt: string; finishedAt: string | null }[];
  note: string;
}
interface Check { id: string; label: string; pass: boolean; detail: string }
interface Recording {
  consentModes: string[]; note: string;
  current: { version: number; sha256: string; definition: { enabled: boolean; consentMode: string; consentSource: string; disclosureLine: string; counselReview: { recorded: boolean; reference: string | null } } };
  gate: { allowed: boolean; checks: Check[] };
}

const STATE_TONE: Record<string, string> = { requested: 'b-review', executed: 'b-verified', rejected: 'b-neutral', cancelled: 'b-neutral', running: 'b-review', completed: 'b-verified', failed: 'b-danger' };
const ask = (what: string) => { const r = prompt(`${what}: reason (at least 10 characters)`); return r && r.trim().length >= 10 ? r.trim() : (r === null ? null : (toast('A reason of at least 10 characters is required', true), null)); };
const countText = (c: Record<string, number>) => Object.entries(c).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ') || 'nothing due';

function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="gov-checks">
      {checks.map((c) => (
        <li key={c.id} className={`check ${c.pass ? 'pass' : 'fail'}`}><span className="mark" aria-hidden>{c.pass ? '✓' : '✕'}</span>
          <div><strong className="small">{c.label}</strong><div className="small muted">{c.detail}</div></div></li>
      ))}
    </ul>
  );
}

function RetentionPanel({ canManage }: { canManage: boolean }) {
  const [r, setR] = useState<Retention | null>(null);
  const [days, setDays] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<Record<string, number> | null>(null);
  const load = useCallback(() => api.get<Retention>('/api/governance/retention').then((x) => { setR(x); setDays(Object.fromEntries(x.classes.map((c) => [c.id, c.days]))); }).catch((e) => toast(errorText(e), true)), []);
  useEffect(() => { load(); }, [load]);
  if (!r) return <Panel title="Retention"><p className="muted">Loading…</p></Panel>;
  const save = async () => {
    const reason = ask('Change retention periods'); if (!reason) return;
    try { await api.post('/api/governance/retention', { classes: Object.fromEntries(Object.entries(days).map(([k, d]) => [k, { days: d }])), reason }); toast('Retention policy saved as a new version'); load(); } catch (e) { toast(errorText(e), true); }
  };
  const purge = async (dryRun: boolean) => {
    try {
      const x = await api.post<{ counts: Record<string, number> }>('/api/governance/retention/purge', { dryRun });
      if (dryRun) setPreview(x.counts); else { setPreview(null); toast(`Purge done: ${countText(x.counts)}`); }
      load();
    } catch (e) { toast(errorText(e), true); }
  };
  return (
    <Panel title={`Retention · policy v${r.current.version}`} actions={canManage ? <div className="gap8"><button onClick={() => purge(true)}>Dry run</button><button onClick={() => purge(false)}>Run purge</button></div> : undefined}>
      {r.current.placeholder && <div className="callout" style={{ marginBottom: 12 }}><strong>Placeholder periods.</strong> {r.current.definition.basis}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Class</th><th>What purge does</th><th className="num">Days</th></tr></thead>
          <tbody>{r.classes.map((c) => (
            <tr key={c.id}><td>{c.label}</td><td className="small muted">{c.action}</td>
              <td className="num">{canManage ? <input aria-label={`${c.id} days`} type="number" min={1} max={3650} value={days[c.id] ?? c.days} style={{ width: 80 }} onChange={(e) => setDays({ ...days, [c.id]: Number(e.target.value) })} /> : c.days}</td></tr>
          ))}</tbody>
        </table>
      </div>
      {canManage && <div style={{ marginTop: 12 }}><button className="primary" onClick={save}>Save as new version</button></div>}
      {preview && <div className="callout info" style={{ marginTop: 12 }}>Dry run, nothing changed: {countText(preview)}</div>}
      <p className="small muted" style={{ marginTop: 12 }}>Purge replaces content with a tombstone that keeps the SHA-256 of what was removed. Rows, hashes, the audit chain and approval bindings stay intact. The worker runs it hourly.</p>
      {!!r.runs.length && (
        <details><summary className="small">Recent runs ({r.runs.length})</summary>
          <ul className="small">{r.runs.map((x) => <li key={x.runId}>{when(x.finishedAt)} · v{x.policyVersion} · {x.dryRun ? 'dry run' : 'purge'} · {x.startedBy} · {countText(x.counts)}</li>)}</ul>
        </details>
      )}
    </Panel>
  );
}

function DeletionPanel({ roles, userId }: { roles: string[]; userId: string }) {
  const [list, setList] = useState<Deletion[] | null>(null);
  const [err, setErr] = useState('');
  const [ext, setExt] = useState('');
  const canRequest = roles.includes('supervisor');
  const canDecide = roles.includes('supervisor') || roles.includes('reviewer');
  const load = useCallback(() => api.get<Deletion[]>('/api/governance/deletions').then((x) => { setList(x); setErr(''); }).catch((e) => setErr(errorText(e))), []);
  const canView = canDecide || roles.includes('auditor');
  useEffect(() => { if (canView) load(); }, [load, canView]);
  if (!canView) return <Panel title="Account deletion"><div className="callout info">Deletion requests are visible to supervisors, reviewers and auditors.</div></Panel>;
  if (err) return <Panel title="Account deletion"><div className="callout info">{err}</div></Panel>;
  const request = async () => {
    try {
      const found = await api.get<{ items: { accountId: string; externalId: string }[] }>(`/api/accounts?q=${encodeURIComponent(ext.trim())}`);
      const a = found.items.find((i) => i.externalId === ext.trim());
      if (!a) { toast(`No account ${ext} in this client`, true); return; }
      const reason = ask(`Request deletion of ${a.externalId}`); if (!reason) return;
      await api.post(`/api/accounts/${a.accountId}/deletion-request`, { reason }); toast('Deletion requested; a second person must approve'); setExt(''); load();
    } catch (e) { toast(errorText(e), true); }
  };
  const decide = async (d: Deletion, decision: 'approve' | 'reject') => {
    const reason = ask(`${decision === 'approve' ? 'Approve' : 'Reject'} deletion`); if (!reason) return;
    try { await api.post(`/api/governance/deletions/${d.requestId}/decide`, { decision, reason }); toast(decision === 'approve' ? 'Approved and executed' : 'Rejected'); load(); } catch (e) { toast(errorText(e), true); }
  };
  const cancel = async (d: Deletion) => {
    const reason = ask('Cancel deletion request'); if (!reason) return;
    try { await api.post(`/api/governance/deletions/${d.requestId}/cancel`, { reason }); load(); } catch (e) { toast(errorText(e), true); }
  };
  return (
    <Panel title="Account deletion (two-person)">
      <p className="small muted">A supervisor requests; a different supervisor or reviewer approves. Approval tombstones the account's free text and contact token. The audit log, structured facts, ledger and approval hashes are kept.</p>
      {canRequest && (
        <div className="gap8" style={{ margin: '12px 0' }}>
          <label htmlFor="del-ext" className="small">Account</label>
          <input id="del-ext" value={ext} onChange={(e) => setExt(e.target.value)} placeholder="SYN-1042" />
          <button onClick={request} disabled={!ext.trim()}>Request deletion</button>
        </div>
      )}
      {!list ? <p className="muted">Loading…</p> : !list.length ? <p className="muted">No deletion requests.</p> : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
          {list.map((d) => (
            <li key={d.requestId} className="panel">
              <div className="row"><span className="mono small">{d.accountId}</span><span className={`badge ${STATE_TONE[d.state] ?? 'b-neutral'}`}>{d.state}</span></div>
              <div className="small">Requested by {d.requestedBy} {when(d.requestedAt)}: {d.reason}</div>
              {d.decidedBy && <div className="small">Decided by {d.decidedBy} {when(d.decidedAt)}: {d.decisionReason}</div>}
              {d.summary && <div className="small muted gov-wrap" style={{ maxWidth: 'none' }}>{d.summary.tombstones} tombstones · digest <span className="mono">{d.summary.tombstoneDigest.slice(0, 16)}…</span></div>}
              {d.state === 'requested' && (
                <div className="gap8" style={{ marginTop: 8 }}>
                  {canDecide && d.requestedBy !== userId && <><button className="primary" onClick={() => decide(d, 'approve')}>Approve and delete</button><button onClick={() => decide(d, 'reject')}>Reject</button></>}
                  {canDecide && d.requestedBy === userId && <span className="small muted">Awaiting a second person.</span>}
                  {d.requestedBy === userId && <button onClick={() => cancel(d)}>Cancel</button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function KeysPanel() {
  const [k, setK] = useState<KeyStatus | null>(null);
  const load = useCallback(() => api.get<KeyStatus>('/api/governance/phi-keys').then(setK).catch((e) => toast(errorText(e), true)), []);
  useEffect(() => { load(); }, [load]);
  if (!k) return <Panel title="PHI keys"><p className="muted">Loading…</p></Panel>;
  const rekey = async () => {
    try {
      const j = await api.post<{ jobId: string }>('/api/governance/phi-keys/rekey', {});
      const r = await api.post<{ state: string; rewritten: number }>(`/api/governance/phi-keys/rekey/${j.jobId}/run`, { maxBatches: 50 });
      toast(`Re-encryption ${r.state}: ${r.rewritten} value(s) rewritten`); load();
    } catch (e) { toast(errorText(e), true); }
  };
  const retire = async (id: string) => {
    const reason = ask(`Retire key ${id}`); if (!reason) return;
    try { await api.post(`/api/governance/phi-keys/${encodeURIComponent(id)}/retire`, { reason }); toast(`Key ${id} retired`); load(); } catch (e) { toast(errorText(e), true); }
  };
  const ids = [...new Set([...k.ring.keyIds, ...Object.keys(k.totals)])].sort();
  return (
    <Panel title="PHI keys" actions={k.ring.activeId ? <button onClick={rekey}>Re-encrypt to {k.ring.activeId}</button> : undefined}>
      {k.ring.error && <div className="callout danger">{k.ring.error}</div>}
      {!k.ring.activeId && !k.ring.error && <div className="callout info">Sealing is off: no AR_PHI_KEY or AR_PHI_KEYS configured. Values are stored as plaintext synthetic data.</div>}
      <p className="small muted">{k.note}</p>
      {!!ids.length && (
        <table>
          <thead><tr><th>Key id</th><th>Status</th><th className="num">Sealed values here</th><th /></tr></thead>
          <tbody>{ids.map((id) => {
            const retired = k.retired.find((r) => r.key_id === id);
            return (
              <tr key={id}><td className="mono">{id}</td>
                <td>{id === k.ring.activeId ? <span className="badge b-verified">active</span> : retired ? <span className="badge b-neutral">retired</span> : k.ring.keyIds.includes(id) ? <span className="badge b-review">decrypt only</span> : <span className="badge b-danger">not configured</span>}</td>
                <td className="num">{k.totals[id] ?? 0}</td>
                <td>{id !== k.ring.activeId && !retired && k.ring.keyIds.includes(id) && <button onClick={() => retire(id)}>Retire</button>}</td></tr>
            );
          })}</tbody>
        </table>
      )}
      {!!k.jobs.length && (
        <details style={{ marginTop: 8 }}><summary className="small">Re-encryption jobs ({k.jobs.length})</summary>
          <ul className="small">{k.jobs.map((j) => <li key={j.jobId}>{when(j.startedAt)} → {j.targetKeyId}: <span className={`badge ${STATE_TONE[j.state] ?? 'b-neutral'}`}>{j.state}</span> {j.rewritten} rewritten in {j.batches} batch(es){j.lastError ? ` · ${j.lastError}` : ''}</li>)}</ul>
        </details>
      )}
    </Panel>
  );
}

function RecordingPanel({ canManage }: { canManage: boolean }) {
  const [r, setR] = useState<Recording | null>(null);
  const [f, setF] = useState({ enabled: false, consentMode: 'not_configured', consentSource: '', disclosureLine: '', counselRef: '' });
  const load = useCallback(() => api.get<Recording>('/api/governance/recording').then((x) => {
    setR(x); const d = x.current.definition;
    setF({ enabled: d.enabled, consentMode: d.consentMode, consentSource: d.consentSource, disclosureLine: d.disclosureLine, counselRef: d.counselReview.reference ?? '' });
  }).catch((e) => toast(errorText(e), true)), []);
  useEffect(() => { load(); }, [load]);
  if (!r) return <Panel title="Call recording"><p className="muted">Loading…</p></Panel>;
  const save = async () => {
    const reason = ask('Change the recording policy'); if (!reason) return;
    try {
      await api.post('/api/governance/recording', { enabled: f.enabled, consentMode: f.consentMode, consentSource: f.consentSource, disclosureLine: f.disclosureLine,
        counselReview: f.counselRef.trim() ? { recorded: true, reference: f.counselRef.trim() } : { recorded: false }, reason });
      toast('Recording policy saved as a new version'); load();
    } catch (e) { toast(errorText(e), true); }
  };
  return (
    <Panel title={`Call recording · policy v${r.current.version}`}>
      <div className={`callout ${r.gate.allowed ? 'ok' : 'info'}`} style={{ marginBottom: 12 }}>{r.gate.allowed ? 'Simulated calls in this client will be recorded (metadata only) after the disclosure line.' : 'Recording is off for this client.'} {r.note}</div>
      <Checks checks={r.gate.checks} />
      {canManage && (
        <>
          <div className="gov-form" style={{ marginTop: 12 }}>
            <label>Consent mode (set by the customer and counsel)
              <select value={f.consentMode} onChange={(e) => setF({ ...f, consentMode: e.target.value })}>{r.consentModes.map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}</select>
            </label>
            <label>Who configured it<input value={f.consentSource} onChange={(e) => setF({ ...f, consentSource: e.target.value })} placeholder="Counsel memo reference" /></label>
            <label>Disclosure line<input value={f.disclosureLine} onChange={(e) => setF({ ...f, disclosureLine: e.target.value })} /></label>
            <label>Counsel review reference<input value={f.counselRef} onChange={(e) => setF({ ...f, counselRef: e.target.value })} placeholder="Empty means not reviewed" /></label>
          </div>
          <div className="gap8" style={{ marginTop: 12 }}>
            <label className="gap8 small"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />Enable for this client</label>
            <button className="primary" onClick={save}>Save as new version</button>
          </div>
        </>
      )}
    </Panel>
  );
}

export function DataGovernance({ roles, userId }: { roles: string[]; userId: string }) {
  const sup = roles.includes('supervisor');
  return (
    <>
      <Heading eyebrow="Governance" title="Data governance" subtitle="Retention, deletion, encryption keys and call recording. Every change is versioned, needs a reason and is audited." />
      <div className="grid2">
        <div><RetentionPanel canManage={sup} /><DeletionPanel roles={roles} userId={userId} /></div>
        <div>{sup ? <KeysPanel /> : <Panel title="PHI keys"><div className="callout info">Key management requires the supervisor role.</div></Panel>}<RecordingPanel canManage={sup} /></div>
      </div>
    </>
  );
}
