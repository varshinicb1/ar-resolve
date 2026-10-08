import { useCallback, useEffect, useState } from 'react';
import { api, session, errorText } from './api.ts';
import { Toaster } from './ui.tsx';
import { Queue } from './pages/Queue.tsx';
import { Account } from './pages/Account.tsx';
import { Reviews } from './pages/Reviews.tsx';
import { Import } from './pages/Import.tsx';
import { Rules } from './pages/Rules.tsx';
import { Operations } from './pages/Operations.tsx';

export interface ScopeOption { tenantId: string; tenantName: string; clientId: string; clientName: string; roles: string[] }
export interface Me { userId: string; displayName: string; scopes: ScopeOption[]; environment: string; liveActions: string }

function useHashRoute() {
  const [hash, setHash] = useState(() => location.hash.slice(1) || '/queue');
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || '/queue');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function go(path: string) { location.hash = path; }

function Login({ onDone }: { onDone: () => void }) {
  const [users, setUsers] = useState<{ userId: string; displayName: string }[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { api.get<typeof users>('/api/dev/users').then(setUsers).catch((e) => setErr(errorText(e))); }, []);
  return (
    <main className="login">
      <div className="panel stack">
        <div className="brand" style={{ color: 'var(--ink)', padding: 0 }}>AR <span style={{ color: 'var(--verified)' }}>Resolve</span></div>
        <h1>Sign in to the synthetic environment</h1>
        <p className="muted">Development identities only. Every account, amount and transcript here is synthetic. Live payer actions are disabled. Production requires SSO with MFA.</p>
        {err && <div className="callout danger">{err}</div>}
        <div>
          {users.map((u) => (
            <button key={u.userId} onClick={async () => {
              try { const { token } = await api.post<{ token: string }>('/api/dev/login', { userId: u.userId }); session.setToken(token); onDone(); } catch (e) { setErr(errorText(e)); }
            }}>{u.displayName}</button>
          ))}
        </div>
      </div>
    </main>
  );
}

export function App() {
  const route = useHashRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [scopeKey, setScopeKey] = useState(`${session.tenantId}/${session.clientId}`);
  const [counts, setCounts] = useState<Record<string, number>>({});

  const loadMe = useCallback(async () => {
    if (!session.token) { setMe(null); setLoaded(true); return; }
    try {
      const m = await api.get<Me>('/api/me');
      const valid = m.scopes.find((s) => s.tenantId === session.tenantId && s.clientId === session.clientId) ?? m.scopes[0];
      if (valid) { session.setScope(valid.tenantId, valid.clientId); setScopeKey(`${valid.tenantId}/${valid.clientId}`); }
      setMe(m);
    } catch { session.clear(); setMe(null); }
    setLoaded(true);
  }, []);
  useEffect(() => { loadMe(); }, [loadMe]);

  const refreshCounts = useCallback(() => {
    if (!me) return;
    api.get<{ counts: Record<string, number> }>('/api/accounts?pageSize=1').then((r) => setCounts(r.counts)).catch(() => {});
  }, [me]);
  useEffect(() => { refreshCounts(); }, [refreshCounts, scopeKey, route]);

  if (!loaded) return null;
  if (!me) return <><Login onDone={loadMe} /><Toaster /></>;

  const scope = me.scopes.find((s) => `${s.tenantId}/${s.clientId}` === scopeKey);
  const roles = scope?.roles ?? [];
  const [path, param] = (() => { const p = route.split('/').filter(Boolean); return [p[0] ?? 'queue', p[1]]; })();
  const nav: [string, string, number | null][] = [
    ['queue', 'Work queue', counts.all ?? null],
    ['reviews', 'Reviews', counts.awaiting_review ?? null],
    ['import', 'Import', null],
    ['rules', 'Rule studio', null],
    ['operations', 'Operations', counts.receipt_uncertain || null],
  ];

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">AR <span>Resolve</span></div>
        <nav className="nav" aria-label="Primary">
          {nav.map(([k, label, n]) => (
            <a key={k} href={`#/${k}`} aria-current={path === k || (path === 'account' && k === 'queue') ? 'page' : undefined}>
              {label}{n !== null && <span className="count num">{n}</span>}
            </a>
          ))}
        </nav>
        <div className="side-foot">PHASE 0 · SYNTHETIC<br />No PHI · Live executor disabled<br />Draft rule DED01 v1</div>
      </aside>
      <div>
        <div className="top">
          <div className="gap8">
            <label htmlFor="scope" className="sr" style={{ margin: 0 }}>Client scope</label>
            <select id="scope" value={scopeKey} onChange={(e) => {
              const s = me.scopes.find((x) => `${x.tenantId}/${x.clientId}` === e.target.value)!;
              session.setScope(s.tenantId, s.clientId); setScopeKey(e.target.value); go('/queue');
            }}>
              {me.scopes.map((s) => <option key={`${s.tenantId}/${s.clientId}`} value={`${s.tenantId}/${s.clientId}`}>{s.tenantName} / {s.clientName}</option>)}
            </select>
          </div>
          <div className="gap8">
            <span className="badge b-review">Synthetic · Live actions disabled</span>
            <span className="small muted">{me.displayName} · {roles.join(', ')}</span>
            <button onClick={() => { session.clear(); setMe(null); }}>Sign out</button>
          </div>
        </div>
        <div className="envbar">Synthetic environment. Accounts, references and payer responses are invented. Calls are pre-scripted mocks; the payer connector is a simulator.</div>
        <main key={scopeKey}>
          {path === 'queue' && <Queue />}
          {path === 'account' && param && <Account accountId={param} onChange={refreshCounts} />}
          {path === 'reviews' && <Reviews />}
          {path === 'import' && <Import roles={roles} />}
          {path === 'rules' && <Rules />}
          {path === 'operations' && <Operations roles={roles} />}
        </main>
      </div>
      <Toaster />
    </div>
  );
}
