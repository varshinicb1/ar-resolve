import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, errorText, when } from '../api.ts';
import { Heading, Panel, toast } from '../ui.tsx';
import { go } from '../App.tsx';

interface Health { status: string; detail?: string; lastSuccess: string | null; errorRate: number | null; avgLatencyMs: number | null; p95LatencyMs: number | null; events: number; circuit: string }
interface Connector {
  id: string; displayName: string; vendor: string; kind: string; mode: string; enabled: boolean; liveCapable: boolean; capabilities: string[]; transactions: string[];
  settings: Record<string, unknown>; health: Health; notes: string[]; sources: { title: string; url: string; retrievedAt: string }[];
  onboarding: { version: number; completeness: { filled: number; total: number; missing: string[] } };
  authorization: { authorizationId: string } | null; checklist: string[] | null;
}
interface Overview {
  connectors: Connector[];
  mappings: { id: string; version: number; transactionKind: string; sha256: string; fields: number }[];
  events: { event_id: string; connector_id: string; action_class: string; outcome: string; received_time: string; latency_ms: number; error: string | null; account_id: string | null; raw_sha256: string | null }[];
  files: { fileId: string; filename: string; transactionSets: string[]; rawSha256: string; state: string; createdAt: string; summary: Record<string, number> }[];
  faults: { fault: string; remaining: number }[];
  webhookStates: { provider: string; object_ref: string; state: string; occurred_at: string; event_id: string; updated_at: string }[];
}
interface PreviewItem {
  transaction: string; setId: string; label: string; kind: string | null;
  identity: { claimReference: string | null; patientToken: string | null; serviceDate: string | null };
  match: { status: string; accountId: string | null; externalId: string | null; reason: string; checks?: { field: string; source: string | null; account: string | null; match: boolean }[] };
  extracted: { factKey: string; value: unknown }[]; notes: string[];
}
interface Preview {
  valid: boolean; rawSha256: string; filename: string;
  error?: { code: string; message: string; issues?: { code: string; message: string }[] };
  transactionSets?: string[]; items?: PreviewItem[]; summary?: Record<string, number>; fileLevel?: Record<string, unknown>[];
  alreadyIngested?: { fileId: string; createdAt: string } | null;
}

const MATCH_TONE: Record<string, string> = { matched: 'b-verified', not_applicable: 'b-neutral', unmatched: 'b-neutral', ambiguous: 'b-review', insufficient_identity: 'b-review', identity_mismatch: 'b-danger' };
const HEALTH_TONE: Record<string, string> = { healthy: 'b-verified', no_traffic: 'b-neutral', disabled: 'b-neutral', degraded: 'b-review', circuit_open: 'b-danger' };
const OUTCOME_TONE: Record<string, string> = { success: 'b-verified', not_found: 'b-neutral', refused: 'b-neutral', partially_completed: 'b-review', uncertain: 'b-review', error: 'b-danger', timeout: 'b-danger' };
const label = (s: string) => s.replace(/_/g, ' ');
const fmtValue = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

