import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { Heading, Panel } from '../ui.tsx';
import { evaluateDed01, OUTCOME_LABELS, reasonLabel } from '../../../shared/rules/ded01.ts';
import type { RuleDefinition } from '../../../shared/rules/catalog.ts';
import fixtures from '../../../evaluation/deductible-fixtures.json' with { type: 'json' };

interface Fx { id: string; name: string; input: Record<string, unknown>; expected: string; severity: string }

export function Rules() {
  const [rule, setRule] = useState<{ definition: RuleDefinition; sha256: string; state: string } | null>(null);
  const [ran, setRan] = useState(false);
  useEffect(() => { api.get<typeof rule>('/api/rules/DED01').then(setRule).catch(() => {}); }, []);
  // Same engine module the server uses: shared/rules/ded01.ts.
  const results = useMemo(() => (fixtures as Fx[]).map((f) => ({ f, r: evaluateDed01(f.input) })), []);
  const failures = results.filter((x) => x.r.outcome !== x.f.expected);
  if (!rule) return <p className="muted">Loading rule…</p>;
  const d = rule.definition;
  return (
    <>
      <Heading eyebrow="Rule studio" title={`${d.id} · Deductible allocation review`} subtitle="Versioned rule data plus a reviewed deterministic function. Rule text is never executed." />
      <div className="callout" style={{ marginBottom: 16 }}>Draft v{d.version} · not publishable. Runs only in the synthetic environment. Publishing requires an evaluation report on customer-labeled cases and sign-off by {d.owner.toLowerCase()}.</div>
      <div className="grid2">
        <div>
          <Panel title="Scope and assumptions">
            <dl className="kv">
              <dt>Payer</dt><dd>{d.scope.payer}</dd><dt>Plan</dt><dd>{d.scope.plan}</dd><dt>Claim type</dt><dd>{d.scope.claimType}</dd>
              <dt>Effective</dt><dd>{d.effectiveFrom} to {d.effectiveThrough}</dd><dt>Logic</dt><dd className="mono">{d.logicModule}</dd>
              <dt>Definition hash</dt><dd className="mono">{rule.sha256.slice(0, 24)}…</dd><dt>Follow-up</dt><dd className="small">{d.followUpSource}</dd>
            </dl>
            <ul className="small" style={{ marginTop: 12 }}>{d.supportedAssumptions.map((s) => <li key={s}>{s}</li>)}</ul>
          </Panel>
          <Panel title="Required facts">
            <table><thead><tr><th>Fact</th><th>Accepted statuses</th></tr></thead>
              <tbody>{d.requiredFacts.map((f) => <tr key={f.key}><td>{f.label}<div className="small muted mono">{f.key}</div></td><td>{f.acceptedStatuses.join(', ')}</td></tr>)}</tbody></table>
          </Panel>
          <Panel title="Actions">
            <table><thead><tr><th>Outcome</th><th>Risk class</th><th>Connector</th></tr></thead>
              <tbody>{d.actions.map((a) => <tr key={a.kind}><td>{OUTCOME_LABELS[a.kind as keyof typeof OUTCOME_LABELS] ?? a.kind}</td><td>{a.risk.replace(/_/g, ' ')}</td><td>{a.connector ?? 'none (abstain)'}</td></tr>)}</tbody></table>
            <p className="small" style={{ marginTop: 8 }}>Prohibited: {d.prohibitedActions.join(', ').replace(/_/g, ' ')}</p>
            <p className="small muted">Sources: {d.sources.join(' · ')}</p>
          </Panel>
        </div>
        <Panel title="Fixture evaluation" actions={<button className="primary" onClick={() => setRan(true)}>Run {results.length} fixtures</button>}>
          {!ran ? <p className="muted">Runs the build-pack synthetic fixtures through the production engine in your browser. Synthetic labels are not customer-approved; this checks mechanics, not payer policy.</p> : (
            <>
              <div className={`callout ${failures.length ? 'danger' : 'ok'}`} style={{ marginBottom: 12 }}>{results.length - failures.length} of {results.length} match the expected outcome. {failures.length ? `${failures.length} differ.` : 'No differences.'}</div>
              <table><thead><tr><th>Case</th><th>Expected</th><th>Actual</th></tr></thead>
                <tbody>{results.map(({ f, r }) => (
                  <tr key={f.id}><td>{f.id}<div className="small muted">{f.name}{f.severity === 'critical' ? ' · critical' : ''}</div></td><td className="small">{f.expected}</td>
                    <td className="small"><span className={`badge ${r.outcome === f.expected ? 'b-verified' : 'b-danger'}`}>{r.outcome}</span><div className="muted">{r.reasonCodes.map(reasonLabel).join('; ')}</div></td></tr>))}
                </tbody></table>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
