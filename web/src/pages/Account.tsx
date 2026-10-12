import { useCallback, useEffect, useState } from 'react';
import { api, money, when, errorText, type ApiError } from '../api.ts';
import { Heading, Overlay, Panel, StateBadge, StatusBadge, toast } from '../ui.tsx';
import { OUTCOME_LABELS, reasonLabel, type Ded01Outcome } from '../../../shared/rules/ded01.ts';
import { DED01_V1 } from '../../../shared/rules/catalog.ts';
import { AccountOps, OPS_EVENT_TEXT } from './AccountOps.tsx';
import { CallPanel } from './CallPanel.tsx';

interface Fact { key: string; label: string; status: string; value: unknown; unit: string | null; version: number; evidenceId: string | null; locator: any; candidates: { value: unknown; evidenceId: string; sourceClass: string; locator: any; observedAt: string }[]; acceptedStatuses: string[] }
interface Evidence { evidenceId: string; kind: string; title: string; source: string; content: any; sha256: string; observedAt: string; effectiveAt: string | null; createdBy: string }
interface Check { id: string; label: string; pass: boolean; detail?: string }
interface Action {
  actionId: string; kind: string; riskClass: string; connector: string; payload: any; payloadSha256: string; expectedRevision: number; state: string;
  expiresAt: string; noteDraft: string; createdBy: string; createdAt: string; checks: Check[] | null;
  outbox: { state: string; attempts: number; external_reference: string | null; last_error: string | null; idempotency_key: string } | null;
  decisions: { decision: string; actor_id: string; rationale: string; created_at: string }[];
}
interface View {
  account: { accountId: string; externalId: string; payerId: string; providerId: string; patientToken: string; serviceDate: string; claimReference: string; claimType: string; balanceCents: number; scenario: string; state: string; revision: number; batchId: string };
  facts: Fact[]; evidence: Evidence[]; actions: Action[];
  latestRun: { runId: string; state: string; result: { outcome: Ded01Outcome; reasonCodes: string[]; missing: string[]; calculation: any }; accountRevision: number; rule: { id: string; version: number; sha256: string }; createdAt: string } | null;
  interactions: { interactionId: string; callReference: string; transitions: { state: string; at: string }[]; mocked: boolean; createdAt: string }[];
  timeline: { eventId: string; actorId: string; eventType: string; eventAt: string; details: any }[];
  pause: { scopeKey: string; reason: string } | null;
  permissions: { investigate: boolean; correct: boolean; review: boolean; operate: boolean; export: boolean };
}

const MONEY_KEYS = new Set(['allowedCents', 'appliedCents', 'limitCents', 'metBeforeCents']);
const CORRECTABLE = new Set(['planDesign', 'claimReference', 'adjustmentGroup', 'allowedCents', 'appliedCents', 'limitCents', 'metBeforeCents', 'secondaryAtDos', 'crossoverStatus', 'postingVerified']);

function show(key: string, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (MONEY_KEYS.has(key)) return money(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v).replace(/_/g, ' ');
}

const EVENT_TEXT: Record<string, string> = {
  account_imported: 'Imported from inventory', evidence_collected: 'Evidence collected', identity_blocked: 'Identity conflict: blocked',
  run_abstained: 'Rule abstained', proposal_generated: 'Proposal generated', action_proposed: 'Action proposed', proposal_superseded: 'Proposal superseded by new evidence',
  call_completed: 'Simulated call completed', fact_corrected: 'Fact corrected', proposal_approved: 'Approved for submission', proposal_rejected: 'Proposal rejected',
  proposal_needs_evidence: 'Evidence requested', action_dispatched: 'Dispatched to connector', dispatch_uncertain: 'Receipt uncertain', uncertain_reconciled: 'Uncertain dispatch reconciled',
  action_receipt_received: 'Receipt recorded', dispatch_blocked: 'Dispatch blocked by executor re-check', payer_confirmation_received: 'Payer confirmed receipt (not payment)',
  audit_exported: 'Audit packet exported', dispatch_failed: 'Dispatch failed',
};
Object.assign(EVENT_TEXT, OPS_EVENT_TEXT);

