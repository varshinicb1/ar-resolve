// Connect providers (ADR 0110): one page where an administrator enters the keys for every live
// provider, switches each between Off / Sandbox / Production, and tests it, without editing
// environment files. Secrets are never sent back by the server (only their last 4 characters), so
// password inputs are never prefilled. A value set in the environment wins and is shown locked.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText, when } from '../api.ts';
import { Heading, Panel, toast } from '../ui.tsx';

interface Var {
  name: string; label: string; note: string; secret: boolean; requiredIn: string[]; required: boolean;
  source: 'environment' | 'saved' | 'missing'; present: boolean; last4: string | null; value: string | null;
  setBy: { userId: string; name: string; at: string } | null; unreadable: boolean;
}
interface Check { name: string; outcome: string; detail: string; required: boolean }
interface Provider {
  provider: string; label: string; connectorId: string; modeVar: string; mode: 'off' | 'sandbox' | 'production'; modeSource: 'environment' | 'saved' | 'default';
  modeSetBy: { name: string; at: string } | null; productionAllowed: boolean; productionNote: string; vars: Var[];
  gate: { open: boolean; status: string[]; reasons: string[] };
  authorization: { authorizationId: string; ref: string; coveredServiceVerified: boolean; baaRef: string | null; recordedAt: string; revoked: { at: string; by: string } | null } | null;
  lastTest: { outcome: string; target: string; finishedAt: string; runBy: string; checks: { checks?: Check[]; reasons?: string[] } } | null;
  signup: { url: string; text: string };
}
interface Settings {
  environment: string; sealing: { mode: 'environment' | 'local_file' | 'missing'; message: string };
  providers: Provider[]; oidc: { note: string; settings: { name: string; label: string; required: boolean; present: boolean }[] }; testIntervalSeconds: number;
}
interface TestResult { outcome: string; target: string; lines: string[] }

const NAMES: Record<string, string> = { stedi: 'Stedi', availity: 'Availity', optum: 'Optum / Change Healthcare', twilio: 'Twilio', slack: 'Slack', postmark: 'Postmark' };
const MODES: ['off' | 'sandbox' | 'production', string][] = [['off', 'Off'], ['sandbox', 'Sandbox'], ['production', 'Production']];
const OUTCOME_TONE: Record<string, string> = { pass: 'b-verified', fail: 'b-danger', refused: 'b-neutral' };

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const person = (n: string) => n.replace(/\s*\(.*\)\s*$/, '');

function fieldState(v: Var): string {
  if (v.source === 'environment') return 'Set in environment';
  if (v.source === 'saved') {
    if (v.unreadable) return 'Saved, but it cannot be opened with the current sealing key; enter it again';
    const tail = v.secret ? (v.last4 ? `, ends in ${v.last4}` : ' (short value, ending not shown)') : '';
    return `Saved${tail}${v.setBy ? `, by ${person(v.setBy.name)} on ${day(v.setBy.at)}` : ''}`;
  }
  return v.required ? 'Not set (needed for this mode)' : 'Not set';
}

