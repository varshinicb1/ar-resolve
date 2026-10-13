// ADR 0080: named API keys (service accounts). A key acts as its own principal (svc:<keyId>) in one
// client, holds at most the roles its creator holds there, can never approve, execute or delete, and
// every request it makes is audited. The token is shown once and stored only as a hash.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText, when } from '../api.ts';
import { Heading, Panel, toast } from '../ui.tsx';

interface Key {
  keyId: string; name: string; prefix: string; roles: string[]; principal: string; createdBy: string; createdAt: string; expiresAt: string | null;
  revokedAt: string | null; revokedBy: string | null; revokeReason: string | null; lastUsedAt: string | null; useCount: number; status: string;
}
interface KeyList { version: string; keyRoles: string[]; maxDays: number; yourRoles: string[]; keys: Key[] }

const TONE: Record<string, string> = { active: 'b-verified', expired: 'b-neutral', revoked: 'b-danger' };

export function Access({ roles }: { roles: string[] }) {
  const [list, setList] = useState<KeyList | null>(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ name: '', roles: [] as string[], expiresInDays: 90, reason: '' });
  const [token, setToken] = useState<{ name: string; token: string } | null>(null);
  const load = useCallback(() => api.get<KeyList>('/api/access/keys').then((l) => { setList(l); setErr(''); }).catch((e) => setErr(errorText(e))), []);
  useEffect(() => { if (roles.includes('supervisor')) load(); }, [load, roles]);

  if (!roles.includes('supervisor')) return <><Heading eyebrow="Supervisor" title="API keys" /><div className="callout info">Managing API keys requires the supervisor role in this client.</div></>;
  if (err) return <div className="callout danger">{err}</div>;
  if (!list) return <p className="muted">Loading…</p>;

  const create = async () => {
    try {
      const r = await api.post<{ key: Key; token: string }>('/api/access/keys', form);
      setToken({ name: r.key.name, token: r.token });
      setForm({ name: '', roles: [], expiresInDays: 90, reason: '' });
      load();
    } catch (e) { toast(errorText(e), true); }
  };
  const revoke = async (k: Key) => {
    const reason = prompt(`Reason for revoking ${k.name} (at least 10 characters)`);
    if (!reason) return;
    try { await api.post(`/api/access/keys/${k.keyId}/revoke`, { reason }); toast(`Revoked ${k.name}`); load(); } catch (e) { toast(errorText(e), true); }
  };
  const toggle = (r: string) => setForm((f) => ({ ...f, roles: f.roles.includes(r) ? f.roles.filter((x) => x !== r) : [...f.roles, r] }));

  return (
    <>
      <Heading eyebrow="Access" title="API keys" subtitle="Service accounts for integrations. Each key is its own audited principal in this client only." />
      <div className="callout info" style={{ marginBottom: 16 }}>
        A key holds at most the roles you hold here, and loses any role you later lose. Keys can never approve, reject, execute, retire keys or decide deletions; those stay with named people.
        The token is shown once and stored only as a SHA-256 hash.
      </div>
      {token && (
        <div className="callout ok" role="status" style={{ marginBottom: 16 }}>
          <strong>Token for {token.name}, shown once.</strong> Copy it now; it cannot be shown again.
          <div className="note mono" style={{ marginTop: 8 }}>{token.token}</div>
          <div className="gap8" style={{ marginTop: 8 }}>
            <button onClick={() => { navigator.clipboard?.writeText(token.token).then(() => toast('Copied')).catch(() => toast('Copy failed; select the text instead', true)); }}>Copy</button>
            <button onClick={() => setToken(null)}>I have stored it</button>
          </div>
        </div>
      )}
      <Panel title="Create a key">
        <div className="gov-form">
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="clearinghouse-sync" /></label>
          <label>Expires in days (1-{list.maxDays})<input type="number" min={1} max={list.maxDays} value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: Number(e.target.value) })} /></label>
          <label>Reason (required)<input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="What the key is for" /></label>
        </div>
        <fieldset className="gap8" style={{ border: 0, padding: 0, margin: '12px 0' }}>
          <legend className="small muted">Roles (only roles you hold here)</legend>
          {list.keyRoles.map((r) => (
            <label key={r} className="gap8 small" style={{ opacity: list.yourRoles.includes(r) ? 1 : 0.5 }}>
              <input type="checkbox" checked={form.roles.includes(r)} disabled={!list.yourRoles.includes(r)} onChange={() => toggle(r)} />{r}
            </label>
          ))}
        </fieldset>
        <button className="primary" onClick={create} disabled={!form.name || !form.roles.length || form.reason.trim().length < 10}>Create key</button>
      </Panel>
      <Panel title={`Keys in this client (${list.keys.length})`}>
        {!list.keys.length ? <p className="muted">No keys yet.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Prefix</th><th>Roles</th><th>Status</th><th>Created</th><th>Expires</th><th>Last used</th><th className="num">Requests</th><th /></tr></thead>
              <tbody>{list.keys.map((k) => (
                <tr key={k.keyId}>
                  <td>{k.name}<div className="small muted mono">{k.principal}</div></td>
                  <td className="mono">{k.prefix}…</td>
                  <td>{k.roles.join(', ')}</td>
                  <td><span className={`badge ${TONE[k.status] ?? 'b-neutral'}`}>{k.status}</span>{k.revokeReason && <div className="small muted gov-wrap">{k.revokeReason}</div>}</td>
                  <td className="small">{when(k.createdAt)}<div className="muted">{k.createdBy}</div></td>
                  <td className="small">{when(k.expiresAt)}</td>
                  <td className="small">{k.lastUsedAt ? when(k.lastUsedAt) : 'never'}</td>
                  <td className="num">{k.useCount}</td>
                  <td>{k.status === 'active' && <button onClick={() => revoke(k)}>Revoke</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
