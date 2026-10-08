import { useEffect, useState } from 'react';
import { api, money, when, errorText } from '../api.ts';
import { Heading } from '../ui.tsx';
import { go } from '../App.tsx';

interface R { actionId: string; accountId: string; externalId: string; kind: string; label: string; balanceCents: number; createdAt: string; expiresAt: string }

export function Reviews() {
  const [rows, setRows] = useState<R[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get<R[]>('/api/reviews').then(setRows).catch((e) => setErr(errorText(e))); }, []);
  return (
    <>
      <Heading eyebrow="Reviewer" title="Reviews" subtitle="Proposals awaiting a hash-bound human decision. Bulk approval is disabled." />
      <section className="panel">
        {err && <div className="callout danger">{err}</div>}
        {rows && rows.length === 0 && <div className="callout info">Nothing awaits review in this client.</div>}
        {rows && rows.length > 0 && (
          <table>
            <thead><tr><th>Account</th><th>Proposed next step</th><th className="r">Balance</th><th>Proposed</th><th>Expires</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.actionId}>
                <td>{r.externalId}</td><td>{r.label}</td><td className="r num">{money(r.balanceCents)}</td><td>{when(r.createdAt)}</td><td>{when(r.expiresAt)}</td>
                <td className="r"><button onClick={() => go(`/account/${r.accountId}`)}>Open review</button></td>
              </tr>))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
