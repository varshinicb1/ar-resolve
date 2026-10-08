import { useEffect, useState } from 'react';
import { api, money, errorText } from '../api.ts';
import { Heading, StateBadge, StatusBadge } from '../ui.tsx';
import { go } from '../App.tsx';

interface Item {
  accountId: string; externalId: string; payerId: string; claimReference: string; scenario: string; balanceCents: number; serviceDate: string;
  state: string; revision: number; nextStep: { kind: string; label: string; state: string } | null; evidenceState: string;
  priority: { score: number; ageDays: number; explanation: string[] };
}
interface Page { total: number; page: number; pageSize: number; items: Item[]; counts: Record<string, number> }

const VIEWS: [string, string][] = [
  ['all', 'All accounts'], ['awaiting_review', 'Awaiting review'], ['evidence_missing', 'Evidence missing or blocked'],
  ['receipt_uncertain', 'Receipt uncertain'], ['in_flight', 'In flight'], ['not_started', 'Not investigated'],
];

const EVIDENCE: Record<string, string> = { complete: 'verified', incomplete: 'missing', conflicting: 'conflicting', not_collected: 'stale' };
const EVIDENCE_TEXT: Record<string, string> = { complete: 'Complete', incomplete: 'Incomplete', conflicting: 'Conflicting', not_collected: 'Not collected' };

export function Queue() {
  const [view, setView] = useState(() => { try { return sessionStorage.getItem('ar.view') ?? 'all'; } catch { return 'all'; } });
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    try { sessionStorage.setItem('ar.view', view); } catch { /* ignore */ }
    const t = setTimeout(() => {
      api.get<Page>(`/api/accounts?view=${view}&q=${encodeURIComponent(q)}&page=${page}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(errorText(e)));
    }, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [view, q, page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <Heading eyebrow="Payer operations" title="Work queue" subtitle="Unresolved accounts in this client, ordered by explained priority. Counts are accounts, not calls." />
      <div className="tabs" role="group" aria-label="Saved views">
        {VIEWS.map(([k, label]) => (
          <button key={k} aria-pressed={view === k} onClick={() => { setView(k); setPage(1); }}>{label} <span className="num">({data?.counts[k] ?? 0})</span></button>
        ))}
      </div>
      <section className="panel">
        <div className="row" style={{ marginBottom: 12 }}>
          <div style={{ flex: '1 1 260px', maxWidth: 360 }}>
            <label htmlFor="q">Search account or claim reference</label>
            <input id="q" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="SYN-1042" style={{ width: '100%' }} />
          </div>
          <p className="small muted">Search is limited to the selected client scope.</p>
        </div>
        {err && <div className="callout danger">{err}</div>}
        {data && data.items.length === 0 && (
          <div className="callout info">
            {data.counts.all === 0 ? <>No accounts in this client yet. <a href="#/import">Import the synthetic inventory</a> to begin.</> : 'No eligible accounts under these filters.'}
          </div>
        )}
        {data && data.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account</th><th>Payer</th><th>Scenario</th><th className="r">Balance</th><th className="r">Age</th><th>Next step</th><th>Evidence</th><th>State</th><th>Priority</th></tr></thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.accountId} className="clickable">
                    <td><button className="link" onClick={() => go(`/account/${i.accountId}`)}>{i.externalId}</button><div className="small muted">{i.claimReference}</div></td>
                    <td>{i.payerId}</td>
                    <td>{i.scenario}</td>
                    <td className="r num">{money(i.balanceCents)}</td>
                    <td className="r num">{i.priority.ageDays}d</td>
                    <td>{i.nextStep ? <>{i.nextStep.label}<div className="small muted">{i.nextStep.state.replace(/_/g, ' ')}</div></> : <span className="muted">—</span>}</td>
                    <td><StatusBadge status={EVIDENCE[i.evidenceState]} />{' '}<span className="sr">{EVIDENCE_TEXT[i.evidenceState]}</span></td>
                    <td><StateBadge state={i.state} /></td>
                    <td><details><summary className="num">{i.priority.score}</summary><ul className="small" style={{ margin: '6px 0 0', paddingLeft: 16 }}>{i.priority.explanation.map((x) => <li key={x}>{x}</li>)}</ul></details></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && pages > 1 && (
          <div className="gap8" style={{ marginTop: 12 }}>
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="small muted">Page {page} of {pages}</span>
            <button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </section>
    </>
  );
}