export function Integrations({ roles }: { roles: string[] }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const [samples, setSamples] = useState<{ name: string; content: string }[]>([]);
  const [filename, setFilename] = useState('upload.edi');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [hook, setHook] = useState({ claimReference: 'SYN-C1042', statusCategory: 'P1', correction: false });

  const load = useCallback(() => api.get<Overview>('/api/integrations').then((o) => { setOv(o); setErr(''); }).catch((e) => setErr(errorText(e))), []);
  useEffect(() => { load(); api.get<typeof samples>('/api/integrations/edi/samples').then(setSamples).catch(() => {}); }, [load]);

  if (!roles.includes('supervisor')) return <><Heading eyebrow="Supervisor" title="Integrations" /><div className="callout info">Integration administration requires the supervisor role in this client.</div></>;
  if (err) return <div className="callout danger">{err}</div>;
  if (!ov) return <p className="muted">Loading…</p>;

  const run = async (msg: string, fn: () => Promise<unknown>) => {
    try { const r = await fn(); toast(typeof r === 'string' ? r : msg); load(); } catch (e) { toast(errorText(e), true); }
  };
  const ch = ov.connectors.find((c) => c.id === 'sim_clearinghouse');
  const structuredFirst = ch?.settings.structuredStatusFirst === true;
  const fault = (f: string) => ov.faults.find((x) => x.fault === f)?.remaining ?? 0;

  const doPreview = async () => {
    setBusy(true); setPreview(null);
    try { setPreview(await api.post<Preview>('/api/integrations/edi/preview', { filename, content })); } catch (e) { toast(errorText(e), true); }
    setBusy(false);
  };
  const doIngest = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await api.post<{ duplicate: boolean; fileId: string; state?: string; report?: { remittance?: { lines: number; skipped: unknown[]; reopened: string[]; resolved: string[] } } }>('/api/integrations/edi/ingest', { filename, content, expectedSha256: preview.rawSha256 });
      // ADR 0060: 835 claim payments are also reconciled into the outcome ledger.
      const rm = r.report?.remittance;
      const remit = rm && (rm.lines || rm.skipped.length) ? ` Remittance: ${rm.lines} line(s) reconciled, ${rm.skipped.length} skipped, ${rm.reopened.length} reopened, ${rm.resolved.length} resolved.` : '';
      toast(r.duplicate ? `Already ingested as ${r.fileId}; nothing changed.` : `Ingested as ${r.fileId} (${r.state}). Matched items were added as evidence.${remit}`);
      setPreview(null); load();
    } catch (e) { toast(errorText(e), true); }
    setBusy(false);
  };

  return (
    <>
      <Heading eyebrow="Supervisor" title="Integrations" subtitle="Connectors, EDI intake, the simulated clearinghouse and signed webhooks for this client. Live adapters are disabled; everything here runs on synthetic data." />
      <div className="metrics">
        <div className="panel metric"><small>Connectors</small><strong>{ov.connectors.length}</strong><span className="small muted">{ov.connectors.filter((c) => c.mode === 'disabled_live').length} live adapters disabled</span></div>
        <div className="panel metric"><small>EDI files ingested</small><strong>{ov.files.length}</strong></div>
        <div className="panel metric"><small>Connector events (recent)</small><strong>{ov.events.length}</strong><span className="small muted">{ov.events.filter((e) => e.outcome === 'error' || e.outcome === 'timeout').length} failed</span></div>
        <div className="panel metric"><small>Mapping versions</small><strong>{ov.mappings.length}</strong></div>
      </div>

      <Panel title="Connectors">
        <div className="table-wrap"><table className="int-table">
          <thead><tr><th>Connector</th><th>Mode</th><th>Health</th><th>Onboarding</th><th className="r">Events</th><th /></tr></thead>
          <tbody>{ov.connectors.map((c) => (
            <Fragment key={c.id}>
              <tr>
                <td><b>{c.displayName}</b><div className="small muted">{c.vendor} · {c.transactions.join(', ') || c.capabilities.join(', ')}</div></td>
                <td><span className={`badge ${c.mode === 'disabled_live' ? 'b-neutral' : 'b-review'}`}>{label(c.mode)}</span></td>
                <td><span className={`badge ${HEALTH_TONE[c.health.status] ?? 'b-neutral'}`}>{label(c.health.status)}</span>
                  {c.health.avgLatencyMs !== null && <div className="small muted num">avg {c.health.avgLatencyMs} ms · p95 {c.health.p95LatencyMs} ms</div>}
                  {c.health.circuit !== 'closed' && <div className="small muted">circuit {c.health.circuit}</div>}</td>
                <td className="num small">{c.onboarding.completeness.filled}/{c.onboarding.completeness.total} fields{c.onboarding.version ? ` · v${c.onboarding.version}` : ''}</td>
                <td className="r num">{c.health.events}</td>
                <td className="r"><div className="gap8 int-actions">
                  <button onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>{open === c.id ? 'Hide' : 'Details'}</button>
                  <button onClick={() => run('Probe sent', async () => { const r = await api.post<{ outcome: string; error?: string }>(`/api/integrations/connectors/${c.id}/probe`); return `Probe: ${r.outcome}${r.error ? ` (${r.error})` : ''}`; })}>Probe</button>
                  {c.health.circuit === 'open' && <button onClick={() => run('Circuit reset', () => api.post(`/api/integrations/connectors/${c.id}/circuit/reset`))}>Reset circuit</button>}
                </div></td>
              </tr>
              {open === c.id && (
                <tr><td colSpan={6} className="int-detail">
                  <div className="grid2">
                    <div className="stack">
                      {c.notes.map((n) => <p key={n} className="small">{n}</p>)}
                      {c.checklist && <><h3>Before this can be enabled</h3><ul className="small int-list">{c.checklist.map((x) => <li key={x}>{x}</li>)}</ul></>}
                      {c.onboarding.completeness.missing.length > 0 && <p className="small muted">Onboarding fields missing: {c.onboarding.completeness.missing.join(', ')}</p>}
                      <p className="small muted">Authorization on record: {c.authorization ? c.authorization.authorizationId : 'none'}. Enabling live mode also requires covered-service verification, a BAA and a non-synthetic environment; the server refuses otherwise.</p>
                    </div>
                    <div className="stack">
                      <h3>Sources</h3>
                      <ul className="small int-list">{c.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> <span className="muted">retrieved {s.retrievedAt}</span></li>)}</ul>
                    </div>
                  </div>
                </td></tr>
              )}
            </Fragment>
          ))}</tbody>
        </table></div>
      </Panel>

      <div className="grid2 int-gap">
        <div>
          <Panel title="EDI intake (835 / 277 / 277CA / 271 / 999)">
            <div className="stack">
              <p className="small muted">Preview parses the envelope, maps each claim and matches it to an account by claim reference, patient token and date of service. Mismatches are reported and never ingested. Ingest is bound to the previewed file hash.</p>
              <div className="gap8">
                <label htmlFor="int-sample" className="sr">Synthetic sample</label>
                <select id="int-sample" value="" onChange={(e) => { const s = samples.find((x) => x.name === e.target.value); if (s) { setFilename(s.name); setContent(s.content); setPreview(null); } }}>
                  <option value="">Load a synthetic sample…</option>
                  {samples.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                </select>
                <label className="int-file">Choose file<input type="file" accept=".edi,.txt,.x12" className="sr" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setFilename(f.name); setContent(await f.text()); setPreview(null); } }} /></label>
              </div>
              <div><label htmlFor="int-edi">Raw X12 ({filename})</label>
                <textarea id="int-edi" className="mono int-edi" value={content} onChange={(e) => { setContent(e.target.value); setPreview(null); }} placeholder="ISA*00*…" /></div>
              <div className="gap8">
                <button onClick={doPreview} disabled={busy || !content.trim()}>Preview and match</button>
                <button className="primary" onClick={doIngest} disabled={busy || !preview?.valid || !(preview.summary?.ingestable)}>Ingest matched items</button>
              </div>
              {preview && <PreviewView p={preview} />}
            </div>
          </Panel>
          <Panel title="Ingested files">
            {ov.files.length === 0 ? <p className="muted">No files yet.</p> : (
              <div className="table-wrap"><table><thead><tr><th>File</th><th>Sets</th><th>Result</th><th>When</th></tr></thead>
                <tbody>{ov.files.map((f) => <tr key={f.fileId}><td className="small">{f.filename}<div className="mono muted">{f.rawSha256.slice(0, 16)}…</div></td><td className="small">{f.transactionSets.join(', ')}</td>
                  <td className="small">{f.summary.matched} matched · {f.summary.identity_mismatch} mismatch · {f.summary.unmatched} unmatched</td><td className="small">{when(f.createdAt)}</td></tr>)}</tbody></table></div>
            )}
          </Panel>
        </div>
        <div>
          <Panel title="Simulated clearinghouse (276/277, 270/271)">
            <div className="stack">
              <label className="int-check"><input type="checkbox" checked={structuredFirst} onChange={(e) => run(e.target.checked ? 'Structured status first: on' : 'Structured status first: off',
                () => api.post('/api/integrations/connectors/sim_clearinghouse/settings', { settings: { structuredStatusFirst: e.target.checked } }))} />
                Check structured claim status (276/277) during investigation, before any call</label>
              <p className="small muted">Off by default. When on, investigation records a 277 status as evidence and notes whether it already answers the question.</p>
              {['timeout', 'error', 'malformed', 'partial'].map((f) => (
                <div className="row" key={f}><div><b>{label(f)}</b><div className="small muted">Remaining: {fault(f)}</div></div>
                  <button onClick={() => run('Fault armed', () => api.post('/api/integrations/sim-clearinghouse/faults', { fault: f, remaining: 1 }))}>Arm once</button></div>
              ))}
            </div>
          </Panel>
          <Panel title="Signed webhook simulator">
            <div className="stack">
              <p className="small muted">Sends an HMAC-signed claim status notification through the public webhook endpoint, plus a replay of the same event. Notifications update tracked status only; they never change facts.</p>
              <div className="gap8">
                <div><label htmlFor="wh-ref">Claim reference</label><input id="wh-ref" value={hook.claimReference} onChange={(e) => setHook({ ...hook, claimReference: e.target.value })} /></div>
                <div><label htmlFor="wh-cat">Category</label><select id="wh-cat" value={hook.statusCategory} onChange={(e) => setHook({ ...hook, statusCategory: e.target.value })}>
                  {['A1', 'A2', 'P1', 'P2', 'F1', 'F2', 'F4'].map((c) => <option key={c}>{c}</option>)}</select></div>
              </div>
              <label className="int-check"><input type="checkbox" checked={hook.correction} onChange={(e) => setHook({ ...hook, correction: e.target.checked })} /> Mark as a correction (may move status backward)</label>
              <button onClick={() => run('Webhook sent', async () => {
                const r = await api.post<{ first: { status?: string; detail?: string }; replay: { duplicate?: boolean } | null }>('/api/integrations/webhooks/simulate', { ...hook, sendDuplicate: true });
                return `Webhook: ${r.first.status}${r.first.detail ? ` (${r.first.detail})` : ''}; replay ${r.replay?.duplicate ? 'deduplicated' : 'processed'}`;
              })}>Send signed event</button>
              {ov.webhookStates.length > 0 && <table><thead><tr><th>Claim</th><th>Status</th><th>Occurred</th></tr></thead>
                <tbody>{ov.webhookStates.map((s) => <tr key={s.object_ref}><td className="mono">{s.object_ref}</td><td>{s.state}</td><td className="small">{when(s.occurred_at)}</td></tr>)}</tbody></table>}
            </div>
          </Panel>
          <Panel title="Mapping versions">
            <table><tbody>{ov.mappings.map((m) => <tr key={m.id}><td className="small">{m.id}<div className="muted">{m.transactionKind}</div></td><td className="small num">v{m.version} · {m.fields} fields</td><td className="mono muted">{m.sha256.slice(0, 12)}</td></tr>)}</tbody></table>
          </Panel>
        </div>
      </div>

      <Panel title="Recent connector events">
        {ov.events.length === 0 ? <p className="muted">No connector traffic yet.</p> : (
          <div className="table-wrap"><table><thead><tr><th>When</th><th>Connector</th><th>Action</th><th>Outcome</th><th className="r">Latency</th><th>Account</th></tr></thead>
            <tbody>{ov.events.map((e) => (
              <tr key={e.event_id}><td className="small">{when(e.received_time)}</td><td className="small">{e.connector_id}</td><td className="small">{label(e.action_class)}</td>
                <td><span className={`badge ${OUTCOME_TONE[e.outcome] ?? 'b-neutral'}`}>{label(e.outcome)}</span>{e.error && <div className="small muted">{e.error}</div>}</td>
                <td className="r num small">{e.latency_ms} ms</td>
                <td>{e.account_id ? <button className="link" onClick={() => go(`/account/${e.account_id}`)}>Open</button> : <span className="muted">—</span>}</td></tr>
            ))}</tbody></table></div>
        )}
      </Panel>
    </>
  );
}

