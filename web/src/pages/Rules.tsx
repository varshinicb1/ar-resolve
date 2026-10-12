// Rule studio (FR05/FR06, ADR 0020): packs, versions and lifecycle, browser-side
// fixture runner on the same engine modules the server uses, data-only draft
// editor, diff, before/after impact, and separated review / publish / retire.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText, when } from '../api.ts';
import { Heading, Overlay, Panel, toast } from '../ui.tsx';
import { go } from '../App.tsx';
import type { RuleDefinition } from '../../../shared/rules/catalog.ts';
import { MODULES, moduleForRule } from '../../../shared/rules/registry.ts';
import { runFixtures, validateDefinition, type FixtureRow, type ValidationReport } from '../../../shared/rules/studio.ts';
import { SCENARIO_MAP_V1 } from '../../../shared/rules/select.ts';
import type { Fixture, ParamSpec } from '../../../shared/rules/types.ts';
import ded01 from '../../../evaluation/deductible-fixtures.json' with { type: 'json' };
import pend01 from '../../../evaluation/pend01-fixtures.json' with { type: 'json' };
import doc01 from '../../../evaluation/doc01-fixtures.json' with { type: 'json' };
import dup01 from '../../../evaluation/dup01-fixtures.json' with { type: 'json' };
import cob01 from '../../../evaluation/cob01-fixtures.json' with { type: 'json' };
import tf01 from '../../../evaluation/tf01-fixtures.json' with { type: 'json' };
import auth01 from '../../../evaluation/auth01-fixtures.json' with { type: 'json' };
import mn01 from '../../../evaluation/mn01-fixtures.json' with { type: 'json' };
import bun01 from '../../../evaluation/bun01-fixtures.json' with { type: 'json' };
import route00 from '../../../evaluation/route00-fixtures.json' with { type: 'json' };

const FIXTURES: Record<string, Fixture[]> = {
  'deductible-fixtures.json': ded01 as Fixture[], 'pend01-fixtures.json': pend01 as Fixture[], 'doc01-fixtures.json': doc01 as Fixture[],
  'dup01-fixtures.json': dup01 as Fixture[], 'cob01-fixtures.json': cob01 as Fixture[], 'tf01-fixtures.json': tf01 as Fixture[],
  'auth01-fixtures.json': auth01 as Fixture[], 'mn01-fixtures.json': mn01 as Fixture[], 'bun01-fixtures.json': bun01 as Fixture[],
  'route00-fixtures.json': route00 as Fixture[],
};

interface Perms { author: boolean; approve: boolean; view: boolean }
interface Active { runnable: boolean; version: number | null; via: string | null; note: string; reason?: string; scheduled: { version: number; active_from: string; kind: string }[] }
interface VersionSummary {
  version: number; status: string; builtIn: boolean; baseVersion: number | null; author: string; submittedBy: string | null; reviewedBy: string | null; reviewedAt: string | null;
  reviewRationale: string | null; sha256: string; createdAt: string; validation: { ok: boolean; fixtures: { total: number; passed: number } } | null; definition?: RuleDefinition;
}
interface PackRow { ruleId: string; title: string; kind: string; summary: string; logicModule: string; fixtureFile: string; fixtureCount: number; active: Active; versions: VersionSummary[]; openDrafts: number }
interface PackList { environment: string; draftsMayRun: boolean; permissions: Perms; selectionMap: { id: string; version: number; status: string; sha256: string }; packs: PackRow[] }
interface Draft { draftId: string; ruleId: string; baseVersion: number; definition: RuleDefinition; editSeq: number; status: string; frozenVersion: number | null; lastValidation: ValidationReport | null; author: string; updatedAt: string; diff?: Diff[] }
interface Diff { path: string; before: unknown; after: unknown }
interface Detail {
  ruleId: string; title: string; kind: string; summary: string; logicModule: string; outcomeLabels: Record<string, string>; paramSpecs: ParamSpec[];
  branches: { when: string; propose: string }[]; hardStops: string[]; fixtureFile: string; active: Active; versions: (VersionSummary & { definition: RuleDefinition })[];
  activations: { activation_id: string; version: number; kind: string; active_from: string; reason: string; previous_version: number | null; activated_by: string; created_at: string }[];
  retirements: { version: number; reason: string; retired_by: string; retired_at: string }[]; drafts: Draft[]; permissions: Perms; environment: string;
}
interface Impact {
  ruleId: string; candidate: string; current: { version: number | null; via: string | null; note?: string };
  fixtures: { total: number; changed: number; failing: number; rows: { id: string; name: string; category: string; expected: string; before: string | null; after: string; pass: boolean }[] };
  accounts: { considered: number; changed: number; newlyAutomated: number; newlyBlocked: number; actionChanged: number; routingChanged: number;
    rows: { accountId: string; externalId: string; before: string | null; after: string; change: string; beforeReasons: string[]; afterReasons: string[]; pinned: { version: number; actionState: string } | null }[] };
  note: string;
}