function ProviderSection({ p, onChange, interval }: { p: Provider; onChange: () => void; interval: number }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [auth, setAuth] = useState({ ref: '', reason: '', covered: false, baa: '' });
  const name = NAMES[p.provider] ?? p.provider;
  const saved = p.vars.filter((v) => v.source === 'saved');
  const dirty = Object.values(draft).some((x) => x.trim() !== '');
  const modeLocked = p.modeSource === 'environment';

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); onChange(); } catch (e) { toast(errorText(e), true); }
    setBusy(false);
  };
  const save = () => act(async () => { await api.put(`/api/integrations/connect/${p.provider}/values`, { values: draft }); setDraft({}); }, `${name}: saved`);
  const clear = (names: string[]) => {
    if (!names.length || !window.confirm(`Remove the saved ${names.length === 1 ? 'value' : `${names.length} values`} for ${name}? Values set in the environment are not affected.`)) return;
    act(() => api.put(`/api/integrations/connect/${p.provider}/values`, { clear: names }), `${name}: cleared`);
  };
  const setMode = (mode: string) => act(() => api.put(`/api/integrations/connect/${p.provider}/mode`, { mode }), `${name}: mode set to ${mode}`);
  const test = async () => {
    setBusy(true); setResult(null);
    try { setResult(await api.post<TestResult>(`/api/integrations/connect/${p.provider}/test`)); onChange(); } catch (e) { toast(errorText(e), true); }
    setBusy(false);
  };
  const recordAuth = () => {
    if (auth.ref.trim().length < 3 || auth.reason.trim().length < 10) { toast('Enter the authorization reference and a reason of at least 10 characters', true); return; }
    act(async () => {
      await api.post(`/api/integrations/connectors/${p.connectorId}/authorization`, { authorizationRef: auth.ref.trim(), coveredServiceVerified: auth.covered, baaRef: auth.baa.trim() || undefined, notes: auth.reason.trim() });
      setAuthOpen(false); setAuth({ ref: '', reason: '', covered: false, baa: '' });
    }, `${name}: authorization recorded for this client`);
  };

  const statusTone = p.gate.open ? 'b-verified' : p.mode === 'off' ? 'b-neutral' : 'b-review';
  const shown = result ?? (p.lastTest ? { outcome: p.lastTest.outcome, target: p.lastTest.target, lines: [
    ...(p.lastTest.checks.reasons ?? []).map((r) => `refused: ${r}`),
    ...(p.lastTest.checks.checks ?? []).map((c) => `[${c.outcome === 'pass' ? 'PASS' : c.outcome === 'skipped' ? 'SKIP' : 'FAIL'}]${c.required ? '' : ' (informational)'} ${c.name}: ${c.detail}`),
  ] } : null);

  return (
    <Panel id={`cp-${p.provider}`} title={<span>{name} <span className="small muted cp-sub">{p.label}</span></span>}
      actions={<a className="small" href={p.signup.url} target="_blank" rel="noreferrer">Where to get this: {p.signup.text}</a>}>
      <div className="cp-top">
        <div>
          <span className="cp-k">Mode</span>
          <div className="tabs cp-modes" role="group" aria-label={`${name} mode`}>
            {MODES.map(([m, label]) => (
              <button key={m} aria-pressed={p.mode === m} disabled={busy || modeLocked || p.mode === m || (m === 'production' && !p.productionAllowed)}
                title={m === 'production' && !p.productionAllowed ? p.productionNote : undefined} onClick={() => setMode(m)}>{label}</button>
            ))}
          </div>
          <div className="small muted">
            {modeLocked ? 'Set in environment' : p.modeSetBy ? `Set by ${person(p.modeSetBy.name)} on ${day(p.modeSetBy.at)}` : 'Off until you choose a mode'}
            {!p.productionAllowed && <> · Production disabled: {p.productionNote}</>}
            <div className="mono">{p.modeVar}</div>
          </div>
        </div>
        <div>
          <span className="cp-k">Status</span>
          <div><span className={`badge ${statusTone}`}>{p.gate.status[0]}</span></div>
          {p.gate.status.length > 1 && <ul className="small int-list cp-status">{p.gate.status.slice(1).map((s) => <li key={s}>{s}</li>)}</ul>}
        </div>
        <div>
          <span className="cp-k">Customer authorization (this client)</span>
          <div className="small">{!p.authorization ? <span className="muted">None recorded</span>
            : p.authorization.revoked ? <span>Revoked on {day(p.authorization.revoked.at)}</span>
              : <span>{p.authorization.ref} · {day(p.authorization.recordedAt)}{p.authorization.coveredServiceVerified ? ' · covered service verified' : ''}{p.authorization.baaRef ? ` · BAA ${p.authorization.baaRef}` : ''}</span>}</div>
          <button className="link small" onClick={() => setAuthOpen(!authOpen)} aria-expanded={authOpen}>{authOpen ? 'Cancel' : 'Record an authorization'}</button>
        </div>
      </div>

      {authOpen && (
        <div className="gov-form cp-auth">
          <label>Authorization reference<input value={auth.ref} onChange={(e) => setAuth({ ...auth, ref: e.target.value })} placeholder="e.g. signed order form number" /></label>
          <label>Reason (required)<input value={auth.reason} onChange={(e) => setAuth({ ...auth, reason: e.target.value })} placeholder="Why this client authorizes the connection" /></label>
          <label>BAA reference (production)<input value={auth.baa} onChange={(e) => setAuth({ ...auth, baa: e.target.value })} /></label>
          <label className="cp-check"><input type="checkbox" checked={auth.covered} onChange={(e) => setAuth({ ...auth, covered: e.target.checked })} /> Covered service verified</label>
          <div><button className="primary" disabled={busy} onClick={recordAuth}>Record authorization</button></div>
        </div>
      )}

      <div className="cp-fields">
        {p.vars.map((v) => {
          const locked = v.source === 'environment';
          const id = `cp-${p.provider}-${v.name}`;
          return (
            <div key={v.name} className="cp-field">
              <label htmlFor={id}>{v.label}{v.requiredIn.length ? <span className="muted small"> · needed for {v.requiredIn.join(' and ')}</span> : <span className="muted small"> · optional</span>}</label>
              <input id={id} type={v.secret ? 'password' : 'text'} autoComplete={v.secret ? 'new-password' : 'off'} spellCheck={false} disabled={locked || busy}
                value={draft[v.name] ?? ''} placeholder={locked ? 'Set in environment' : v.secret ? (v.source === 'saved' ? 'Enter a new value to replace it' : 'Paste the value') : (v.value ?? '')}
                onChange={(e) => setDraft({ ...draft, [v.name]: e.target.value })} />
              <div className="small cp-state">
                <span className={v.source === 'missing' && v.required ? 'cp-missing' : 'muted'}>{fieldState(v)}</span>
                {v.source === 'saved' && <button className="link small" disabled={busy} onClick={() => clear([v.name])}>Clear</button>}
              </div>
              <div className="mono muted cp-env">{v.name}</div>
            </div>
          );
        })}
      </div>

      <div className="gap8 cp-actions">
        <button className="primary" disabled={busy || !dirty} onClick={save}>Save</button>
        <button className="danger" disabled={busy || !saved.length} onClick={() => clear(saved.map((v) => v.name))}>Clear saved values</button>
        <button disabled={busy || p.mode !== 'sandbox'} title={p.mode !== 'sandbox' ? 'Switch to Sandbox first; tests never run in production' : undefined} onClick={test}>Test sandbox</button>
        <span className="small muted">One test per {interval} s. Uses the vendor's documented test data only.</span>
      </div>

      {shown && (
        <div className="cp-result">
          <div className="gap8"><span className={`badge ${OUTCOME_TONE[shown.outcome] ?? 'b-neutral'}`}>{shown.outcome}</span>
            <span className="small muted">{shown.target === 'local_mock' ? 'local mock' : shown.target === 'vendor_sandbox' ? 'vendor sandbox' : 'not run'}{!result && p.lastTest ? ` · last run ${when(p.lastTest.finishedAt)}` : ''}</span></div>
          <pre className="mono cp-lines">{shown.lines.join('\n')}</pre>
        </div>
      )}
    </Panel>
  );
}