function PreviewView({ p }: { p: Preview }) {
  if (!p.valid) return (
    <div className="callout danger"><b>Rejected: {p.error?.code}</b> — {p.error?.message}
      {p.error?.issues && p.error.issues.length > 0 && <ul className="small int-list">{p.error.issues.map((i, n) => <li key={n}>{i.code}: {i.message}</li>)}</ul>}</div>
  );
  const s = p.summary ?? {};
  return (
    <div className="stack">
      <div className="callout info small">
        Valid {p.transactionSets?.join(', ')} interchange · sha256 <span className="mono">{p.rawSha256.slice(0, 16)}…</span><br />
        {s.matched} matched · {s.identity_mismatch} identity mismatch · {s.unmatched} unmatched · {s.ambiguous} ambiguous · {s.insufficient_identity} insufficient identity · {s.not_applicable} not applicable
        {p.alreadyIngested && <><br />This exact file was already ingested ({p.alreadyIngested.fileId}); ingesting again changes nothing.</>}
      </div>
      {(p.items ?? []).length > 0 && (
        <div className="table-wrap"><table className="int-table">
          <thead><tr><th>Item</th><th>Match</th><th>Facts it would add</th></tr></thead>
          <tbody>{p.items!.map((it, i) => (
            <tr key={i}>
              <td className="small"><b>{it.label}</b><div className="muted">{it.transaction}</div>
                <div className="muted mono">{it.identity.claimReference ?? '—'} · {it.identity.patientToken ?? '—'} · {it.identity.serviceDate ?? '—'}</div></td>
              <td className="small"><span className={`badge ${MATCH_TONE[it.match.status] ?? 'b-neutral'}`}>{label(it.match.status)}</span>
                {it.match.externalId && <div>{it.match.externalId}</div>}<div className="muted">{it.match.reason}</div>
                {it.notes.map((n) => <div key={n} className="muted">{n}</div>)}</td>
              <td className="small">{it.match.status !== 'matched' ? <span className="muted">Not ingested</span> : it.extracted.length === 0 ? <span className="muted">None</span> :
                <ul className="int-list">{it.extracted.map((x, k) => <li key={k}><span className="mono">{x.factKey}</span> = {fmtValue(x.value)}</li>)}</ul>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {(p.fileLevel ?? []).length > 0 && <details><summary>File-level detail (payment, balance, acknowledgments)</summary><pre className="json">{JSON.stringify(p.fileLevel, null, 2)}</pre></details>}
    </div>
  );
}
