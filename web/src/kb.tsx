// Knowledge base UI pieces shared across pages. <CodeExplain> explains one CAS
// adjustment (group + CARC + RARCs) and shows the draft routed playbook.
import { useEffect, useState } from 'react';
import { api, errorText } from './api.ts';

export interface CodeBrief { code: string; found: boolean; description: string | null; descriptionStatus: string | null; status: string | null; stopDate: string | null; name?: string }
export interface Explanation {
  group: CodeBrief; carc: CodeBrief; rarcs: CodeBrief[];
  route: { decision: string; candidates: { scenarioId: string; reasons: string[] }[]; reasons: string[]; routingVersion: string };
  decision: 'scenario' | 'specialist_review'; scenarioId: string | null;
  playbook: { id: string; title: string; objective: string; hardStops: string[] } | null;
  caveats: string[];
}

export const DESC_NOTE: Record<string, string> = {
  excerpt_first_sentence: 'X12 excerpt',
  excerpt_truncated: 'X12 excerpt, truncated',
  build_pack_label_unverified: 'Build-pack label, not verified against X12',
  licensed_import_required: 'Full text needs licensed X12 import',
};

export function CodeStatus({ status }: { status: string | null }) {
  if (!status) return <span className="badge b-danger">unknown</span>;
  const cls = status === 'current' ? 'b-verified' : status === 'deactivated' ? 'b-danger' : 'b-review';
  return <span className={`badge ${cls}`}>{status.replace(/_/g, ' ')}</span>;
}

export function codeHref(type: string, code: string) { return `#/knowledge/code:${type}:${encodeURIComponent(code)}`; }

function Line({ label, type, c }: { label: string; type: string; c: CodeBrief }) {
  return (
    <div className="kb-line">
      <span className="mono kb-code">{c.found ? <a href={codeHref(type, c.code)}>{label} {c.code}</a> : `${label} ${c.code || '—'}`}</span>
      <span className="kb-desc">{c.name ?? c.description ?? (c.found ? <span className="muted">Description needs licensed import</span> : <span className="muted">Not in loaded list</span>)}</span>
      <CodeStatus status={c.found ? c.status : null} />
    </div>
  );
}

export function CodeExplain({ group, carc, rarcs = [] }: { group: string; carc: string; rarcs?: string[] }) {
  const [x, setX] = useState<Explanation | null>(null);
  const [err, setErr] = useState('');
  const key = `${group}|${carc}|${rarcs.join(',')}`;
  useEffect(() => {
    setX(null); setErr('');
    api.post<Explanation>('/api/kb/explain', { group, carc, rarcs }).then(setX).catch((e) => setErr(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (err) return <div className="callout danger">{err}</div>;
  if (!x) return <p className="muted small">Explaining adjustment…</p>;
  return (
    <div className="stack kb-explain" aria-live="polite">
      <div>
        <Line label="Group" type="group" c={x.group} />
        <Line label="CARC" type="carc" c={x.carc} />
        {x.rarcs.map((r) => <Line key={r.code} label="RARC" type="rarc" c={r} />)}
      </div>
      {x.decision === 'scenario' && x.playbook ? (
        <div className="callout ok">Draft route: <a href={`#/knowledge/playbook:${x.playbook.id}`}><strong>{x.playbook.id}</strong> · {x.playbook.title}</a>. {x.playbook.objective}</div>
      ) : (
        <div className="callout">Specialist review. {x.route.candidates.length > 1 ? `Candidates: ${x.route.candidates.map((c) => c.scenarioId).join(', ')}. ` : ''}{x.route.reasons.filter((r) => !r.startsWith('Single')).join(' ')}</div>
      )}
      <ul className="small kb-caveats">{x.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
      <div className="small muted">Routing {x.route.routingVersion} · draft, requires business sign-off</div>
    </div>
  );
}
