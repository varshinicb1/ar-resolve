// Operations extension (FR16): payer and workflow pauses, held outbox rows and
// simulated PM faults. Rendered at the bottom of the Operations page.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText, when } from '../api.ts';
import { Panel, toast } from '../ui.tsx';
import { go } from '../App.tsx';

interface Controls {
  pauses: { scopeKey: string; dimension: string; value: string | null; paused: boolean; reason: string; actorId: string; updatedAt: string }[];
  held: { action_id: string; held_at: string; hold_scope_key: string; hold_reason: string; connector: string; kind: string; account_id: string; external_id: string; payer_id: string; scenario: string }[];
  dimensions: { payers: string[]; workflows: string[] };
}

export function OpsControls() {
  const [c, setC] = useState<Controls | null>(null);
  const [dimension, setDimension] = useState<'payer' | 'workflow'>('payer');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const load = useCallback(() => api.get<Controls>('/api/controls').then(setC).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
  if (!c) return null;
  const options = dimension === 'payer' ? c.dimensions.payers : c.dimensions.workflows;
  const chosen = value || options[0] || '';
  const existing = c.pauses.find((p) => p.dimension === dimension && p.scopeKey.endsWith(`/${chosen}`));
  const send = async (paused: boolean, dim: string, val: string | null, why: string) => {
    try { await api.post('/api/controls/pause', { dimension: dim, value: val, paused, reason: why }); toast(paused ? 'Paused; pending dispatches held' : 'Resumed; held dispatches re-checked'); setReason(''); load(); } catch (e) { toast(errorText(e), true); }
  };
  const arm = async (fault: string) => { try { await api.post('/api/sim-pm/faults', { fault, remaining: 1 }); toast('Simulated PM fault armed'); } catch (e) { toast(errorText(e), true); } };

  return (
    <div className="grid2" style={{ marginTop: 16 }}>
      <div>
        <Panel title="Held dispatches">
          {c.held.length === 0 ? <p className="muted">Nothing held. Pausing a dimension holds its approved, not-yet-dispatched actions with the reason.</p> : (
            <div className="table-wrap"><table><thead><tr><th>Account</th><th>Action</th><th>Held by</th></tr></thead><tbody>{c.held.map((h) => (
              <tr key={h.action_id}><td><button className="link" onClick={() => go(`/account/${h.account_id}`)}>{h.external_id}</button><div className="small muted">{h.payer_id} · {h.scenario}</div></td>
                <td className="small">{h.kind.replace(/_/g, ' ')}<div className="muted">{h.connector}</div></td>
                <td className="small"><span className="mono">{h.hold_scope_key}</span><div className="muted">{h.hold_reason} · {when(h.held_at)}</div></td></tr>))}</tbody></table></div>
          )}
          <p className="small muted" style={{ marginTop: 8 }}>On resume each held row is re-checked (approval hash, account revision, approver role, expiry, other active pauses) before it can dispatch. Rows that fail are blocked, never sent.</p>
        </Panel>
      </div>
      <div>
        <Panel title="Pause a payer or workflow (this client)">
          <div className="stack">
            {c.pauses.filter((p) => p.paused && (p.dimension === 'payer' || p.dimension === 'workflow')).map((p) => (
              <div key={p.scopeKey} className="callout danger row"><span><b>{p.dimension}: {p.scopeKey.split('/').slice(2).join('/')}</b> paused by {p.actorId} {when(p.updatedAt)}: {p.reason}</span>
                <button onClick={() => send(false, p.dimension, p.scopeKey.split('/').slice(2).join('/'), `Resume ${p.dimension}`)}>Resume</button></div>
            ))}
            {c.pauses.filter((p) => p.paused && !['payer', 'workflow'].includes(p.dimension)).map((p) => <div key={p.scopeKey} className="callout danger small">{p.scopeKey} paused: {p.reason}</div>)}
            <div className="gap8">
              <div><label htmlFor="pd">Dimension</label><select id="pd" value={dimension} onChange={(e) => { setDimension(e.target.value as 'payer' | 'workflow'); setValue(''); }}><option value="payer">Payer</option><option value="workflow">Workflow (scenario)</option></select></div>
              <div><label htmlFor="pv2">{dimension === 'payer' ? 'Payer' : 'Workflow'}</label><select id="pv2" value={chosen} onChange={(e) => setValue(e.target.value)}>{options.map((o) => <option key={o}>{o}</option>)}</select></div>
            </div>
            <div><label htmlFor="pr3">Reason (required)</label><input id="pr3" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }} /></div>
            <button className={existing?.paused ? 'primary' : 'danger'} disabled={!chosen || reason.trim().length < 3} onClick={() => send(!existing?.paused, dimension, chosen, reason)}>{existing?.paused ? `Resume ${dimension}` : `Pause ${dimension}`}</button>
            <p className="small muted">Tenant and global pauses are platform operations and are not available to client supervisors.</p>
          </div>
        </Panel>
        <Panel title="Simulated PM faults (write-back)">
          <div className="stack">
            <div className="row"><div><b>Read-back lag</b><div className="small muted">The note is written but the first read-back misses it.</div></div><button onClick={() => arm('pm_readback_lag')}>Arm once</button></div>
            <div className="row"><div><b>PM alters note</b><div className="small muted">The PM truncates the note; read-back mismatch keeps it uncertain.</div></div><button onClick={() => arm('pm_alters_note')}>Arm once</button></div>
            <div className="row"><div><b>Timeout before write</b><div className="small muted">The PM never receives the note.</div></div><button onClick={() => arm('pm_timeout_before_write')}>Arm once</button></div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