export function Account({ accountId, onChange }: { accountId: string; onChange: () => void }) {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [source, setSource] = useState<{ fact?: Fact; evidenceId?: string } | null>(null);
  const [correcting, setCorrecting] = useState<Fact | null>(null);

  const load = useCallback(async () => {
    try { setV(await api.get<View>(`/api/accounts/${accountId}`)); setErr(''); } catch (e) { setErr(errorText(e)); }
  }, [accountId]);
  useEffect(() => { load(); }, [load]);
  // While something is in flight with the worker, refresh so receipts appear.
  useEffect(() => {
    if (!v || !['approved', 'executing', 'receipt_uncertain'].includes(v.account.state)) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [v, load]);

  const act = async (label: string, path: string, body?: unknown) => {
    setBusy(label);
    try {
      const r = await api.post<any>(path, body);
      if (r.outcome) toast(`${OUTCOME_LABELS[r.outcome as Ded01Outcome]}${r.superseded?.length ? ` · ${r.superseded.length} earlier proposal superseded` : ''}`);
      await load(); onChange();
      return r;
    } catch (e) { toast(errorText(e), true); await load(); throw e; } finally { setBusy(''); }
  };

  if (err) return <div className="callout danger">{err}</div>;
  if (!v) return <p className="muted">Loading account…</p>;
  const a = v.account;
  const current = v.actions[0];
  const evidenceTitle = (id: string | null) => v.evidence.find((e) => e.evidenceId === id)?.title ?? 'source';
  const hasCall = v.evidence.some((e) => e.kind === 'call_transcript');

  const exportPacket = async () => {
    try {
      const pkt = await api.get<any>(`/api/accounts/${accountId}/audit-export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(pkt, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = `audit-${a.externalId}-${pkt.exportedAt.slice(0, 19)}.json`; link.click();
      URL.revokeObjectURL(url);
      toast(`Audit packet exported. Chain ${pkt.auditChain.ok ? 'verified' : 'BROKEN'} · sha256 ${pkt.packetSha256.slice(0, 12)}`);
      load();
    } catch (e) { toast(errorText(e), true); }
  };

  return (
    <>
      <Heading eyebrow={`Account workspace · ${a.scenario}`} title={a.externalId} subtitle="Investigate the allocation and evidence before any financial action." />
      <div className="identity" aria-label="Account identity">
        <div>
          <b>{a.externalId} / {a.payerId}</b>
          <p className="small">Claim {a.claimReference} · DOS {a.serviceDate} · {a.claimType} · Patient token {a.patientToken} · Revision {a.revision}</p>
        </div>
        <div className="amt"><b className="num">{money(a.balanceCents)}</b><p className="small">Open balance · Synthetic</p></div>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="gap8"><StateBadge state={a.state} />{v.latestRun && <span className="small muted">Last evaluated {when(v.latestRun.createdAt)} on revision {v.latestRun.accountRevision} with {v.latestRun.rule.id} draft v{v.latestRun.rule.version}</span>}</div>
        <div className="gap8">
          {v.permissions.investigate && <button className="primary" disabled={!!busy || !!v.pause} onClick={() => act('inv', `/api/accounts/${accountId}/investigate`)}>{busy === 'inv' ? 'Investigating…' : a.state === 'ready' ? 'Run investigation' : 'Re-run investigation'}</button>}
          {v.permissions.investigate && a.state !== 'ready' && <button disabled={!!busy || !!v.pause || a.state === 'blocked'} title={a.state === 'blocked' ? 'Calls are blocked until identity is resolved' : undefined}
            onClick={() => act('call', `/api/accounts/${accountId}/calls/simulate`)}>{busy === 'call' ? 'Calling…' : hasCall ? 'Repeat pre-scripted call (legacy)' : 'Pre-scripted call (legacy)'}</button>}
          {v.permissions.export && <button onClick={exportPacket}>Export audit packet</button>}
        </div>
      </div>
      {v.pause && <div className="callout danger" style={{ marginBottom: 16 }}>Automation paused ({v.pause.scopeKey}): {v.pause.reason}. New investigations, calls and dispatches are stopped. Requests the payer already accepted still reconcile.</div>}
      {a.state === 'ready' && <div className="callout info" style={{ marginBottom: 16 }}>This account has not been investigated. Running an investigation pulls synthetic EOB, eligibility, clearinghouse and PM records, resolves facts and evaluates DED01.</div>}

      <div className="grid2">
        <div>
          <Panel title="Adjudication facts" id="facts-h" actions={<span className="small muted">Click a status to open its source</span>}>
            <table className="facts">
              <thead><tr><th>Fact</th><th className="r">Value</th><th>Status</th><th /></tr></thead>
              <tbody>
                {v.facts.map((f) => (
                  <tr key={f.key}>
                    <td>{f.label}<div className="small muted">{f.status === 'reported' ? `Reported by payer rep · ${evidenceTitle(f.evidenceId)}` : f.status === 'verified' ? evidenceTitle(f.evidenceId) : f.acceptedStatuses.includes('reported') ? 'Accepts verified or reported' : 'Requires verified source'}</div></td>
                    <td className="r num">{f.status === 'conflicting' ? <span>{f.candidates.map((c) => show(f.key, c.value)).filter((x, i, arr) => arr.indexOf(x) === i).join(' vs ')}</span> : f.key === 'identityVerified' && f.value === false ? <b style={{ color: 'var(--danger)' }}>No</b> : show(f.key, f.value)}</td>
                    <td>{f.key === 'identityVerified' && f.value === false
                      ? <button type="button" className="badge b-danger" onClick={() => setSource({ fact: f })} aria-label="Identity mismatch: open source">Mismatch</button>
                      : <StatusBadge status={f.status} onClick={f.status === 'missing' ? undefined : () => setSource({ fact: f })} label={`${f.label}: ${f.status}, open source`} />}</td>
                    <td className="r">{v.permissions.correct && CORRECTABLE.has(f.key) && a.state !== 'ready' && <button className="link" onClick={() => setCorrecting(f)}>Correct</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Evidence" id="ev-h">
            {v.evidence.length === 0 ? <p className="muted">No evidence collected.</p> : (
              <table>
                <thead><tr><th>Source</th><th>Kind</th><th>Observed</th><th>Hash</th></tr></thead>
                <tbody>{v.evidence.map((e) => (
                  <tr key={e.evidenceId}>
                    <td><button className="link" onClick={() => setSource({ evidenceId: e.evidenceId })}>{e.title}</button></td>
                    <td className="small">{e.kind.replace(/_/g, ' ')}</td><td className="small">{when(e.observedAt)}</td><td className="mono">{e.sha256.slice(0, 10)}</td>
                  </tr>))}
                </tbody>
              </table>
            )}
          </Panel>

          <CallPanel accountId={accountId} onChange={load} />

          {v.interactions.length > 0 && (
            <Panel title="Payer interactions" id="int-h">
              {v.interactions.map((i) => (
                <div key={i.interactionId} className="stack">
                  <div className="row"><b>Call {i.callReference}</b>{i.mocked && <span className="badge b-review">Mocked: pre-scripted</span>}</div>
                  <p className="small muted">{i.transitions.map((t) => t.state).join(' → ')}</p>
                </div>
              ))}
            </Panel>
          )}

          <Panel title="Account timeline" id="tl-h">
            <ol className="timeline">
              {[...v.timeline].reverse().map((e) => (
                <li key={e.eventId}>
                  <b>{EVENT_TEXT[e.eventType] ?? e.eventType}</b> <span className="small muted">· {when(e.eventAt)} · {e.actorId}</span>
                  {e.details?.reason && <div className="small">{String(e.details.reason)}</div>}
                  {e.details?.rationale && <div className="small">“{String(e.details.rationale)}”</div>}
                  {e.details?.problems && <div className="small" style={{ color: 'var(--danger)' }}>{e.details.problems.join('; ')}</div>}
                  {e.details?.outcome && e.eventType !== 'uncertain_reconciled' && <div className="small">{OUTCOME_LABELS[e.details.outcome as Ded01Outcome] ?? e.details.outcome}</div>}
                  {e.eventType === 'uncertain_reconciled' && <div className="small">{e.details.outcome === 'found_at_connector' ? `Found at connector (${e.details.externalReference}); not resubmitted` : 'Connector never received it; returned to queue'}</div>}
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <div>
          <NextAction v={v} current={current} busy={busy} onDecide={(body) => act('review', `/api/actions/${current.actionId}/review`, body)} />
          {v.actions.length > 1 && (
            <Panel title="Earlier proposals" id="hist-h">
              <table><tbody>{v.actions.slice(1).map((x) => (
                <tr key={x.actionId}><td>{OUTCOME_LABELS[x.kind as Ded01Outcome]}<div className="small muted">rev {x.expectedRevision} · {when(x.createdAt)}</div></td><td><StateBadge state={x.state} /></td></tr>
              ))}</tbody></table>
            </Panel>
          )}
          <AccountOps accountId={accountId} revision={a.revision} currentAction={current} canReview={v.permissions.review} evidence={v.evidence} onChange={load} />
        </div>
      </div>

      {source && <SourceDrawer v={v} fact={source.fact} evidenceId={source.evidenceId} onClose={() => setSource(null)} />}
      {correcting && <CorrectDialog fact={correcting} revision={a.revision} onClose={() => setCorrecting(null)}
        onSubmit={async (value, reason) => { await act('correct', `/api/accounts/${accountId}/facts/${correcting.key}/correct`, { value, reason, expectedRevision: a.revision }); setCorrecting(null); }} />}
    </>
  );
}

function NextAction({ v, current, busy, onDecide }: { v: View; current: Action | undefined; busy: string; onDecide: (b: unknown) => Promise<unknown> }) {
  const [rationale, setRationale] = useState('');
  const [confirming, setConfirming] = useState(false);
  const run = v.latestRun;
  if (!run) return <Panel title="Next step"><p className="muted">No evaluation yet.</p></Panel>;
  const res = run.result;
  const calc = res.calculation;

  if (!current || current.expectedRevision !== v.account.revision) {
    // Abstention (or blocked) on the current revision.
    return (
      <Panel title={v.account.state === 'blocked' ? 'Blocked: identity conflict' : OUTCOME_LABELS[res.outcome]}>
        <div className="stack">
          <span className={`badge ${v.account.state === 'blocked' ? 'b-danger' : 'b-review'}`}>{v.account.state === 'blocked' ? 'No action permitted' : 'Abstained: no action proposed'}</span>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{res.reasonCodes.map((r) => <li key={r}>{reasonLabel(r)}</li>)}</ul>
          {res.missing.length > 0 && <div className="callout">Needed: {res.missing.map((m) => DED01_V1.requiredFacts.find((f) => f.key === m)?.label ?? m).join(', ')}</div>}
          {v.account.state === 'blocked' && <div className="callout danger">The EOB does not match this account's identity. Verify the claim and patient match with the client before any payer contact. No calls or actions are allowed.</div>}
          {calc && <Calculation calc={calc} />}
          <p className="small muted">Unknown is never treated as zero or "no". The rule abstains until evidence is complete and consistent.</p>
        </div>
      </Panel>
    );
  }

  const a = current!;
  const p = a.payload;
  const spec = DED01_V1.actions.find((x) => x.kind === a.kind);
  const failed = (a.checks ?? []).filter((c) => !c.pass);
  const canDecide = a.state === 'awaiting_review' && v.permissions.review;
  const canApprove = canDecide && failed.length === 0 && rationale.trim().length >= 5;
  const decide = async (decision: string) => {
    try {
      await onDecide({ decision, rationale, payloadSha256: a.payloadSha256, accountRevision: v.account.revision });
      setRationale(''); setConfirming(false);
    } catch (e) { if ((e as ApiError).status === 409) setConfirming(false); }
  };

  return (
    <Panel>
      <div className="stack">
        <div className="row"><StateBadge state={a.state} /><span className="small muted">{spec?.risk.replace(/_/g, ' ')}</span></div>
        <h2>{OUTCOME_LABELS[a.kind as Ded01Outcome]}</h2>
        <div className="callout">{p.request.summary}</div>
        <ul style={{ margin: 0, paddingLeft: 18 }} className="small">{res.reasonCodes.map((r) => <li key={r}>{reasonLabel(r)}</li>)}</ul>
        {calc && <Calculation calc={calc} />}
        <dl className="kv">
          <dt>Destination</dt><dd>{p.destination.connector === 'sim_payer' ? `Simulated payer inquiry API (${p.destination.payerId})` : p.destination.worklist}</dd>
          <dt>Account / claim</dt><dd>{p.account.externalId} / {p.account.claimReference}</dd>
          <dt>Bound to</dt><dd>Revision {a.expectedRevision} · payload <span className="mono">{a.payloadSha256.slice(0, 16)}…</span></dd>
          <dt>Rule</dt><dd>{p.basis.ruleId} draft v{p.basis.ruleVersion} <span className="mono">{p.basis.ruleSha256.slice(0, 10)}</span></dd>
          <dt>Prohibited</dt><dd className="small">{p.prohibited.join(', ').replace(/_/g, ' ')}</dd>
          <dt>Expires</dt><dd>{when(a.expiresAt)}</dd>
        </dl>
        {a.outbox && (
          <div className={`callout ${a.outbox.state === 'uncertain' || a.outbox.state === 'blocked' || a.outbox.state === 'failed' ? 'danger' : a.outbox.state === 'pending' ? '' : 'ok'}`}>
            <b>Execution: </b><StateBadge state={a.outbox.state} /> · attempts {a.outbox.attempts}
            {a.outbox.external_reference && <> · reference <span className="mono">{a.outbox.external_reference}</span></>}
            {a.outbox.last_error && <div className="small">{a.outbox.last_error}</div>}
            {a.outbox.state === 'uncertain' && <div className="small">The connector timed out. The worker reads the request back before any retry; nothing is resubmitted blindly.</div>}
            {a.outbox.state === 'accepted' && <div className="small">The payer accepted the request. This is not an adjudication and not a payment.</div>}
          </div>
        )}
        {a.decisions.map((d) => <p key={d.created_at} className="small">{d.decision.replace('_', ' ')} by {d.actor_id} · {when(d.created_at)} · “{d.rationale}”</p>)}

        {a.state === 'awaiting_review' && (
          <>
            <h3 style={{ marginTop: 8 }}>Prerequisites</h3>
            {(a.checks ?? []).map((c) => (
              <div key={c.id} className={`check ${c.pass ? 'pass' : 'fail'}`}><span className="mark" aria-hidden>{c.pass ? '✓' : '✕'}</span><div>{c.label}<span className="sr">{c.pass ? ' passed' : ' failed'}</span>{c.detail && <div className="small muted">{c.detail}</div>}</div></div>
            ))}
            {canDecide ? (
              <>
                <div><label htmlFor="rationale">Decision rationale (required)</label><textarea id="rationale" value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Why this decision is justified by the evidence" /></div>
                {!canApprove && failed.length > 0 && <p className="small" style={{ color: 'var(--danger)' }}>Approval unavailable: {failed.map((f) => f.detail ?? f.label).join('; ')}</p>}
                {!canApprove && failed.length === 0 && rationale.trim().length < 5 && <p className="small muted">Enter a rationale to enable a decision.</p>}
                <div className="gap8">
                  <button className="primary" disabled={!canApprove || !!busy} onClick={() => setConfirming(true)}>{spec?.approveLabel ?? 'Approve'}</button>
                  <button disabled={rationale.trim().length < 5 || !!busy} onClick={() => decide('needs_evidence')}>Request evidence</button>
                  <button className="danger" disabled={rationale.trim().length < 5 || !!busy} onClick={() => decide('rejected')}>Reject</button>
                </div>
              </>
            ) : <p className="small muted">{v.permissions.review ? '' : 'Your role cannot decide on proposals. A reviewer must approve, reject or request evidence.'}</p>}
          </>
        )}
        <details><summary>Draft post-call note (system drafted)</summary><div className="note" style={{ marginTop: 8 }}>{a.noteDraft}</div></details>
        <details><summary>Exact payload</summary><pre className="json">{JSON.stringify(p, null, 2)}</pre></details>
      </div>
      {confirming && (
        <Overlay kind="dialog" label="Confirm approval" onClose={() => setConfirming(false)}>
          <div className="stack">
            <h2>{spec?.approveLabel}</h2>
            <p>Account <b>{p.account.externalId}</b>, claim <b>{p.account.claimReference}</b>.</p>
            <p>Destination: <b>{p.destination.connector === 'sim_payer' ? 'Simulated payer inquiry API' : p.destination.worklist}</b>. This environment is synthetic; no real payer receives anything.</p>
            <p className="small mono">payload {a.payloadSha256}</p>
            <div className="gap8"><button className="primary" disabled={!!busy} onClick={() => decide('approved')}>Confirm approval</button><button onClick={() => setConfirming(false)}>Cancel</button></div>
          </div>
        </Overlay>
      )}
    </Panel>
  );
}

function Calculation({ calc }: { calc: any }) {
  return (
    <div className="panel" style={{ background: '#f6f9fb', padding: 12 }}>
      <div className="small muted">Deterministic check · {calc.assumption}</div>
      <div className="num" style={{ marginTop: 4 }}>expected = min({money(calc.allowedCents)}, max(0, {money(calc.limitCents)} − {money(calc.metBeforeCents)})) = <b>{money(calc.expectedCents)}</b></div>
      <div className="num">applied <b>{money(calc.appliedCents)}</b> · difference <b style={{ color: calc.differenceCents ? 'var(--danger)' : 'var(--verified)' }}>{money(calc.differenceCents)}</b></div>
    </div>
  );
}

function SourceDrawer({ v, fact, evidenceId, onClose }: { v: View; fact?: Fact; evidenceId?: string; onClose: () => void }) {
  const items = fact ? (fact.status === 'conflicting' || fact.candidates.length > 1 ? fact.candidates.map((c) => ({ evidenceId: c.evidenceId, locator: c.locator, value: c.value, sourceClass: c.sourceClass }))
    : [{ evidenceId: fact.evidenceId!, locator: fact.locator, value: fact.value, sourceClass: '' }]) : [{ evidenceId: evidenceId!, locator: null, value: undefined, sourceClass: '' }];
  return (
    <Overlay kind="drawer" label="Source evidence" onClose={onClose}>
      <div className="row" style={{ marginBottom: 12 }}><h2>{fact ? fact.label : 'Source evidence'}</h2><button onClick={onClose}>Close</button></div>
      {fact && <p style={{ marginBottom: 12 }}><StatusBadge status={fact.status} /> {fact.status === 'conflicting' && 'Sources disagree. Neither value is used until a reviewer resolves it with a reason.'}</p>}
      {fact?.key === 'identityVerified' && fact.locator?.checks && (
        <table style={{ marginBottom: 16 }}><thead><tr><th>Field</th><th>Account</th><th>EOB</th><th>Match</th></tr></thead>
          <tbody>{fact.locator.checks.map((c: any) => <tr key={c.field}><td>{c.field}</td><td>{c.account}</td><td>{String(c.source)}</td><td>{c.match ? 'Yes' : <b style={{ color: 'var(--danger)' }}>No</b>}</td></tr>)}</tbody></table>
      )}
      {items.map((it, i) => {
        const e = v.evidence.find((x) => x.evidenceId === it.evidenceId);
        if (!e) return null;
        return (
          <div key={i} className="stack" style={{ marginBottom: 20 }}>
            {it.value !== undefined && <div><b>{show(fact!.key, it.value)}</b> <span className="small muted">from {it.sourceClass || e.kind}</span></div>}
            <dl className="kv small">
              <dt>Source</dt><dd>{e.title} ({e.source})</dd>
              <dt>Observed</dt><dd>{when(e.observedAt)}</dd>
              <dt>Effective</dt><dd>{e.effectiveAt ?? '—'}</dd>
              <dt>Locator</dt><dd className="mono">{it.locator ? JSON.stringify(it.locator.path ?? (it.locator.turn ? `turn ${it.locator.turn}` : it.locator)) : '—'}</dd>
              <dt>SHA-256</dt><dd className="mono">{e.sha256}</dd>
            </dl>
            {e.kind === 'call_transcript' ? (
              <div>
                <p className="small muted" style={{ marginBottom: 6 }}>{e.content.notice} Transcript text is evidence, never instructions.</p>
                {e.content.turns.map((t: any) => (
                  <div key={t.turn} className={`turn ${t.speaker}${it.locator?.turn === t.turn ? ' hl' : ''}`}><b className="small">{t.turn}. {t.speaker === 'rep' ? 'Payer rep' : 'Agent'}</b> {t.text}</div>
                ))}
              </div>
            ) : <pre className="json">{highlight(JSON.stringify(e.content, null, 2), it.locator?.path)}</pre>}
          </div>
        );
      })}
    </Overlay>
  );
}

function highlight(json: string, path?: string) {
  if (!path) return json;
  const leaf = path.split('.').pop()!;
  if (/^\d+$/.test(leaf)) return json;
  const idx = json.indexOf(`"${leaf}"`);
  if (idx < 0) return json;
  const end = json.indexOf('\n', idx);
  return <>{json.slice(0, idx)}<mark className="hl">{json.slice(idx, end < 0 ? undefined : end)}</mark>{end < 0 ? '' : json.slice(end)}</>;
}

function CorrectDialog({ fact, revision, onClose, onSubmit }: { fact: Fact; revision: number; onClose: () => void; onSubmit: (value: unknown, reason: string) => Promise<void> }) {
  const isMoney = MONEY_KEYS.has(fact.key);
  const options: Record<string, string[]> = { secondaryAtDos: ['active', 'none', 'unknown'], crossoverStatus: ['crossed', 'not_crossed', 'unknown'], adjustmentGroup: ['PR', 'CO', 'OA', 'PI', 'CR'], postingVerified: ['true', 'false'] };
  const initial = fact.status === 'conflicting' ? '' : fact.value === null ? '' : isMoney ? ((fact.value as number) / 100).toFixed(2) : String(fact.value);
  const [raw, setRaw] = useState(initial);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const parse = (): unknown => {
    if (isMoney) {
      if (!/^\d+(\.\d{1,2})?$/.test(raw.trim())) throw new Error('Enter a dollar amount such as 1200.00');
      const [d, c = ''] = raw.trim().split('.');
      return Number(d) * 100 + Number((c + '00').slice(0, 2));
    }
    if (fact.key === 'postingVerified') return raw === 'true';
    return raw;
  };
  return (
    <Overlay kind="dialog" label={`Correct ${fact.label}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { setErr(''); await onSubmit(parse(), reason); } catch (x) { setErr(errorText(x)); }
      }}>
        <h2>Correct: {fact.label}</h2>
        <p className="small muted">The original observations are kept. The correction becomes reviewer evidence, bumps the account to a new revision and supersedes any open proposal (current revision {revision}).</p>
        {fact.candidates.length > 0 && <div className="small">Sources: {fact.candidates.map((c) => `${show(fact.key, c.value)} (${c.sourceClass})`).join(' · ')}</div>}
        <div>
          <label htmlFor="cv">Correct value{isMoney ? ' (USD)' : ''}</label>
          {options[fact.key] ? (
            <select id="cv" value={raw} onChange={(e) => setRaw(e.target.value)}><option value="">Select…</option>{options[fact.key].map((o) => <option key={o} value={o}>{o.replace('_', ' ')}</option>)}</select>
          ) : <input id="cv" value={raw} onChange={(e) => setRaw(e.target.value)} inputMode={isMoney ? 'decimal' : 'text'} />}
        </div>
        <div><label htmlFor="cr">Reason (required)</label><textarea id="cr" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Which source is authoritative and why" /></div>
        {err && <div className="callout danger">{err}</div>}
        <div className="gap8"><button className="primary" type="submit" disabled={!raw || reason.trim().length < 5}>Save correction</button><button type="button" onClick={onClose}>Cancel</button></div>
      </form>
    </Overlay>
  );
}