export function ConnectProviders({ roles }: { roles: string[] }) {
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get<Settings>('/api/integrations/connect').then((r) => { setS(r); setErr(''); }).catch((e) => setErr(errorText(e))), []);
  useEffect(() => { if (roles.includes('supervisor')) load(); }, [load, roles]);

  const head = <Heading eyebrow="Integrations" title="Connect providers" subtitle={<>Enter each provider's keys, choose Off, Sandbox or Production, and test it. A value set in the environment always wins and is shown as locked. Keys are sealed before they are stored and are never shown again; only the last 4 characters are. <a href="#/integrations">Back to Integrations</a></>} />;
  if (!roles.includes('supervisor')) return <>{head}<div className="callout info">Connecting providers requires the supervisor role (integration administration).</div></>;
  if (err) return <>{head}<div className="callout danger">{err}</div></>;
  if (!s) return <>{head}<p className="muted">Loading…</p></>;

  return (
    <>
      {head}
      <div className="stack cp-page">
        <div className={`callout ${s.sealing.mode === 'missing' ? 'danger' : s.sealing.mode === 'local_file' ? '' : 'ok'}`}>{s.sealing.message}</div>
        <div className="callout info small">These keys belong to the whole deployment, not to one client. Each client still needs its own customer authorization before anything runs for it, and production also needs the live gate (covered service, BAA, PHI gate, live switch). Sandbox calls send synthetic or vendor test data only.</div>
        {s.providers.map((p) => <ProviderSection key={p.provider} p={p} onChange={load} interval={s.testIntervalSeconds} />)}
        <Panel title="Company sign-in (OIDC)">
          <p className="small muted cp-oidc-note">{s.oidc.note}</p>
          <table className="cp-oidc"><tbody>{s.oidc.settings.map((o) => (
            <tr key={o.name}><td>{o.label}<div className="mono muted">{o.name}</div></td>
              <td><span className={`badge ${o.present ? 'b-verified' : o.required ? 'b-review' : 'b-neutral'}`}>{o.present ? 'present' : o.required ? 'not set' : 'default'}</span></td></tr>
          ))}</tbody></table>
        </Panel>
      </div>
    </>
  );
}
