// ADR 0070 panels on the Integrations page: PHI readiness, the vendor/BAA register and notification
// channels (outbox, simulated sink). Ported in spirit from clinic-receptionist's governance and
// integrations settings screens; data comes from server/http/routes/governance.ts.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText, when } from '../api.ts';
import { Panel, toast } from '../ui.tsx';

interface Check { id: string; label: string; ok: boolean; detail: string }
interface Layer { layer: string; id: string; label: string; vendors: string[]; carriesPhi: boolean; inUse: boolean; guarded?: boolean }
interface Baa { vendorId: string; version: number; status: string; baaRef: string | null; coveredServices: string[]; effectiveOn: string | null; expiresOn: string | null; recordedBy: string; recordedAt: string }
interface Vendor { vendorId: string; requiredBy: string[]; required: boolean; baa: Baa | null; inForce: boolean }
interface Readiness { version: string; phiMode: string; environment: string; ready: boolean; missing: string[]; checks: Check[]; layers: Layer[]; vendors: Vendor[] }
interface Channel { channelId: string; kind: string; name: string; destination: string; events: string[]; includeDetails: boolean; enabled: boolean; live: boolean; vendors: string[]; failed: number; pending: number; lastDelivered: string | null }
interface Delivery { deliveryId: string; channelId: string; eventType: string; status: string; attempts: number; nextAttemptAt: string | null; lastError: string | null; createdAt: string }
interface SinkMsg { messageId: string; channelId: string; text: string; receivedAt: string }
interface Catalog { connectors: { id: string; label: string; live: boolean; ready: boolean }[]; events: { id: string; label: string }[]; liveSends: string }

const TONE: Record<string, string> = { delivered: 'b-verified', pending: 'b-review', failed: 'b-danger', refused: 'b-neutral', signed: 'b-verified', not_signed: 'b-danger', in_negotiation: 'b-review', terminated: 'b-danger' };