const KIND_TEXT: Record<string, string> = { executable: 'Executable pack', specialist_route: 'Specialist route', router: 'Router (abstains only)' };
const STATUS_TONE: Record<string, string> = { draft: 'b-neutral', validated: 'b-review', in_review: 'b-review', approved: 'b-verified', rejected: 'b-danger', retired: 'b-danger' };
const VIA_TEXT: Record<string, string> = { activation: 'published', pinned: 'pinned', synthetic_draft_baseline: 'draft baseline (synthetic only)', router_fallback: 'router fallback' };

function StatusPill({ status }: { status: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? 'b-neutral'}`}>{status.replace('_', ' ')}</span>;
}

function ActiveText({ a }: { a: Active }) {
  if (!a.runnable) return <span className="badge b-danger" title={a.note}>Not runnable</span>;
  return <span className="small">v{a.version} · {VIA_TEXT[a.via ?? ''] ?? a.via}</span>;
}

export function Rules({ ruleId }: { ruleId?: string }) {
  return ruleId ? <PackDetail ruleId={ruleId} /> : <PackListView />;
}

// ---------------------------------------------------------------- list

function PackListView() {
  const [list, setList] = useState<PackList | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get<PackList>('/api/rule-studio/packs').then(setList).catch((e) => setErr(errorText(e))); }, []);
  // Browser-side run of every pack's fixtures with the same modules the server uses.
  const fixtureStatus = useMemo(() => Object.fromEntries(MODULES.map((m) => {
    const rows = runFixtures(m, FIXTURES[m.fixtureFile] ?? []);
    return [m.ruleId, { passed: rows.filter((r) => r.pass).length, total: rows.length }];
  })), []);
  if (err) return <div className="callout danger">{err}</div>;
  if (!list) return <p className="muted">Loading rule studio…</p>;
  return (
    <>
      <Heading eyebrow="Rule studio" title="Scenario rule packs" subtitle="Versioned rule data plus reviewed deterministic logic. Editors change data only; rule text is never executed." />
      <div className="callout" style={{ marginBottom: 16 }}>
        Environment: <b>{list.environment}</b>. {list.draftsMayRun ? 'Draft versions may run here only because the environment is synthetic. Shadow and assisted-live environments run approved, published versions only.' : 'Only approved, published versions run.'}
        {' '}Your rule permissions: {list.permissions.author ? 'author' : 'no authoring'} · {list.permissions.approve ? 'rule approver' : 'not a rule approver'}.
      </div>
      <Panel title="Packs">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Pack</th><th>Kind</th><th>Running in this client</th><th>Versions</th><th>Fixtures (browser run)</th><th /></tr></thead>
            <tbody>{list.packs.map((p) => {
              const fx = fixtureStatus[p.ruleId];
              return (
                <tr key={p.ruleId} className="clickable">
                  <td><b>{p.ruleId}</b> {p.title}<div className="small muted">{p.summary}</div></td>
                  <td className="small">{KIND_TEXT[p.kind] ?? p.kind}</td>
                  <td><ActiveText a={p.active} />{p.active.scheduled.length > 0 && <div className="small muted">Scheduled: v{p.active.scheduled[0].version} at {when(p.active.scheduled[0].active_from)}</div>}</td>
                  <td><div className="gap8">{p.versions.map((v) => <span key={v.version} className="small">v{v.version} <StatusPill status={v.status} /></span>)}</div>
                    {p.openDrafts > 0 && <div className="small muted">{p.openDrafts} open draft{p.openDrafts > 1 ? 's' : ''}</div>}</td>
                  <td><span className={`badge ${fx && fx.passed === fx.total ? 'b-verified' : 'b-danger'}`}>{fx ? `${fx.passed}/${fx.total}` : '—'}</span></td>
                  <td className="r"><button onClick={() => go(`/rules/${p.ruleId}`)}>Open</button></td>
                </tr>);
            })}</tbody>
          </table>
        </div>
      </Panel>
      <SelectionMapPanel sha={list.selectionMap.sha256} />
    </>
  );
}

function SelectionMapPanel({ sha }: { sha: string }) {
  const m = SCENARIO_MAP_V1;
  return (
    <Panel title={`Scenario selection map · ${m.id} v${m.version} (${m.status})`}>
      <p className="small muted" style={{ marginBottom: 8 }}>Deterministic FR05 routing from adjustment group, CARC, RARC and claim status. Unknown or multiple matches go to specialist review; nothing is guessed. sha256 <span className="mono">{sha.slice(0, 16)}…</span> · {m.labelStatus.replace(/_/g, ' ')}</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Match</th><th>Pack</th><th>Note</th></tr></thead>
          <tbody>{m.entries.map((e) => (
            <tr key={e.id}><td className="mono">{Object.entries(e.match).map(([k, v]) => `${k}=${v}`).join(' ')}</td><td>{e.scenario}</td><td className="small">{e.note}</td></tr>))}
          </tbody>
        </table>
      </div>
      <ul className="small" style={{ marginTop: 12 }}>{m.sources.map((s) => <li key={s.id}><b>{s.title}</b> ({s.status}{s.retrievedAt ? `, retrieved ${s.retrievedAt}` : ''}): {s.note}{s.url && <> <span className="mono">{s.url}</span></>}</li>)}</ul>
    </Panel>
  );
}

// ---------------------------------------------------------------- detail

type Dialog = { kind: 'submit' | 'approve' | 'reject' | 'publish' | 'rollback' | 'retire'; version: number };

function PackDetail({ ruleId }: { ruleId: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const mod = moduleForRule(ruleId);

  const load = useCallback(async () => {
    try { setD(await api.get<Detail>(`/api/rule-studio/packs/${ruleId}`)); setErr(''); } catch (e) { setErr(errorText(e)); }
  }, [ruleId]);
  useEffect(() => { load(); }, [load]);

  if (err) return <div className="callout danger">{err}</div>;
  if (!d || !mod) return <p className="muted">Loading pack…</p>;
  const version = d.versions.find((v) => v.version === (selected ?? d.active.version ?? d.versions[d.versions.length - 1].version)) ?? d.versions[0];
  const def = version.definition;
  const openDraft = d.drafts.find((x) => x.draftId === draftId) ?? null;
  const activated = new Set(d.activations.map((a) => a.version));

  const newDraft = async (base: number) => {
    try { const dr = await api.post<Draft>(`/api/rule-studio/packs/${ruleId}/drafts`, { baseVersion: base }); toast(`Draft created from v${base}`); await load(); setDraftId(dr.draftId); setImpact(null); }
    catch (e) { toast(errorText(e), true); }
  };
  const showImpact = async (path: string) => {
    try { setImpact(await api.get<Impact>(path)); } catch (e) { toast(errorText(e), true); }
  };

  return (
    <>
      <Heading eyebrow={`Rule studio · ${KIND_TEXT[d.kind] ?? d.kind}`} title={`${d.ruleId} · ${d.title}`} subtitle={d.summary} />
      <div className="gap8" style={{ marginBottom: 16 }}>
        <button onClick={() => go('/rules')}>All packs</button>
        <span className="small">Running in this client: <ActiveText a={d.active} /></span>
        {!d.active.runnable && <span className="small" style={{ color: 'var(--danger)' }}>{d.active.note}</span>}
      </div>
      {d.kind !== 'executable' && <div className="callout info" style={{ marginBottom: 16 }}>{d.kind === 'router' ? 'This pack runs when no single runnable scenario applies. It only abstains.' : 'Specialist route: its only outcomes are collect evidence, specialist review, or an internal work item routing the completed evidence checklist to a specialist. No payer-facing or financial action.'}</div>}
      <div className="grid2">
        <div>
          <Panel title="Versions and lifecycle">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Version</th><th>Status</th><th>Author / reviewer</th><th>Validation</th><th>Actions</th></tr></thead>
                <tbody>{d.versions.map((v) => (
                  <tr key={v.version}>
                    <td><button className="link" onClick={() => setSelected(v.version)}>v{v.version}</button>{v.builtIn && <div className="small muted">built-in baseline</div>}
                      {d.active.version === v.version && d.active.runnable && <div className="small"><span className="badge b-verified">running</span></div>}</td>
                    <td><StatusPill status={v.status} /></td>
                    <td className="small">{v.author}{v.reviewedBy && <> · reviewed by {v.reviewedBy}</>}{v.reviewRationale && <div className="muted">“{v.reviewRationale}”</div>}</td>
                    <td className="small">{v.validation ? `${v.validation.fixtures.passed}/${v.validation.fixtures.total} fixtures` : v.builtIn ? 'baseline' : '—'}</td>
                    <td><div className="gap8">
                      {d.permissions.author && v.status !== 'retired' && <button onClick={() => newDraft(v.version)}>New draft</button>}
                      {!v.builtIn && <button onClick={() => showImpact(`/api/rule-studio/packs/${ruleId}/versions/${v.version}/impact`)}>Impact</button>}
                      {d.permissions.author && v.status === 'validated' && <button className="primary" onClick={() => setDialog({ kind: 'submit', version: v.version })}>Submit for review</button>}
                      {d.permissions.approve && v.status === 'in_review' && <><button className="primary" onClick={() => setDialog({ kind: 'approve', version: v.version })}>Approve</button><button className="danger" onClick={() => setDialog({ kind: 'reject', version: v.version })}>Reject</button></>}
                      {d.permissions.approve && v.status === 'approved' && !activated.has(v.version) && <button className="primary" onClick={() => setDialog({ kind: 'publish', version: v.version })}>Publish</button>}
                      {d.permissions.approve && v.status === 'approved' && activated.has(v.version) && d.active.version !== v.version && <button onClick={() => setDialog({ kind: 'rollback', version: v.version })}>Roll back to</button>}
                      {d.permissions.approve && v.status !== 'retired' && <button className="danger" onClick={() => setDialog({ kind: 'retire', version: v.version })}>Retire</button>}
                    </div></td>
                  </tr>))}
                </tbody>
              </table>
            </div>
            {!d.permissions.author && !d.permissions.approve && <p className="small muted" style={{ marginTop: 8 }}>Read-only: your role can view rule packs but not author or approve them.</p>}
          </Panel>

          {d.drafts.filter((x) => x.status === 'editing').length > 0 && (
            <Panel title="Open drafts">
              <ul style={{ margin: 0, paddingLeft: 18 }}>{d.drafts.filter((x) => x.status === 'editing').map((x) => (
                <li key={x.draftId}><button className="link" onClick={() => { setDraftId(x.draftId); setImpact(null); }}>{x.draftId}</button> <span className="small muted">from v{x.baseVersion} · {x.author} · {when(x.updatedAt)}</span></li>))}</ul>
            </Panel>
          )}

          {openDraft && <DraftEditor key={openDraft.draftId + openDraft.editSeq} draft={openDraft} detail={d} canAuthor={d.permissions.author}
            onChanged={async (dr) => { await load(); setDraftId(dr?.draftId ?? null); }} onImpact={() => showImpact(`/api/rule-studio/drafts/${openDraft.draftId}/impact`)} />}

          {impact && <ImpactPanel impact={impact} onClose={() => setImpact(null)} />}

          <DefinitionPanel def={def} version={version} detail={d} />
        </div>
        <div>
          <FixturePanel ruleId={ruleId} def={def} label={`v${version.version}`} />
          <Panel title="Activation history">
            {d.activations.length === 0 ? <p className="muted small">No activations in this client. {d.environment === 'synthetic' ? 'The built-in draft baseline runs because the environment is synthetic.' : ''}</p> : (
              <table><thead><tr><th>Version</th><th>Kind</th><th>Active from</th><th>By</th></tr></thead>
                <tbody>{d.activations.map((a) => <tr key={a.activation_id}><td>v{a.version}{a.previous_version !== null && <span className="small muted"> (was v{a.previous_version})</span>}</td><td>{a.kind}</td><td className="small">{when(a.active_from)}</td><td className="small">{a.activated_by}<div className="muted">{a.reason}</div></td></tr>)}</tbody></table>
            )}
            {d.retirements.length > 0 && <p className="small" style={{ marginTop: 8 }}>Retired here: {d.retirements.map((r) => `v${r.version} by ${r.retired_by} (${r.reason})`).join('; ')}</p>}
          </Panel>
        </div>
      </div>
      {dialog && <LifecycleDialog dialog={dialog} ruleId={ruleId} onClose={() => setDialog(null)} onDone={async () => { setDialog(null); await load(); }} />}
    </>
  );
}

function DefinitionPanel({ def, version, detail }: { def: RuleDefinition; version: VersionSummary; detail: Detail }) {
  const labels = { ...detail.outcomeLabels, ...(def.outcomeLabels ?? {}) };
  return (
    <Panel title={`Definition v${def.version}`}>
      <dl className="kv">
        <dt>Scope</dt><dd>tenant {def.scope.tenant} · client {def.scope.client} · payer {def.scope.payer} · plan {def.scope.plan} · {def.scope.claimType}</dd>
        <dt>Effective</dt><dd>{def.effectiveFrom} to {def.effectiveThrough}</dd>
        <dt>Logic</dt><dd className="mono">{def.logicModule}</dd>
        <dt>Owner</dt><dd>{def.owner}</dd>
        <dt>Definition hash</dt><dd className="mono">{version.sha256.slice(0, 24)}…</dd>
        <dt>Follow-up source</dt><dd className="small">{def.followUpSource}</dd>
        {detail.paramSpecs.map((p) => <Fragment key={p.key}><dt>{p.label}</dt><dd>{def.params?.[p.key]} {p.unit}<div className="small muted">{p.description}</div></dd></Fragment>)}
      </dl>
      <h3 style={{ marginTop: 16 }}>Required facts</h3>
      <table><thead><tr><th>Fact</th><th>Accepted statuses</th></tr></thead>
        <tbody>{def.requiredFacts.map((f) => <tr key={f.key}><td>{f.label}{f.optional && <span className="small muted"> · optional (absence is a handled branch)</span>}<div className="small muted mono">{f.key}</div></td><td className="small">{f.acceptedStatuses.join(', ')}</td></tr>)}</tbody></table>
      <h3 style={{ marginTop: 16 }}>Actions</h3>
      <table><thead><tr><th>Outcome</th><th>Risk class</th><th>Connector</th><th>Approve label</th></tr></thead>
        <tbody>{def.actions.map((a) => <tr key={a.kind}><td>{labels[a.kind] ?? a.kind}<div className="small muted mono">{a.kind}</div></td><td className="small">{a.risk.replace(/_/g, ' ')}</td><td className="small">{a.connector ?? 'none (abstain)'}</td><td className="small">{a.approveLabel ?? '—'}</td></tr>)}</tbody></table>
      <h3 style={{ marginTop: 16 }}>Branches (reviewed code, shown for reading)</h3>
      <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>{detail.branches.map((b, i) => <li key={i}>{b.when} → <b>{labels[b.propose] ?? b.propose}</b></li>)}</ol>
      <h3 style={{ marginTop: 16 }}>Hard stops</h3>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{(def.hardStops ?? detail.hardStops).map((h) => <li key={h}>{h}</li>)}</ul>
      <p className="small" style={{ marginTop: 8 }}>Prohibited: {def.prohibitedActions.join(', ').replace(/_/g, ' ')}</p>
      <p className="small muted">Assumptions: {def.supportedAssumptions.join(' · ')}</p>
      <p className="small muted">Sources: {def.sources.join(' · ')}</p>
    </Panel>
  );
}

function FixturePanel({ ruleId, def, label }: { ruleId: string; def: RuleDefinition; label: string }) {
  const [ran, setRan] = useState<FixtureRow[] | null>(null);
  const mod = moduleForRule(ruleId)!;
  const fixtures = FIXTURES[mod.fixtureFile] ?? [];
  useEffect(() => { setRan(null); }, [def]);
  const failures = ran?.filter((r) => !r.pass) ?? [];
  return (
    <Panel title="Fixture evaluation" actions={<button className="primary" onClick={() => setRan(runFixtures(mod, fixtures, def))}>Run {fixtures.length} fixtures on {label}</button>}>
      {!ran ? <p className="muted small">Runs the pack's synthetic fixtures through the same engine module the server uses, in your browser. Labels are synthetic and not customer-approved; this checks mechanics, not payer policy.</p> : (
        <>
          <div className={`callout ${failures.length ? 'danger' : 'ok'}`} style={{ marginBottom: 12 }}>{ran.length - failures.length} of {ran.length} match. {failures.length ? `${failures.length} differ.` : 'No differences.'}</div>
          <div className="table-wrap">
            <table><thead><tr><th>Case</th><th>Expected</th><th>Actual</th></tr></thead>
              <tbody>{ran.map((r) => (
                <tr key={r.id}><td>{r.id}<div className="small muted">{r.name} · {r.category}{r.severity === 'critical' ? ' · critical' : ''}</div></td><td className="small">{r.expected}</td>
                  <td className="small"><span className={`badge ${r.pass ? 'b-verified' : 'b-danger'}`}>{r.actual}</span><div className="muted">{r.reasonCodes.map(mod.reasonLabel).join('; ')}</div></td></tr>))}
              </tbody></table>
          </div>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- draft editor

const STATUSES = ['verified', 'reported', 'inferred'] as const;

function DraftEditor({ draft, detail, canAuthor, onChanged, onImpact }: { draft: Draft; detail: Detail; canAuthor: boolean; onChanged: (d: Draft | null) => Promise<void>; onImpact: () => void }) {
  const base = draft.definition;
  const [scope, setScope] = useState({ payer: base.scope.payer, plan: base.scope.plan, claimType: base.scope.claimType });
  const [from, setFrom] = useState(base.effectiveFrom);
  const [through, setThrough] = useState(base.effectiveThrough);
  const [owner, setOwner] = useState(base.owner);
  const [followUp, setFollowUp] = useState(base.followUpSource);
  const [params, setParams] = useState<Record<string, string>>(Object.fromEntries(detail.paramSpecs.map((p) => [p.key, String(base.params?.[p.key] ?? '')])));
  const [facts, setFacts] = useState<Record<string, string[]>>(Object.fromEntries(base.requiredFacts.map((f) => [f.key, [...f.acceptedStatuses]])));
  const [outcomeLabels, setOutcomeLabels] = useState<Record<string, string>>({ ...detail.outcomeLabels, ...(base.outcomeLabels ?? {}) });
  const [approveLabels, setApproveLabels] = useState<Record<string, string>>(Object.fromEntries(base.actions.filter((a) => a.risk !== 'abstain').map((a) => [a.kind, a.approveLabel ?? ''])));
  const [assumptions, setAssumptions] = useState(base.supportedAssumptions.join('\n'));
  const [sources, setSources] = useState(base.sources.join('\n'));
  const [prohibited, setProhibited] = useState(base.prohibitedActions.join('\n'));
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ValidationReport | null>(draft.lastValidation);
  const editable = canAuthor && draft.status === 'editing';
  const mod = moduleForRule(draft.ruleId)!;
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

  const patch = () => {
    const changedLabels = Object.fromEntries(Object.entries(outcomeLabels).filter(([k, v]) => v !== (base.outcomeLabels?.[k] ?? detail.outcomeLabels[k])));
    const p: Record<string, unknown> = {
      scope, effectiveFrom: from, effectiveThrough: through, owner, followUpSource: followUp,
      requiredFacts: Object.entries(facts).map(([key, acceptedStatuses]) => ({ key, acceptedStatuses })),
      approveLabels, supportedAssumptions: lines(assumptions), sources: lines(sources), prohibitedActions: lines(prohibited),
    };
    if (detail.paramSpecs.length) p.params = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Number(v)]));
    if (Object.keys(changedLabels).length) p.outcomeLabels = changedLabels;
    return p;
  };
  // Local preview: the same validator the server runs, against the would-be definition.
  const preview = () => {
    const d: RuleDefinition = JSON.parse(JSON.stringify(base));
    Object.assign(d.scope, scope);
    d.effectiveFrom = from; d.effectiveThrough = through; d.owner = owner; d.followUpSource = followUp;
    if (detail.paramSpecs.length) d.params = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Number(v)]));
    d.requiredFacts = d.requiredFacts.map((f) => ({ ...f, acceptedStatuses: facts[f.key] as never }));
    setReport(validateDefinition(d, mod, FIXTURES[mod.fixtureFile] ?? [], { tenant: base.scope.tenant, client: base.scope.client }));
  };
  const save = async () => {
    setBusy(true); setErrors([]);
    try { await api.post(`/api/rule-studio/drafts/${draft.draftId}/edit`, { patch: patch(), expectedEditSeq: draft.editSeq }); toast('Draft saved'); await onChanged(draft); }
    catch (e) { const det = (e as { details?: { errors?: string[] } }).details; setErrors(det?.errors ?? [errorText(e)]); }
    finally { setBusy(false); }
  };
  const validate = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; report: ValidationReport; version: number | null }>(`/api/rule-studio/drafts/${draft.draftId}/validate`);
      setReport(r.report);
      toast(r.ok ? `Validated and frozen as v${r.version}. Submit it for review.` : 'Validation failed: see the report', !r.ok);
      await onChanged(r.ok ? null : draft);
    } catch (e) { toast(errorText(e), true); } finally { setBusy(false); }
  };
  const withdraw = async () => {
    try { await api.post(`/api/rule-studio/drafts/${draft.draftId}/withdraw`); toast('Draft withdrawn'); await onChanged(null); } catch (e) { toast(errorText(e), true); }
  };

  return (
    <Panel title={`Draft ${draft.draftId} (from v${draft.baseVersion})`} actions={<span className="small muted">edit {draft.editSeq} · {draft.author}</span>}>
      <p className="small muted" style={{ marginBottom: 12 }}>Data fields only. Logic, branches, actions, risk classes and connectors are reviewed code and cannot be edited here. Tenant and client come from your signed-in scope.</p>
      <fieldset disabled={!editable} className="rs-form">
        <div className="rs-grid">
          <div><label htmlFor="rs-payer">Payer</label><input id="rs-payer" value={scope.payer} onChange={(e) => setScope({ ...scope, payer: e.target.value })} /></div>
          <div><label htmlFor="rs-plan">Plan</label><input id="rs-plan" value={scope.plan} onChange={(e) => setScope({ ...scope, plan: e.target.value })} /></div>
          <div><label htmlFor="rs-ct">Claim type</label><input id="rs-ct" value={scope.claimType} onChange={(e) => setScope({ ...scope, claimType: e.target.value })} /></div>
          <div><label htmlFor="rs-from">Effective from</label><input id="rs-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label htmlFor="rs-thru">Effective through</label><input id="rs-thru" type="date" value={through} onChange={(e) => setThrough(e.target.value)} /></div>
          <div><label htmlFor="rs-owner">Owner</label><input id="rs-owner" value={owner} onChange={(e) => setOwner(e.target.value)} /></div>
          {detail.paramSpecs.map((p) => (
            <div key={p.key}><label htmlFor={`rs-p-${p.key}`}>{p.label} ({p.unit}, {p.min}–{p.max})</label>
              <input id={`rs-p-${p.key}`} type="number" min={p.min} max={p.max} step={1} value={params[p.key]} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })} /></div>
          ))}
        </div>
        <div><label htmlFor="rs-fu">Follow-up source</label><textarea id="rs-fu" value={followUp} onChange={(e) => setFollowUp(e.target.value)} /></div>
        <h3 style={{ marginTop: 12 }}>Accepted fact statuses</h3>
        <table><tbody>{base.requiredFacts.map((f) => (
          <tr key={f.key}><td className="small">{f.label}</td><td><div className="gap8">{STATUSES.map((s) => (
            <label key={s} className="small rs-check"><input type="checkbox" checked={facts[f.key].includes(s)} onChange={(e) => setFacts({ ...facts, [f.key]: e.target.checked ? [...facts[f.key], s] : facts[f.key].filter((x) => x !== s) })} /> {s}</label>
          ))}</div></td></tr>))}</tbody></table>
        <h3 style={{ marginTop: 12 }}>Labels</h3>
        <table><tbody>{base.actions.map((a) => (
          <tr key={a.kind}><td className="small mono">{a.kind}</td>
            <td><label className="sr" htmlFor={`rs-ol-${a.kind}`}>Outcome label for {a.kind}</label><input id={`rs-ol-${a.kind}`} value={outcomeLabels[a.kind] ?? ''} onChange={(e) => setOutcomeLabels({ ...outcomeLabels, [a.kind]: e.target.value })} /></td>
            <td>{a.risk !== 'abstain' && <><label className="sr" htmlFor={`rs-al-${a.kind}`}>Approve button label for {a.kind}</label><input id={`rs-al-${a.kind}`} value={approveLabels[a.kind] ?? ''} onChange={(e) => setApproveLabels({ ...approveLabels, [a.kind]: e.target.value })} /></>}</td></tr>))}</tbody></table>
        <div className="rs-grid" style={{ marginTop: 12 }}>
          <div><label htmlFor="rs-as">Supported assumptions (one per line)</label><textarea id="rs-as" value={assumptions} onChange={(e) => setAssumptions(e.target.value)} /></div>
          <div><label htmlFor="rs-src">Sources (one per line)</label><textarea id="rs-src" value={sources} onChange={(e) => setSources(e.target.value)} /></div>
          <div><label htmlFor="rs-pro">Prohibited actions (one per line; reviewed ones cannot be removed)</label><textarea id="rs-pro" value={prohibited} onChange={(e) => setProhibited(e.target.value)} /></div>
        </div>
      </fieldset>
      {errors.length > 0 && <div className="callout danger" style={{ marginTop: 12 }}><b>Edit rejected</b><ul style={{ margin: 0, paddingLeft: 18 }}>{errors.map((x) => <li key={x}>{x}</li>)}</ul></div>}
      <div className="gap8" style={{ marginTop: 12 }}>
        {editable && <button onClick={save} disabled={busy}>Save draft</button>}
        <button onClick={preview}>Preview validation locally</button>
        <button onClick={onImpact}>Before/after impact</button>
        {editable && <button className="primary" onClick={validate} disabled={busy}>Validate and freeze</button>}
        {editable && <button className="danger" onClick={withdraw}>Withdraw</button>}
      </div>
      {draft.diff && draft.diff.length > 0 && (
        <details open style={{ marginTop: 12 }}><summary>Saved changes vs v{draft.baseVersion} ({draft.diff.length})</summary>
          <table style={{ marginTop: 8 }}><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
            <tbody>{draft.diff.map((x) => <tr key={x.path}><td className="mono">{x.path}</td><td className="small">{fmtVal(x.before)}</td><td className="small">{fmtVal(x.after)}</td></tr>)}</tbody></table>
        </details>
      )}
      {report && <ReportView report={report} />}
    </Panel>
  );
}

function fmtVal(v: unknown) {
  if (v === undefined) return '—';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function ReportView({ report }: { report: ValidationReport }) {
  return (
    <div className={`callout ${report.ok ? 'ok' : 'danger'}`} style={{ marginTop: 12 }}>
      <b>{report.ok ? 'Validation passed' : 'Validation failed'}</b>
      <div className="small">Schema (build pack rule.schema.json): {report.schema.ok ? 'ok' : report.schema.errors.map((e) => `${e.path} ${e.message}`).join('; ')}</div>
      <div className="small">Logic-module compatibility: {report.compatibility.ok ? 'ok' : report.compatibility.errors.join('; ')}</div>
      <div className="small">Fixtures: {report.fixtures.passed}/{report.fixtures.total}{report.fixtures.failures.length > 0 && ` · failing ${report.fixtures.failures.map((f) => `${f.id} (expected ${f.expected}, got ${f.actual})`).join(', ')}`}</div>
    </div>
  );
}

function ImpactPanel({ impact, onClose }: { impact: Impact; onClose: () => void }) {
  return (
    <Panel title={`Before/after: ${impact.candidate} vs ${impact.current.version ? `v${impact.current.version}` : 'nothing runnable'}`} actions={<button onClick={onClose}>Close</button>}>
      <div className="metrics">
        <div className="panel metric"><strong>{impact.fixtures.changed}</strong><span className="small">fixture outcomes change</span></div>
        <div className="panel metric"><strong>{impact.fixtures.failing}</strong><span className="small">fixtures would fail</span></div>
        <div className="panel metric"><strong>{impact.accounts.newlyAutomated}</strong><span className="small">newly proposed actions</span></div>
        <div className="panel metric"><strong>{impact.accounts.newlyBlocked}</strong><span className="small">newly abstaining</span></div>
        <div className="panel metric"><strong>{impact.accounts.changed}/{impact.accounts.considered}</strong><span className="small">current accounts change</span></div>
      </div>
      {impact.fixtures.rows.length > 0 && (
        <table style={{ marginBottom: 12 }}><thead><tr><th>Fixture</th><th>Before</th><th>After</th><th>Expected</th></tr></thead>
          <tbody>{impact.fixtures.rows.map((r) => <tr key={r.id}><td>{r.id}<div className="small muted">{r.name}</div></td><td className="small">{r.before ?? '—'}</td><td className="small">{r.after}</td><td className="small">{r.expected} {r.pass ? '' : <span className="badge b-danger">fails</span>}</td></tr>)}</tbody></table>
      )}
      {impact.accounts.rows.length === 0 ? <p className="small muted">No investigated account in this client changes outcome or reasons.</p> : (
        <table><thead><tr><th>Account</th><th>Before</th><th>After</th><th>Change</th></tr></thead>
          <tbody>{impact.accounts.rows.map((r) => (
            <tr key={r.accountId}><td><button className="link" onClick={() => go(`/account/${r.accountId}`)}>{r.externalId}</button>{r.pinned && <div className="small muted">pinned to v{r.pinned.version} while action is {r.pinned.actionState}</div>}</td>
              <td className="small">{r.before ?? '—'}<div className="muted">{r.beforeReasons.join(', ')}</div></td><td className="small">{r.after}<div className="muted">{r.afterReasons.join(', ')}</div></td>
              <td><span className={`badge ${r.change === 'newly_automated' ? 'b-review' : r.change === 'newly_blocked' ? 'b-danger' : 'b-neutral'}`}>{r.change.replace(/_/g, ' ')}</span></td></tr>))}
          </tbody></table>
      )}
      <p className="small muted" style={{ marginTop: 8 }}>{impact.note}</p>
    </Panel>
  );
}

const DIALOG_TEXT: Record<Dialog['kind'], [string, string, string]> = {
  submit: ['Submit for review', 'A different user with the rule approver permission must review it.', ''],
  approve: ['Approve version', 'Re-runs validation. You cannot approve a version you authored or submitted.', 'Review rationale'],
  reject: ['Reject version', 'The author can start a new draft from the base version.', 'Review rationale'],
  publish: ['Publish version', 'Creates an append-only activation for this client only. New evaluations use it from the activation time; in-flight cases stay pinned.', 'Publication reason'],
  rollback: ['Roll back to this version', 'Creates a new activation of this earlier approved version. Historical runs keep their original version.', 'Rollback reason'],
  retire: ['Retire version', 'Stops new runs on this version in this client. Pending proposals on it can no longer be approved. Retirement is final.', 'Retirement reason'],
};

function LifecycleDialog({ dialog, ruleId, onClose, onDone }: { dialog: Dialog; ruleId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [activeFrom, setActiveFrom] = useState('');
  const [err, setErr] = useState('');
  const [title, help, field] = DIALOG_TEXT[dialog.kind];
  const submit = async () => {
    const base = `/api/rule-studio/packs/${ruleId}/versions/${dialog.version}`;
    try {
      if (dialog.kind === 'submit') await api.post(`${base}/submit`);
      else if (dialog.kind === 'approve' || dialog.kind === 'reject') await api.post(`${base}/review`, { decision: dialog.kind, rationale: text });
      else if (dialog.kind === 'publish') await api.post(`${base}/publish`, { reason: text, activeFrom: activeFrom ? new Date(activeFrom).toISOString() : undefined });
      else await api.post(`${base}/${dialog.kind}`, { reason: text });
      toast(`${title}: done`);
      await onDone();
    } catch (e) { setErr(errorText(e)); }
  };
  return (
    <Overlay kind="dialog" label={title} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2>{title}: {ruleId} v{dialog.version}</h2>
        <p className="small muted">{help}</p>
        {field && <div><label htmlFor="lc-text">{field} (required)</label><textarea id="lc-text" value={text} onChange={(e) => setText(e.target.value)} /></div>}
        {dialog.kind === 'publish' && <div><label htmlFor="lc-from">Activation time (optional; default now)</label><input id="lc-from" type="datetime-local" value={activeFrom} onChange={(e) => setActiveFrom(e.target.value)} /></div>}
        {err && <div className="callout danger">{err}</div>}
        <div className="gap8"><button className="primary" type="submit" disabled={!!field && text.trim().length < 5}>{title}</button><button type="button" onClick={onClose}>Cancel</button></div>
      </form>
    </Overlay>
  );
}
