import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, errorText } from '../api.ts';
import { Heading, Panel } from '../ui.tsx';
import { CodeExplain, CodeStatus, DESC_NOTE, codeHref } from '../kb.tsx';

type Tab = 'search' | 'explain' | 'playbooks' | 'articles' | 'glossary' | 'codes' | 'payers' | 'sources';
const TABS: [Tab, string][] = [['search', 'Search'], ['explain', 'Explain adjustment'], ['playbooks', 'Playbooks'], ['articles', 'Articles'], ['glossary', 'Glossary'], ['codes', 'Code lists'], ['payers', 'Payer directory'], ['sources', 'Sources']];
const KINDS: [string, string][] = [['code', 'Codes'], ['article', 'Articles'], ['playbook', 'Playbooks'], ['glossary', 'Glossary'], ['payer', 'Payers']];
const CODE_TYPES: [string, string][] = [['carc', 'CARC'], ['rarc', 'RARC'], ['group', 'Group codes'], ['claim_status_category', '277 status categories'], ['claim_status', '277 status codes']];

interface Hit { kind: string; ref: string; title: string; snippet: string; codeType?: string; code?: string; status?: string }
interface Citation { source: string; url: string; locator: string; retrievedAt: string }

function useLoad<T>(path: string | null): [T | null, string] {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!path) return;
    setData(null); setErr('');
    api.get<T>(path).then(setData).catch((e) => setErr(errorText(e)));
  }, [path]);
  return [data, err];
}

function hitHref(h: Hit) {
  if (h.kind === 'code') return codeHref(h.codeType!, h.code!);
  if (h.kind === 'glossary') return `#/knowledge/glossary:${h.ref}`;
  return `#/knowledge/${h.kind}:${encodeURIComponent(h.ref)}`;
}

function Snippet({ text }: { text: string }) {
  // FTS snippets mark matches with [ ]; render them as <mark> without HTML injection.
  const parts = text.split(/(\[[^\]]*\])/g);
  return <>{parts.map((p, i) => p.startsWith('[') && p.endsWith(']') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>)}</>;
}

