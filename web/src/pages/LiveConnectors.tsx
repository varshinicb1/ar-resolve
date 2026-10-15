// Live connectors panel (ADR 0100): per provider, the mode, which environment variables are present
// or missing (names only, never values), the authorization on record, why the gate is closed, and the
// last smoke result. Revoking an authorization is the only action here; keys live in the environment.
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, errorText, when } from '../api.ts';
import { Panel, toast } from '../ui.tsx';

interface EnvVar { name: string; secret: boolean; required: boolean; requiredIn: string[]; present: boolean; source: string | null; note: string }
interface Smoke { runId: string; mode: string; target: string; outcome: string; finishedAt: string; checks: { checks?: { name: string; outcome: string; detail: string; required: boolean }[]; reasons?: string[] } }
interface Provider {
  provider: string; connectorId: string; label: string; mode: string; modeVar: string; envVars: EnvVar[]; baseUrls: Record<string, string | null>;
  authorization: { authorizationId: string; ref: string; coveredServiceVerified: boolean; baaRef: string | null; recordedAt: string; revoked: { at: string; by: string } | null } | null;
  gate: { open: boolean; reasons: string[] }; lastSmoke: Smoke | null;
  health: { status: string; events: number; circuit: string } | null; recentEvents: { outcome: string; action: string; at: string; error: string | null }[];
  notes: string[]; sources: { title: string; url: string; retrievedAt: string }[];
}

const MODE_TONE: Record<string, string> = { off: 'b-neutral', sandbox: 'b-review', production: 'b-danger' };
const SMOKE_TONE: Record<string, string> = { pass: 'b-verified', fail: 'b-danger', refused: 'b-neutral' };

export function LiveConnectorsPanel() {
  const [rows, setRows] = useState<Provider[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => api.get<{ providers: Provider[] }>('/api/integrations/live').then((r) => { setRows(r.providers); setErr(''); }).catch((e) => setErr(errorText(e))), []);
  useEffect(() => { load(); }, [load]);

  const revoke = async (p: Provider) => {
    const reason = window.prompt(`Why revoke the ${p.provider} authorization for this client? (at least 10 characters)`);
    if (!reason) return;
    try { await api.post(`/api/integrations/live/connectors/${p.connectorId}/revoke`, { reason }); toast('Authorization revoked'); load(); } catch (e) { toast(errorText(e), true); }
  };

  return (
    <Panel title="Live connectors (real vendor APIs, gated)" actions={<a href="#/connect">Connect providers: enter keys, set modes, test</a>}>
      <p className="small muted">Each provider runs only when its mode is set to sandbox or production (on the Connect providers page or in the environment), its keys are present, and an authorization is recorded for this client. Production also needs the live gate above (covered service, BAA, onboarding, non-synthetic environment, PHI gate). Keys are never shown here. Smoke tests run from the command line: <span className="mono">npm run smoke:live -- &lt;provider&gt;</span>.</p>
      {err && <div className="callout danger">{err}</div>}
      {!rows ? <p className="muted">Loading…</p> : (
        <div className="table-wrap"><table className="int-table">
          <thead><tr><th>Provider</th><th>Mode</th><th>Environment variables</th><th>Authorization</th><th>Gate</th><th>Last smoke</th><th /></tr></thead>
          <tbody>{rows.map((p) => {
            const needed = p.envVars.filter((v) => v.required);
            const missing = needed.filter((v) => !v.present);
            return (
              <Fragment key={p.provider}>
                <tr>
                  <td><b>{p.provider}</b><div className="small muted">{p.label}</div></td>
                  <td><span className={`badge ${MODE_TONE[p.mode] ?? 'b-neutral'}`}>{p.mode}</span><div className="small muted mono">{p.modeVar}</div></td>
                  <td className="small">{p.mode === 'off' ? <span className="muted">not needed while off</span>
                    : missing.length ? <span>Missing: <span className="mono">{missing.map((v) => v.name).join(', ')}</span></span>
                      : <span>All {needed.length} present</span>}</td>
                  <td className="small">{!p.authorization ? <span className="muted">none for this client</span>
                    : p.authorization.revoked ? <span>revoked {when(p.authorization.revoked.at)}</span>
                      : <span>{p.authorization.ref}<div className="muted">{when(p.authorization.recordedAt)}{p.authorization.coveredServiceVerified ? ' · covered service verified' : ''}</div></span>}</td>
                  <td><span className={`badge ${p.gate.open ? 'b-verified' : 'b-neutral'}`}>{p.gate.open ? 'open' : 'closed'}</span>{!p.gate.open && <div className="small muted">{p.gate.reasons.length} reason(s)</div>}</td>
                  <td>{p.lastSmoke ? <><span className={`badge ${SMOKE_TONE[p.lastSmoke.outcome] ?? 'b-neutral'}`}>{p.lastSmoke.outcome}</span><div className="small muted">{p.lastSmoke.target.replace('_', ' ')} · {when(p.lastSmoke.finishedAt)}</div></> : <span className="small muted">never run</span>}</td>
                  <td className="r"><div className="gap8 int-actions">
                    <button onClick={() => setOpen(open === p.provider ? null : p.provider)} aria-expanded={open === p.provider}>{open === p.provider ? 'Hide' : 'Details'}</button>
                    {p.authorization && !p.authorization.revoked && <button onClick={() => revoke(p)}>Revoke</button>}
                  </div></td>
                </tr>
                {open === p.provider && (
                  <tr><td colSpan={7} className="int-detail">
                    <div className="grid2">
                      <div className="stack">
                        {!p.gate.open && <><h3>Why the gate is closed</h3><ul className="small int-list">{p.gate.reasons.map((r) => <li key={r}>{r}</li>)}</ul></>}
                        <h3>Environment variables</h3>
                        <table><tbody>{p.envVars.map((v) => (
                          <tr key={v.name}><td className="mono small">{v.name}</td><td><span className={`badge ${v.present ? 'b-verified' : v.required ? 'b-danger' : 'b-neutral'}`}>{v.present ? `present${v.source === 'file' ? ' (file)' : ''}` : 'missing'}</span></td>
                            <td className="small muted">{v.requiredIn.length ? `needed in ${v.requiredIn.join(', ')}` : 'optional'}. {v.note}</td></tr>
                        ))}</tbody></table>
                        {p.notes.map((n) => <p key={n} className="small">{n}</p>)}
                      </div>
                      <div className="stack">
                        {p.lastSmoke?.checks?.checks && <><h3>Last smoke checks</h3><ul className="small int-list">{p.lastSmoke.checks.checks.map((c) => <li key={c.name}><b>{c.outcome}</b>{c.required ? '' : ' (informational)'} {c.name}: {c.detail}</li>)}</ul></>}
                        {p.lastSmoke?.checks?.reasons?.length ? <p className="small muted">Refused: {p.lastSmoke.checks.reasons.join(' ')}</p> : null}
                        {p.recentEvents.length > 0 && <><h3>Recent calls</h3><ul className="small int-list">{p.recentEvents.map((e, i) => <li key={i}>{when(e.at)} · {e.action} · {e.outcome}{e.error ? ` (${e.error})` : ''}</li>)}</ul></>}
                        <h3>Sources</h3>
                        <ul className="small int-list">{p.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> <span className="muted">retrieved {s.retrievedAt}</span></li>)}</ul>
                      </div>
                    </div>
                  </td></tr>
                )}
              </Fragment>
            );
          })}</tbody>
        </table></div>
      )}
    </Panel>
  );
}
