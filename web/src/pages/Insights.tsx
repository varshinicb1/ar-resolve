// Insights: KPI tiles with stated definitions, the outcome ledger (promise vs
// accepted request vs adjudication vs cash), remittance import and the
// unit-economics calculator. Everything here is synthetic activity or an
// assumption; nothing is an accuracy, recovery or productivity result.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText, money, when } from '../api.ts';
import { Heading, Panel, toast } from '../ui.tsx';
import { go } from '../App.tsx';
import { ENTRY_LABEL } from './AccountOps.tsx';
import { calculate, variants, ASSUMPTION_LABELS, ECONOMICS_DISCLAIMER, type EconomicsAssumptions } from '../../../shared/economics.ts';

interface Metric { id: string; label: string; value: number | null; unit: string; numerator: number | null; denominator: number | null; definition: string }
interface Kpis { notice: string; metrics: Metric[]; outcomesByType: { entryType: string; attribution: string; count: number; amountCents: number | null; deltaCents: number | null }[]; analyticsEvents: { event: string; count: number }[] }
interface Entry { entryId: string; accountId: string; externalId: string; lineNumber: number | null; entryType: string; amountCents: number | null; deltaCents: number | null; attribution: string; attributionRule: string | null; attributionReason: string; recordedAt: string; entryHash: string }
interface Rule { id: string; version: number; state: string; title: string; methodology: string[]; windowDays: number; sha256: string }

function fmt(m: Metric): string {
  if (m.value === null) return '—';
  if (m.unit === 'ratio') return `${(m.value * 100).toFixed(1)}%`;
  if (m.unit === 'minutes') return `${m.value} min`;
  return String(m.value);
}