export function GovernancePanels() {
  const [r, setR] = useState<Readiness | null>(null);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [sink, setSink] = useState<SinkMsg[]>([]);
  const [err, setErr] = useState('');
  const [baa, setBaa] = useState({ vendorId: '', status: 'signed', baaRef: '', effectiveOn: '', coveredServices: '', reason: '' });
  const [nc, setNc] = useState({ kind: 'sim_sink', name: '', events: 'review.needed,followup.overdue', url: '' });

  const load = useCallback(() => Promise.all([
    api.get<Readiness>('/api/governance/readiness').then(setR),
    api.get<Catalog>('/api/notifications/catalog').then(setCat),
    api.get<Channel[]>('/api/notifications/channels').then(setChannels),
    api.get<Delivery[]>('/api/notifications/deliveries').then(setDeliveries),
    api.get<SinkMsg[]>('/api/notifications/sink').then(setSink),
  ]).then(() => setErr('')).catch((e) => setErr(errorText(e))), []);
  useEffect(() => { load(); }, [load]);

  if (err) return <div className="callout danger">{err}</div>;
  if (!r || !cat) return <p className="muted">Loading governance…</p>;

  const act = async (msg: string, fn: () => Promise<unknown>) => { try { await fn(); toast(msg); load(); } catch (e) { toast(errorText(e), true); } };
  const recordBaa = () => act('BAA status recorded', () => api.post(`/api/governance/vendors/${encodeURIComponent(baa.vendorId)}/baa`, {
    status: baa.status, baaRef: baa.baaRef || null, effectiveOn: baa.effectiveOn || null, reason: baa.reason,
    coveredServices: baa.coveredServices.split(',').map((s) => s.trim()).filter(Boolean),
  }));
  const addChannel = () => act('Channel added', async () => {
    const res = await api.post<{ channelId: string; secret?: string }>('/api/notifications/channels', { kind: nc.kind, name: nc.name || undefined,
      events: nc.events.split(',').map((s) => s.trim()).filter(Boolean), config: nc.url ? { url: nc.url } : {} });
    if (res.secret) toast(`Signing secret (shown once): ${res.secret}`);
  });

  return (
    <>
      <Panel title="PHI readiness (ADR 0070)" actions={<span className={`badge ${r.ready ? 'b-verified' : 'b-danger'}`}>{r.ready ? 'Ready' : 'Not ready for patient data'}</span>}>
        <p className="small muted">Gate {r.version} · AR_PHI_MODE={r.phiMode} · environment {r.environment}. This build accepts synthetic data only; the gate refuses anything else with the reasons below.
          Recording a BAA here is a person's attestation; the software cannot verify a contract.</p>
        <ul className="gov-checks">{r.checks.map((c) => (
          <li key={c.id}><span className={`badge ${c.ok ? 'b-verified' : 'b-danger'}`}>{c.ok ? 'ok' : 'missing'}</span> <b>{c.label}</b><div className="small muted">{c.detail}</div></li>
        ))}</ul>
        <details className="int-gap"><summary>Vendors per layer</summary>
          <div className="table-wrap"><table><thead><tr><th>Layer</th><th>Component</th><th>Vendors</th><th>In use</th><th>Carries PHI</th></tr></thead>
            <tbody>{r.layers.map((l) => <tr key={`${l.layer}:${l.id}`}><td className="small">{l.layer}</td><td className="small">{l.label}{l.guarded !== undefined && <div className="muted">{l.guarded ? 'guarded' : 'unguarded'}</div>}</td>
              <td className="small mono">{l.vendors.join(', ') || '—'}</td><td className="small">{l.inUse ? 'yes' : 'no'}</td><td className="small">{l.carriesPhi ? 'yes' : 'no'}</td></tr>)}</tbody></table></div>
        </details>
      </Panel>

      <Panel title="Vendor / BAA register">
        <div className="table-wrap"><table><thead><tr><th>Vendor</th><th>Required by</th><th>Latest record</th><th>In force</th></tr></thead>
          <tbody>{r.vendors.map((v) => <tr key={v.vendorId}><td className="mono">{v.vendorId}</td><td className="small">{v.requiredBy.join(', ') || <span className="muted">not in use</span>}</td>
            <td className="small">{v.baa ? <><span className={`badge ${TONE[v.baa.status] ?? 'b-neutral'}`}>{v.baa.status.replace(/_/g, ' ')}</span> v{v.baa.version} · {v.baa.baaRef ?? 'no ref'} · {when(v.baa.recordedAt)}</> : <span className="muted">none recorded</span>}</td>
            <td>{v.inForce ? 'yes' : 'no'}</td></tr>)}</tbody></table></div>
        <div className="gov-form int-gap">
          <label>Vendor id<input value={baa.vendorId} onChange={(e) => setBaa({ ...baa, vendorId: e.target.value })} placeholder="e.g. availity" /></label>
          <label>Status<select value={baa.status} onChange={(e) => setBaa({ ...baa, status: e.target.value })}>{['signed', 'not_signed', 'in_negotiation', 'terminated'].map((s) => <option key={s}>{s}</option>)}</select></label>
          <label>Where the agreement is filed<input value={baa.baaRef} onChange={(e) => setBaa({ ...baa, baaRef: e.target.value })} /></label>
          <label>Effective on<input type="date" value={baa.effectiveOn} onChange={(e) => setBaa({ ...baa, effectiveOn: e.target.value })} /></label>
          <label>Covered services (comma separated)<input value={baa.coveredServices} onChange={(e) => setBaa({ ...baa, coveredServices: e.target.value })} /></label>
          <label>Reason<input value={baa.reason} onChange={(e) => setBaa({ ...baa, reason: e.target.value })} /></label>
        </div>
        <div className="row int-gap"><button onClick={recordBaa} disabled={!baa.vendorId || baa.reason.trim().length < 10}>Record BAA status</button></div>
      </Panel>

      <Panel title="Notifications" actions={<button onClick={() => act('Due deliveries processed', () => api.post('/api/notifications/deliver'))}>Deliver due now</button>}>
        <div className="callout info small">Real sends are {cat.liveSends}: Slack, Teams, email, SMS and webhook deliveries are refused and recorded. The simulated sink receives messages here. Messages carry internal ids and event codes, never patient tokens.</div>
        <div className="table-wrap int-gap"><table><thead><tr><th>Channel</th><th>Events</th><th>Status</th><th /></tr></thead>
          <tbody>{channels.map((c) => <tr key={c.channelId}><td className="small"><b>{c.name}</b><div className="muted">{c.kind}{c.destination ? ` · ${c.destination}` : ''}{c.live ? ' · real destination (refused here)' : ' · simulated'}</div></td>
            <td className="small">{c.events.join(', ')}</td>
            <td className="small">{c.enabled ? 'enabled' : 'disabled'} · {c.pending} pending · {c.failed} failed/refused{c.lastDelivered && <div className="muted">last {when(c.lastDelivered)}</div>}</td>
            <td className="row int-actions"><button onClick={() => act('Test sent', () => api.post(`/api/notifications/channels/${c.channelId}/test`))} disabled={!c.enabled}>Test</button>
              <button onClick={() => act(c.enabled ? 'Disabled' : 'Enabled', () => api.post(`/api/notifications/channels/${c.channelId}`, { enabled: !c.enabled }))}>{c.enabled ? 'Disable' : 'Enable'}</button></td></tr>)}
            {channels.length === 0 && <tr><td colSpan={4} className="muted small">No channels yet.</td></tr>}</tbody></table></div>
        <div className="gov-form int-gap">
          <label>Kind<select value={nc.kind} onChange={(e) => setNc({ ...nc, kind: e.target.value })}>{cat.connectors.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
          <label>Name<input value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} /></label>
          <label>Events (comma separated, or *)<input value={nc.events} onChange={(e) => setNc({ ...nc, events: e.target.value })} /></label>
          {nc.kind !== 'sim_sink' && <label>Destination URL<input value={nc.url} onChange={(e) => setNc({ ...nc, url: e.target.value })} placeholder="https://" /></label>}
        </div>
        <div className="row int-gap"><button onClick={addChannel}>Add channel</button><span className="small muted">Events: {cat.events.map((e) => e.id).join(', ')}</span></div>
        <h3 className="int-gap">Recent deliveries</h3>
        <div className="table-wrap"><table><thead><tr><th>When</th><th>Event</th><th>Status</th><th>Attempts</th><th>Last error</th></tr></thead>
          <tbody>{deliveries.slice(0, 20).map((d) => <tr key={d.deliveryId}><td className="small">{when(d.createdAt)}</td><td className="small">{d.eventType}</td>
            <td><span className={`badge ${TONE[d.status] ?? 'b-neutral'}`}>{d.status}</span></td><td className="small num">{d.attempts}</td><td className="small muted gov-wrap">{d.lastError ?? ''}</td></tr>)}</tbody></table></div>
        <h3 className="int-gap">Simulated sink</h3>
        <ul className="int-list small">{sink.slice(0, 20).map((m) => <li key={m.messageId}><span className="muted">{when(m.receivedAt)}</span> {m.text}</li>)}
          {sink.length === 0 && <li className="muted">Nothing received yet.</li>}</ul>
      </Panel>
    </>
  );
}
