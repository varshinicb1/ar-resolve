import { useEffect, useState } from 'react';
import { api, errorText, when } from '../api.ts';
import { Heading, Panel, toast } from '../ui.tsx';
import { go } from '../App.tsx';

interface Report {
  committed: boolean; batchId?: string; sourceSha256: string; mapping: { field: string; column: string | null }[]; unknownColumns: string[];
  rows: { line: number; externalId: string | null; status: string; errors: string[] }[]; summary?: { accepted: number; rejected: number; duplicates: number }; fatal?: string;
}

export function Import({ roles }: { roles: string[] }) {
  const [name, setName] = useState('inventory.csv');
  const [csv, setCsv] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [samples, setSamples] = useState<{ clean: { name: string; csv: string }; ambiguous: { name: string; csv: string } } | null>(null);
  const [batches, setBatches] = useState<any[]>([]);
  const canImport = roles.includes('specialist') || roles.includes('supervisor');
  const loadBatches = () => api.get<any[]>('/api/imports').then(setBatches).catch(() => {});
  useEffect(() => {
    loadBatches();
    if (canImport) api.get<typeof samples>('/api/imports/samples').then(setSamples).catch(() => {});
  }, [canImport]);

  const preview = async () => {
    try { setReport(await api.post<Report>('/api/imports/preview', { sourceName: name, csv })); } catch (e) { toast(errorText(e), true); }
  };
  const commit = async () => {
    try {
      const r = await api.post<Report>('/api/imports', { sourceName: name, csv });
      setReport(r); loadBatches();
      toast(`Imported ${r.summary?.accepted} accounts · ${r.summary?.rejected} rejected · ${r.summary?.duplicates} duplicates skipped`);
    } catch (e) { toast(errorText(e), true); }
  };

  return (
    <>
      <Heading eyebrow="Intake" title="Import account inventory" subtitle="Preview field mapping and row validation before anything is written. Ambiguous rows are rejected, never guessed." />
      {!canImport && <div className="callout info">Your role cannot import inventory in this client.</div>}
      {canImport && (
        <Panel title="Source file">
          <div className="stack">
            {samples && <div className="gap8"><span className="small muted">Synthetic samples:</span>
              <button onClick={() => { setName(samples.clean.name); setCsv(samples.clean.csv); setReport(null); }}>Load synthetic inventory</button>
              <button onClick={() => { setName(samples.ambiguous.name); setCsv(samples.ambiguous.csv); setReport(null); }}>Load file with ambiguous rows</button>
              <label className="small" style={{ margin: 0 }}>or upload CSV <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setName(f.name); setCsv(await f.text()); setReport(null); } }} /></label>
            </div>}
            <div><label htmlFor="csv">CSV content ({name})</label><textarea id="csv" className="mono" style={{ minHeight: 180 }} value={csv} onChange={(e) => { setCsv(e.target.value); setReport(null); }} /></div>
            <div className="gap8">
              <button onClick={preview} disabled={!csv.trim()}>Preview</button>
              <button className="primary" onClick={commit} disabled={!report || report.committed || !!report.fatal || !report.summary?.accepted}>Commit {report?.summary?.accepted ?? 0} accepted rows</button>
            </div>
          </div>
        </Panel>
      )}
      {report && (
        <Panel title={report.committed ? 'Import committed' : 'Preview'}>
          {report.fatal && <div className="callout danger">{report.fatal}</div>}
          <p className="small muted">Source SHA-256 <span className="mono">{report.sourceSha256}</span>{report.batchId && <> · batch <span className="mono">{report.batchId}</span></>}</p>
          <p className="small" style={{ margin: '8px 0' }}>Mapping: {report.mapping.map((m) => `${m.field} ← ${m.column ?? 'MISSING'}`).join(' · ')}{report.unknownColumns.length > 0 && ` · ignored columns: ${report.unknownColumns.join(', ')}`}</p>
          {report.summary && <div className="metrics"><div className="panel metric"><small>Accepted</small><strong>{report.summary.accepted}</strong></div><div className="panel metric"><small>Rejected</small><strong>{report.summary.rejected}</strong></div><div className="panel metric"><small>Duplicates skipped</small><strong>{report.summary.duplicates}</strong></div></div>}
          <table><thead><tr><th>Line</th><th>Account</th><th>Result</th><th>Detail</th></tr></thead>
            <tbody>{report.rows.map((r) => (
              <tr key={r.line}><td className="num">{r.line}</td><td>{r.externalId ?? '—'}</td>
                <td><span className={`badge ${r.status === 'accepted' ? 'b-verified' : r.status === 'duplicate' ? 'b-neutral' : 'b-danger'}`}>{r.status}</span></td>
                <td className="small">{r.errors.join('; ')}</td></tr>))}
            </tbody></table>
          {report.committed && <div style={{ marginTop: 12 }}><button className="primary" onClick={() => go('/queue')}>Open work queue</button></div>}
        </Panel>
      )}
      <Panel title="Import history">
        {batches.length === 0 ? <p className="muted">No imports in this client yet.</p> : (
          <table><thead><tr><th>Batch</th><th>File</th><th className="r">Accepted</th><th className="r">Rejected</th><th className="r">Duplicates</th><th>By</th><th>When</th></tr></thead>
            <tbody>{batches.map((b) => <tr key={b.batch_id}><td className="mono">{b.batch_id}</td><td>{b.source_name}</td><td className="r num">{b.accepted}</td><td className="r num">{b.rejected}</td><td className="r num">{b.duplicates}</td><td>{b.created_by}</td><td>{when(b.created_at)}</td></tr>)}</tbody></table>
        )}
      </Panel>
    </>
  );
}