export function Insights({ roles }: { roles: string[] }) {
  const [k, setK] = useState<Kpis | null>(null);
  const [ledger, setLedger] = useState<{ entries: Entry[]; rule: Rule } | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { const [a, b] = await Promise.all([api.get<Kpis>('/api/insights/kpis'), api.get<{ entries: Entry[]; rule: Rule }>('/api/outcomes/ledger')]); setK(a); setLedger(b); setErr(''); } catch (e) { setErr(errorText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const canExport = roles.includes('auditor') || roles.includes('supervisor');
  const canImport = roles.includes('specialist') || roles.includes('supervisor');

  const exportLedger = async () => {
    try {
      const pkt = await api.get<any>('/api/outcomes/ledger/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(pkt, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `outcome-ledger-${pkt.exportedAt.slice(0, 19)}.json`; a.click(); URL.revokeObjectURL(url);
      toast(`Ledger exported. Chain ${pkt.chain.ok ? 'verified' : 'BROKEN'} · sha256 ${pkt.packetSha256.slice(0, 12)}`);
    } catch (e) { toast(errorText(e), true); }
  };

  return (
    <>
      <Heading eyebrow="Insights" title="Operational KPIs and outcomes" subtitle="Financial value and failure risk side by side. Each metric states its numerator and denominator." />
      {err && <div className="callout danger">{err}</div>}
      {k && (
        <>
          <div className="callout info" style={{ marginBottom: 16 }}>{k.notice}</div>
          <div className="metrics">
            {k.metrics.map((m) => (
              <div key={m.id} className="panel metric">
                <small>{m.label}</small><strong>{fmt(m)}</strong>
                <span className="small muted">{m.numerator !== null && m.denominator !== null ? `${m.numerator} / ${m.denominator}` : m.denominator !== null ? `n = ${m.denominator}` : ''}</span>
                <details><summary>Definition</summary><p className="small">{m.definition}</p></details>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="grid2">
        <div>
          <Panel title="Outcome ledger" actions={<div className="gap8">{canExport && <button onClick={exportLedger}>Export ledger</button>}</div>}>
            {ledger && (
              <div className="stack">
                <details><summary>Attribution rule {ledger.rule.id} v{ledger.rule.version} ({ledger.rule.state})</summary>
                  <p className="small"><b>{ledger.rule.title}</b></p>
                  <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{ledger.rule.methodology.map((m) => <li key={m}>{m}</li>)}</ul>
                  <p className="small mono">sha256 {ledger.rule.sha256.slice(0, 16)}…</p></details>
                {k && k.outcomesByType.length > 0 && (
                  <table><thead><tr><th>Entry type</th><th>Attribution</th><th className="r">Count</th><th className="r">Δ</th></tr></thead><tbody>{k.outcomesByType.map((o) => (
                    <tr key={o.entryType + o.attribution}><td className="small">{ENTRY_LABEL[o.entryType] ?? o.entryType}</td><td className="small">{o.attribution.replace(/_/g, ' ')}</td><td className="r num">{o.count}</td><td className="r num small">{o.deltaCents === null ? '—' : money(o.deltaCents)}</td></tr>))}</tbody></table>
                )}
                {ledger.entries.length === 0 ? <p className="muted">No outcomes recorded yet.</p> : (
                  <div className="table-wrap"><table><thead><tr><th>Account</th><th>Entry</th><th className="r">Amount</th><th>Attribution</th></tr></thead>
                    <tbody>{[...ledger.entries].reverse().slice(0, 50).map((e) => (
                      <tr key={e.entryId}><td><button className="link" onClick={() => go(`/account/${e.accountId}`)}>{e.externalId}</button><div className="small muted">{when(e.recordedAt)}</div></td>
                        <td className="small">{ENTRY_LABEL[e.entryType] ?? e.entryType}{e.lineNumber ? ` · line ${e.lineNumber}` : ''}</td>
                        <td className="r num small">{e.amountCents === null ? '—' : money(e.amountCents)}</td>
                        <td className="small"><span className={`badge ${e.attribution === 'attributable' ? 'b-verified' : 'b-neutral'}`}>{e.attribution.replace(/_/g, ' ')}</span><div className="muted">{e.attributionReason}</div></td></tr>))}
                    </tbody></table></div>
                )}
              </div>
            )}
          </Panel>
          {canImport && <RemittancePanel onDone={load} />}
        </div>
        <div>
          <EconomicsPanel />
          {k && (
            <Panel title="Analytics events (opaque identifiers only)">
              <table><tbody>{k.analyticsEvents.map((e) => <tr key={e.event}><td className="mono">{e.event}</td><td className="r num">{e.count}</td></tr>)}</tbody></table>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

function RemittancePanel({ onDone }: { onDone: () => void }) {
  const [json, setJson] = useState('');
  const [result, setResult] = useState<any>(null);
  const loadSample = async () => { try { setJson(JSON.stringify(await api.get('/api/remittance/sample'), null, 2)); setResult(null); } catch (e) { toast(errorText(e), true); } };
  const submit = async () => {
    try {
      const body = JSON.parse(json);
      const r = await api.post<any>('/api/remittance', { format: body.format, sourceName: body.sourceName, lines: body.lines });
      setResult(r); toast('Remittance reconciled'); onDone();
    } catch (e) { toast(e instanceof SyntaxError ? 'Not valid JSON' : errorText(e), true); }
  };
  return (
    <Panel title="Reconcile remittance (synthetic)">
      <div className="stack">
        <p className="small muted">Line-level input (format ar-resolve.synthetic-remittance.v1). Matching uses claim reference and payer within this client only. A real 835 feed is not connected.</p>
        <div className="gap8"><button onClick={loadSample}>Load synthetic sample</button><button className="primary" disabled={!json.trim()} onClick={submit}>Reconcile</button></div>
        <label htmlFor="rj" className="sr">Remittance JSON</label>
        <textarea id="rj" value={json} onChange={(e) => setJson(e.target.value)} rows={10} className="mono" />
        {result && <table><tbody>{result.results.map((r: any, i: number) => <tr key={i}><td className="small">{r.claimReference} line {r.lineNumber}</td><td className="small">{r.status}{r.matchStatus ? ` · ${r.matchStatus}` : ''}{r.outcome ? ` · ${r.outcome}` : ''}{r.reopened ? ' · account reopened' : ''}</td></tr>)}</tbody></table>}
      </div>
    </Panel>
  );
}

function EconomicsPanel() {
  const [base, setBase] = useState<EconomicsAssumptions | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  useEffect(() => { api.get<{ assumptions: EconomicsAssumptions }>('/api/insights/economics').then((r) => setBase(r.assumptions)).catch((e) => toast(errorText(e), true)); }, []);
  const current = useMemo(() => {
    if (!base) return null;
    const a = { ...base } as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(edit)) { const n = Number(v); if (v.trim() !== '' && Number.isFinite(n) && n >= 0) a[k] = n; }
    return a as unknown as EconomicsAssumptions;
  }, [base, edit]);
  if (!base || !current) return null;
  const rows = Object.entries(variants(current)).map(([k, a]) => [k, calculate(a)] as const);
  return (
    <Panel title="Capacity and unit economics (assumptions)">
      <div className="stack">
        <div className="callout">{ECONOMICS_DISCLAIMER}</div>
        <div className="table-wrap"><table><thead><tr><th>Case</th><th className="r">Cost / acct</th><th className="r">Revenue / acct</th><th className="r">Contribution</th><th className="r">Price floor</th><th className="r">Lines</th></tr></thead>
          <tbody>{rows.map(([k, r]) => (
            <tr key={k}><td className="small">{k.replace(/_/g, ' ')}</td><td className="r num">${r.direct_cost_per_account.toFixed(2)}</td><td className="r num">${r.revenue_per_account.toFixed(2)}</td>
              <td className="r num">${r.contribution_per_account.toFixed(2)}<div className="small muted">{(r.contribution_margin * 100).toFixed(1)}%</div></td>
              <td className="r num">${r.price_floor_per_resolution.toFixed(2)}</td><td className="r num">{r.required_concurrent_lines}</td></tr>))}
          </tbody></table></div>
        <details><summary>Edit assumptions (base case; stress and high-quality cases derive from it as in the build pack calculator)</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            {(Object.keys(ASSUMPTION_LABELS) as (keyof EconomicsAssumptions)[]).map((key) => (
              <div key={key} className="row"><label htmlFor={`as-${key}`} style={{ margin: 0, fontWeight: 400 }}>{ASSUMPTION_LABELS[key]}</label>
                <input id={`as-${key}`} inputMode="decimal" style={{ width: 110 }} value={edit[key] ?? String(base[key])} onChange={(e) => setEdit({ ...edit, [key]: e.target.value })} /></div>
            ))}
            <button onClick={() => setEdit({})}>Reset to build pack assumptions</button>
          </div>
        </details>
        <p className="small muted">Source: build pack evaluation/economics-assumptions.json and calculate.py (doc 14). Lines = attempts x occupied minutes / (shift minutes x utilization).</p>
      </div>
    </Panel>
  );
}
