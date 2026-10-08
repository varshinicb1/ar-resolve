import { useCallback, useEffect, useState } from 'react';
import { api, errorText, when } from '../api.ts';
import { Heading, Panel, StateBadge, toast } from '../ui.tsx';
import { OUTCOME_LABELS, type Ded01Outcome } from '../../../shared/rules/ded01.ts';
import { go } from '../App.tsx';

interface Ops {
  outbox: { action_id: string; idempotency_key: string; connector: string; state: string; attempts: number; external_reference: string | null; last_error: string | null; updated_at: string; kind: string; account_id: string; external_id: string }[];
  controls: { scopeKey: string; paused: boolean; reason: string; actorId: string; updatedAt: string }[];
  workItems: { work_item_id: string; account_id: string; kind: string; summary: string; state: string; created_at: string }[];
  faults: { fault: string; remaining: number }[];
  auditChain: { ok: boolean; events: number };
}

export function Operations({ roles }: { roles: string[] }) {
  const [ops, setOps] = useState<Ops | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get<Ops>('/api/ops/outbox').then((o) => { setOps(o); setErr(''); }).catch((e) => setErr(errorText(e))), []);
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);
  if (!roles.includes('supervisor')) return <><Heading eyebrow="Supervisor" title="Operations" /><div className="callout info">Operations controls require the supervisor role in this client.</div></>;
  if (err) return <div className="callout danger">{err}</div>;
  if (!ops) return <p className="muted">Loading…</p>;
  const paused = ops.controls.find((c) => c.paused);
  const fault = (f: string) => ops.faults.find((x) => x.fault === f)?.remaining ?? 0;
  const run = async (label: string, fn: () => Promise<unknown>) => { try { const r = await fn(); toast(label + (r && typeof r === 'object' && 'dispatched' in (r as object) ? `: ${JSON.stringify(r)}` : '')); load(); } catch (e) { toast(errorText(e), true); } };

  return (
    <>
      <Heading eyebrow="Supervisor" title="Operations" subtitle="Halt controls, executor outbox, simulated connector faults and audit chain health for this client." />
      <div className="metrics">
        <div className="panel metric"><small>Outbox pending / dispatching</small><strong>{ops.outbox.filter((o) => o.state === 'pending' || o.state === 'dispatching').length}</strong></div>
        <div className="panel metric"><small>Receipt uncertain</small><strong>{ops.outbox.filter((o) => o.state === 'uncertain').length}</strong></div>
        <div className="panel metric"><small>Blocked or failed</small><strong>{ops.outbox.filter((o) => o.state === 'blocked' || o.state === 'failed').length}</strong></div>
        <div className="panel metric"><small>Audit chain</small><strong>{ops.auditChain.ok ? 'Verified' : 'BROKEN'}</strong><span className="small muted">{ops.auditChain.events} events in tenant</span></div>
      </div>
      <div className="grid2">
        <div>
          <Panel title="Executor outbox" actions={<button onClick={() => run('Worker tick', () => api.post('/api/ops/worker/tick'))}>Run worker now</button>}>
            {ops.outbox.length === 0 ? <p className="muted">No approved actions yet.</p> : (
              <div className="table-wrap"><table><thead><tr><th>Account</th><th>Action</th><th>State</th><th className="r">Attempts</th><th>Reference</th><th /></tr></thead>
                <tbody>{ops.outbox.map((o) => (
                  <tr key={o.action_id}>
                    <td><button className="link" onClick={() => go(`/account/${o.account_id}`)}>{o.external_id}</button></td>
                    <td className="small ops-action">{OUTCOME_LABELS[o.kind as Ded01Outcome]}<div className="muted">{o.connector}</div></td>
                    <td><StateBadge state={o.state} />{o.last_error && <div className="small muted">{o.last_error}</div>}</td>
                    <td className="r num">{o.attempts}</td>
                    <td className="mono">{o.external_reference ?? '—'}</td>
                    <td className="r">{o.connector === 'sim_payer' && o.state === 'accepted' && <button onClick={() => run('Signed payer confirmation sent (and a duplicate replay)', () => api.post(`/api/ops/sim-confirm/${o.action_id}`, { sendDuplicate: true }))}>Simulate payer confirmation</button>}</td>
                  </tr>))}
                </tbody></table></div>
            )}
          </Panel>
          <Panel title="Internal work items">
            {ops.workItems.length === 0 ? <p className="muted">None.</p> : (
              <table><tbody>{ops.workItems.map((w) => <tr key={w.work_item_id}><td className="small">{w.summary}</td><td className="small">{when(w.created_at)}</td></tr>)}</tbody></table>
            )}
          </Panel>
        </div>
        <div>
          <Panel title="Halt automation (this client)">
            <div className="stack">
              {paused ? <div className="callout danger">Paused by {paused.actorId} {when(paused.updatedAt)}: {paused.reason}</div> : <div className="callout ok">Running. New investigations, calls and dispatches are allowed.</div>}
              <p className="small muted">Pausing stops new runs and new dispatches. A request the payer already accepted is not recalled; it continues to reconcile.</p>
              <div><label htmlFor="pr">Reason (required)</label><input id="pr" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }} /></div>
              <button className={paused ? 'primary' : 'danger'} disabled={reason.trim().length < 3} onClick={() => run(paused ? 'Resumed' : 'Paused', async () => { await api.post('/api/ops/pause', { paused: !paused, reason }); setReason(''); })}>{paused ? 'Resume automation' : 'Pause automation'}</button>
            </div>
          </Panel>
          <Panel title="Simulated connector faults">
            <div className="stack">
              <p className="small muted">Inject failures into the simulated payer to rehearse reconciliation. The next N dispatches are affected.</p>
              <div className="row"><div><b>Timeout after success</b><div className="small muted">Payer receives the request; the response is lost. Remaining: {fault('timeout_after_success')}</div></div>
                <button onClick={() => run('Fault armed', () => api.post('/api/ops/faults', { fault: 'timeout_after_success', remaining: 1 }))}>Arm once</button></div>
              <div className="row"><div><b>Timeout before send</b><div className="small muted">Request never reaches the payer. Remaining: {fault('timeout_before_send')}</div></div>
                <button onClick={() => run('Fault armed', () => api.post('/api/ops/faults', { fault: 'timeout_before_send', remaining: 1 }))}>Arm once</button></div>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