function ExtLink({ url, children }: { url: string; children: ReactNode }) {
  if (!/^https:\/\//.test(url)) return <span className="mono">{children}</span>;
  return <a href={url} target="_blank" rel="noreferrer noopener">{children}</a>;
}

function Cite({ c }: { c: Citation }) {
  return <span className="small muted kb-cite"><ExtLink url={c.url}>{c.source}</ExtLink>{c.locator ? `, ${c.locator}` : ''} · retrieved {c.retrievedAt}</span>;
}

function SearchView() {
  const [q, setQ] = useState('');
  const [kinds, setKinds] = useState<string[]>([]);
  const [res, setRes] = useState<{ engine: string; results: Hit[] } | null>(null);
  const [err, setErr] = useState('');
  const run = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    try { setErr(''); setRes(await api.get(`/api/kb/search?q=${encodeURIComponent(q)}${kinds.length ? `&types=${kinds.join(',')}` : ''}`)); } catch (x) { setErr(errorText(x)); }
  };
  useEffect(() => { if (q.trim()) run(); /* re-run on filter change */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds]);
  return (
    <Panel title="Search the knowledge base">
      <form onSubmit={run} className="row" role="search">
        <label htmlFor="kbq" className="sr">Search</label>
        <input id="kbq" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Try: deductible, 197, N130, timely filing, crossover" className="kb-search" />
        <button className="primary" type="submit">Search</button>
      </form>
      <div className="tabs" role="group" aria-label="Filter by type" style={{ marginTop: 12 }}>
        {KINDS.map(([k, label]) => (
          <button key={k} aria-pressed={kinds.includes(k)} onClick={() => setKinds((v) => v.includes(k) ? v.filter((x) => x !== k) : [...v, k])}>{label}</button>
        ))}
      </div>
      {err && <div className="callout danger">{err}</div>}
      {res && (
        <>
          <p className="small muted">{res.results.length} result{res.results.length === 1 ? '' : 's'} · {res.engine === 'fts5' ? 'full-text index' : 'substring match'}</p>
          <ul className="kb-results">
            {res.results.map((h) => (
              <li key={`${h.kind}:${h.ref}`}>
                <div className="row"><a href={hitHref(h)}><strong>{h.title}</strong></a><span className="gap8"><span className="badge b-neutral">{h.kind}</span>{h.status && <CodeStatus status={h.status} />}</span></div>
                <div className="small"><Snippet text={h.snippet} /></div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function ExplainView() {
  const [form, setForm] = useState({ group: 'PR', carc: '1', rarcs: '' });
  const [shown, setShown] = useState(form);
  return (
    <Panel title="Explain an adjustment">
      <form className="kb-explain-form" onSubmit={(e) => { e.preventDefault(); setShown(form); }}>
        <label>Group<select value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })}>{['CO', 'PR', 'OA', 'PI', 'CR'].map((g) => <option key={g}>{g}</option>)}</select></label>
        <label>CARC<input value={form.carc} onChange={(e) => setForm({ ...form, carc: e.target.value })} maxLength={8} /></label>
        <label>RARCs (comma separated)<input value={form.rarcs} onChange={(e) => setForm({ ...form, rarcs: e.target.value })} placeholder="M15, N19" /></label>
        <button className="primary" type="submit">Explain</button>
      </form>
      <div style={{ marginTop: 16 }}><CodeExplain group={shown.group} carc={shown.carc} rarcs={shown.rarcs.split(',').map((x) => x.trim()).filter(Boolean)} /></div>
    </Panel>
  );
}

interface PbSummary { id: string; title: string; objective: string; executable: string | null; routes: { carcs: string[]; groups: string[] | null; rarcs: string[]; requiresRarc: boolean }[] }
function PlaybooksView() {
  const [list, err] = useLoad<PbSummary[]>('/api/kb/playbooks');
  if (err) return <div className="callout danger">{err}</div>;
  if (!list) return <p className="muted">Loading…</p>;
  return (
    <Panel title="Scenario playbooks">
      <div className="callout" style={{ marginBottom: 12 }}>Drafts from build pack doc 05. Code routing is a draft and needs business sign-off. Only DED01 has an executable (draft) rule.</div>
      <table><thead><tr><th>Pack</th><th>Routed from</th><th>Status</th></tr></thead>
        <tbody>{list.map((p) => (
          <tr key={p.id}><td><a href={`#/knowledge/playbook:${p.id}`}><strong>{p.id}</strong> · {p.title}</a><div className="small muted">{p.objective}</div></td>
            <td className="small">{p.routes.map((r, i) => <div key={i}>CARC {r.carcs.join(', ')}{r.groups ? ` (${r.groups.join('/')})` : ''}{r.rarcs.length ? ` · RARC ${r.rarcs.join(', ')}${r.requiresRarc ? ' required' : ''}` : ''}</div>)}</td>
            <td><span className="badge b-review">draft</span>{p.executable && <div className="small muted">{p.executable}</div>}</td></tr>))}
        </tbody></table>
    </Panel>
  );
}

function PlaybookDetail({ id }: { id: string }) {
  const [p, err] = useLoad<any>(`/api/kb/playbooks/${encodeURIComponent(id)}`);
  if (err) return <div className="callout danger">{err}</div>;
  if (!p) return <p className="muted">Loading…</p>;
  const list = (xs: string[]) => <ul className="small">{xs.map((x) => <li key={x}>{x}</li>)}</ul>;
  return (
    <>
      <Heading eyebrow={`Playbook · ${p.reviewStatus}`} title={`${p.id} · ${p.title}`} subtitle={p.objective} />
      <div className="callout" style={{ marginBottom: 12 }}>{p.approvalRequired} Source: {p.source.replace('build-pack:', 'build pack ')}.</div>
      <div className="grid2">
        <div className="stack">
          <Panel title="Required evidence">{list(p.requiredEvidence)}</Panel>
          <Panel title="Permitted proposals">{list(p.permittedProposals)}</Panel>
          <Panel title="Hard stops"><ul className="small kb-hardstops">{p.hardStops.map((x: string) => <li key={x}>{x}</li>)}</ul></Panel>
          <Panel title="Routed from (draft)">
            {p.routes.map((r: any, i: number) => (
              <div key={i} className="small" style={{ marginBottom: 6 }}>
                CARC {r.carcs.map((c: string) => <a key={c} href={codeHref('carc', c)} className="mono" style={{ marginRight: 6 }}>{c}</a>)}
                {r.groups && <> under {r.groups.join('/')}</>}
                {r.rarcs.length > 0 && <> · RARC {r.rarcs.map((c: string) => <a key={c} href={codeHref('rarc', c)} className="mono" style={{ marginRight: 6 }}>{c}</a>)}{r.requiresRarc ? '(required)' : '(corroborating)'}</>}
                <div className="muted">{r.note}</div>
              </div>))}
          </Panel>
        </div>
        <div className="stack">
          {p.branches && (
            <Panel title="Branches">
              <table><thead><tr><th>Condition</th><th>Proposal</th><th>Boundary</th></tr></thead>
                <tbody>{p.branches.map((b: any) => <tr key={b.condition}><td className="small">{b.condition}</td><td className="small">{b.proposal}</td><td className="small">{b.boundary}</td></tr>)}</tbody></table>
              {p.formula && <p className="small muted" style={{ marginTop: 8 }}>{p.formula}</p>}
            </Panel>
          )}
          <Panel title="Call question plan"><ol className="small">{p.callPlan.map((x: string) => <li key={x}>{x}</li>)}</ol></Panel>
          <Panel title="Note template"><div className="note">{p.noteTemplate}</div></Panel>
        </div>
      </div>
    </>
  );
}

function ArticlesView() {
  const [list, err] = useLoad<{ id: string; title: string; summary: string; applicability: string[]; reviewStatus: string }[]>('/api/kb/articles');
  if (err) return <div className="callout danger">{err}</div>;
  if (!list) return <p className="muted">Loading…</p>;
  return (
    <Panel title="Regulatory and process reference">
      <ul className="kb-results">{list.map((a) => (
        <li key={a.id}><div className="row"><a href={`#/knowledge/article:${a.id}`}><strong>{a.title}</strong></a><span className="gap8">{a.applicability.map((x) => <span key={x} className="badge b-neutral">{x}</span>)}<span className="badge b-review">{a.reviewStatus}</span></span></div>
          <div className="small">{a.summary}</div></li>))}</ul>
    </Panel>
  );
}

function ArticleDetail({ id }: { id: string }) {
  const [a, err] = useLoad<any>(`/api/kb/articles/${encodeURIComponent(id)}`);
  if (err) return <div className="callout danger">{err}</div>;
  if (!a) return <p className="muted">Loading…</p>;
  return (
    <>
      <Heading eyebrow={`Article · ${a.reviewStatus} · ${a.applicability.join(', ')}`} title={a.title} subtitle={a.summary} />
      <div className="callout" style={{ marginBottom: 12 }}>Draft summary for orientation. It needs compliance review before it informs any live action. Each fact links to the page it came from.</div>
      <Panel title="Key facts">
        <ol className="kb-facts">{a.facts.map((f: { text: string; citation: Citation }, i: number) => <li key={i}><div>{f.text}</div><Cite c={f.citation} /></li>)}</ol>
      </Panel>
      {a.caveats?.length > 0 && <Panel title="Caveats"><ul className="small">{a.caveats.map((c: string) => <li key={c}>{c}</li>)}</ul></Panel>}
    </>
  );
}

function GlossaryView({ focus }: { focus?: string }) {
  const [list, err] = useLoad<{ id: string; term: string; definition: string; links: { label: string; url: string }[] }[]>('/api/kb/glossary');
  useEffect(() => { if (list && focus) document.getElementById(`g-${focus}`)?.scrollIntoView({ block: 'center' }); }, [list, focus]);
  if (err) return <div className="callout danger">{err}</div>;
  if (!list) return <p className="muted">Loading…</p>;
  return (
    <Panel title="Glossary">
      <dl className="kb-glossary">{list.map((g) => (
        <div key={g.id} id={`g-${g.id}`} className={focus === g.id ? 'kb-focus' : undefined}>
          <dt>{g.term}</dt>
          <dd>{g.definition}{g.links.length > 0 && <span className="small muted"> Source: {g.links.map((l, i) => <span key={l.url + i}>{i ? '; ' : ''}<ExtLink url={l.url}>{l.label}</ExtLink></span>)}</span>}</dd>
        </div>))}</dl>
    </Panel>
  );
}

function CodesView() {
  const [type, setType] = useState('carc');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [d, err] = useLoad<{ total: number; page: number; pageSize: number; items: { code: string; description: string | null; descriptionStatus: string; status: string; startDate: string | null; stopDate: string | null }[] }>(
    `/api/kb/codes?type=${type}&page=${page}&pageSize=50${status ? `&status=${status}` : ''}`);
  return (
    <Panel title="Code lists">
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="tabs" role="group" aria-label="Code list">{CODE_TYPES.map(([k, l]) => <button key={k} aria-pressed={type === k} onClick={() => { setType(k); setPage(1); }}>{l}</button>)}</div>
        <label className="small">Status <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All</option><option value="current">Current</option><option value="deactivated">Deactivated</option><option value="unverified">Unverified</option></select></label>
      </div>
      {err && <div className="callout danger">{err}</div>}
      {!d ? <p className="muted">Loading…</p> : (
        <>
          <table><thead><tr><th>Code</th><th>Description</th><th>Status</th><th>Start</th><th>Stop</th></tr></thead>
            <tbody>{d.items.map((c) => (
              <tr key={c.code}><td className="mono"><a href={codeHref(type, c.code)}>{c.code}</a></td>
                <td className="small">{c.description ?? <span className="muted">—</span>}<div className="muted">{DESC_NOTE[c.descriptionStatus]}</div></td>
                <td><CodeStatus status={c.status} /></td><td className="small num">{c.startDate ?? '—'}</td><td className="small num">{c.stopDate ?? '—'}</td></tr>))}
            </tbody></table>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="small muted">{d.total} codes · page {d.page} of {Math.max(1, Math.ceil(d.total / d.pageSize))}</span>
            <span className="gap8"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button disabled={page * d.pageSize >= d.total} onClick={() => setPage(page + 1)}>Next</button></span>
          </div>
        </>
      )}
    </Panel>
  );
}

function CodeDetail({ type, code }: { type: string; code: string }) {
  const [c, err] = useLoad<any>(`/api/kb/codes/${type}/${encodeURIComponent(code)}`);
  if (err) return <div className="callout danger">{err}</div>;
  if (!c) return <p className="muted">Loading…</p>;
  return (
    <>
      <Heading eyebrow={`${c.source?.title ?? type} · dataset v${c.datasetVersion}`} title={`${type.toUpperCase().replace(/_/g, ' ')} ${c.code}`} subtitle={c.description ?? 'Full description requires a licensed X12 code-list import.'} />
      <div className="grid2">
        <Panel title="Code record">
          <dl className="kv">
            <dt>Status</dt><dd><CodeStatus status={c.status} />{c.verificationNote && <div className="small muted">{c.verificationNote}</div>}</dd>
            <dt>Description</dt><dd className="small">{DESC_NOTE[c.descriptionStatus] ?? c.descriptionStatus}{c.descriptionSource && <div className="muted">{c.descriptionSource.replace('build-pack:', 'build pack ')}</div>}</dd>
            {c.definition && <><dt>Definition</dt><dd className="small">{c.definition}<div className="muted">{c.definitionSource}</div></dd></>}
            {c.notes && <><dt>Note</dt><dd className="small">{c.notes}</dd></>}
            <dt>Start</dt><dd className="num">{c.startDate ?? '—'}</dd>
            <dt>Last modified</dt><dd className="num">{c.lastModifiedDate ?? '—'}</dd>
            <dt>Stop</dt><dd className="num">{c.stopDate ?? '—'}</dd>
            <dt>Source</dt><dd className="small"><ExtLink url={c.sourceUrl}>{c.sourceUrl}</ExtLink><div className="muted">retrieved {c.source?.retrievedAt}</div></dd>
          </dl>
        </Panel>
        <Panel title="Routing (draft)">
          {c.routes.length ? c.routes.map((r: any) => (
            <div key={r.scenarioId + r.note} className="small" style={{ marginBottom: 8 }}>
              <a href={`#/knowledge/playbook:${r.scenarioId}`}><strong>{r.scenarioId}</strong></a>{r.groups ? ` under ${r.groups.join('/')}` : ''}{r.requiresRarc ? ' (needs a listed RARC)' : ''}
              <div className="muted">{r.note}</div>
            </div>)) : <p className="small muted">No draft routing. Accounts with this code go to specialist review.</p>}
          {c.source?.coverage?.note && <p className="small muted" style={{ marginTop: 12 }}>{c.source.coverage.note}</p>}
        </Panel>
      </div>
    </>
  );
}

function PayersView({ focus }: { focus?: string }) {
  const [list, err] = useLoad<any[]>('/api/kb/payers');
  if (err) return <div className="callout danger">{err}</div>;
  if (!list) return <p className="muted">Loading…</p>;
  const shown = focus ? list.filter((p) => p.payerId === focus) : list;
  const Ivr = ({ nodes }: { nodes: any[] }) => <ul className="small">{nodes.map((n, i) => <li key={i}>Press <span className="mono">{n.press}</span>: {n.prompt}{n.children && <Ivr nodes={n.children} />}</li>)}</ul>;
  return (
    <div className="stack">
      <div className="callout">Synthetic payers for this client only. No real payer phone numbers, payer IDs, policies or turnaround times are stored here.</div>
      {!shown.length && <p className="muted">No payer directory entries for this client.</p>}
      {shown.map((p) => (
        <Panel key={p.payerId} title={<>{p.name} <span className="badge b-review">synthetic</span></>}>
          <p className="small muted">{p.disclaimer}</p>
          <dl className="kv">
            <dt>Payer ID</dt><dd className="mono">{p.payerId}</dd>
            <dt>Channels</dt><dd className="small">{p.channels.map((c: any) => <div key={c.label}>{c.label}: <span className="mono">{c.value}</span>{c.hours ? ` · ${c.hours}` : ''}</div>)}</dd>
            <dt>IVR tree</dt><dd>{p.ivr.length ? <Ivr nodes={p.ivr} /> : <span className="small muted">None recorded</span>}</dd>
            <dt>TAT commitments</dt><dd className="small">{p.tatCommitments.length ? p.tatCommitments.map((t: any) => <div key={t.action}>{t.action.replace(/_/g, ' ')}: {t.value} {t.unit.replace(/_/g, ' ')} ({t.basis})</div>) : <span className="muted">None verified; follow-up cannot be scheduled from a commitment.</span>}</dd>
            <dt>Authentication</dt><dd className="small">{p.authentication.join(', ')}</dd>
            {p.notes && <><dt>Notes</dt><dd className="small">{p.notes}</dd></>}
          </dl>
        </Panel>
      ))}
    </div>
  );
}

function SourcesView() {
  const [d, err] = useLoad<{ searchEngine: string; datasets: any[] }>('/api/kb/sources');
  if (err) return <div className="callout danger">{err}</div>;
  if (!d) return <p className="muted">Loading…</p>;
  return (
    <Panel title="Datasets, versions and provenance">
      <p className="small muted">Search engine: {d.searchEngine}. Each dataset is hashed; a changed file loads as a new version.</p>
      <table><thead><tr><th>Dataset</th><th className="r">Entries</th><th>Version · sha256</th><th>Source</th><th>Coverage</th></tr></thead>
        <tbody>{d.datasets.map((s) => (
          <tr key={s.dataset}><td>{s.title}<div className="small muted mono">{s.dataset}</div></td><td className="r num">{s.count}</td>
            <td className="small mono">v{s.version} · {s.sha256.slice(0, 12)}…</td>
            <td className="small">{s.sourceUrl ? <ExtLink url={s.sourceUrl}>{s.source}</ExtLink> : s.source}<div className="muted">retrieved {s.retrievedAt}</div><div className="muted">{s.method}</div></td>
            <td className="small">{s.coverage.complete ? <span className="badge b-verified">complete</span> : <span className="badge b-review">partial</span>}<div className="muted">{s.coverage.note}</div>{s.license?.policy && <div className="muted">{s.license.policy}</div>}</td></tr>))}
        </tbody></table>
    </Panel>
  );
}

export function Knowledge({ param }: { param?: string }) {
  const [tab, setTab] = useState<Tab>('search');
  const detail = param ? decodeURIComponent(param) : '';
  const [kind, ...rest] = detail.split(':');
  const back = <p className="small" style={{ marginBottom: 12 }}><a href="#/knowledge">← Knowledge base</a></p>;
  if (kind === 'code' && rest.length >= 2) return <>{back}<CodeDetail type={rest[0]} code={rest.slice(1).join(':')} /></>;
  if (kind === 'playbook' && rest[0]) return <>{back}<PlaybookDetail id={rest[0]} /></>;
  if (kind === 'article' && rest[0]) return <>{back}<ArticleDetail id={rest[0]} /></>;
  if (kind === 'glossary' && rest[0]) return <>{back}<GlossaryView focus={rest[0]} /></>;
  if (kind === 'payer' && rest[0]) return <>{back}<PayersView focus={rest[0]} /></>;
  return (
    <>
      <Heading eyebrow="Knowledge" title="Reference knowledge base" subtitle="Sourced code lists, draft scenario playbooks, regulatory notes and a synthetic payer directory. Reference material is evidence for people, not instructions for the system." />
      <div className="tabs" role="tablist" aria-label="Knowledge sections">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === 'search' && <SearchView />}
      {tab === 'explain' && <ExplainView />}
      {tab === 'playbooks' && <PlaybooksView />}
      {tab === 'articles' && <ArticlesView />}
      {tab === 'glossary' && <GlossaryView />}
      {tab === 'codes' && <CodesView />}
      {tab === 'payers' && <PayersView />}
      {tab === 'sources' && <SourcesView />}
    </>
  );
}
