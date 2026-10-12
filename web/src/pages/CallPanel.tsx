// Payer call panel on the account workspace (E08 Voice, simulated line).
import { useCallback, useEffect, useState } from 'react';
import { api, errorText, money, when } from '../api.ts';
import { Panel, toast } from '../ui.tsx';

export interface GateCheck { id: string; label: string; pass: boolean; reasonCode: string | null; detail: string }
interface PlanPreview { id: string; label: string; reason: string; why: string; readBack: boolean; purposeful: boolean }
export interface CallSummary {
  callId: string; accountId: string; externalId: string; payerId: string; destination: string; state: string; outcome: string | null; reasonCode: string | null;
  simScript: string | null; active: boolean; assignedTo: string | null; reconcileRequired: boolean; holdSeconds: number; totalSeconds: number;
  completeness: { answered: number; planned: number; ratio: number }; createdBy: string; createdAt: string; endedAt: string | null;
}
interface AccountCalls {
  gate: { allowed: boolean; reasonCodes: string[]; checks: GateCheck[]; policy: { version: number; sha256: string }; plan: PlanPreview[] };
  calls: CallSummary[];
  scripts: { id: string; label: string; adversarial: boolean; description: string }[];
  permissions: { start: boolean };
}
interface Question { id: string; label: string; status: string; reason: string; why: string; readBack: boolean; attempts: number; note: string | null }
interface CallEvent { seq: number; kind: string; speaker: string | null; text: string | null; questionId: string | null; atMs: number; data: any }
interface Answer { answerId: string; questionId: string; key: string; factKey: string | null; value: any; unit: string | null; status: string; turnSeqs: number[]; readBackSeq: number | null; flags: string[] }
export interface CallDetail {
  call: CallSummary & { providerCallId: string; policy: { version: number }; transcriptEvidenceId: string | null; cancelRequested: string | null; simulated: boolean };
  account: { externalId: string; claimReference: string };
  plan: { planId: string; version: number; questions: Question[]; verification?: { answerKey: string; verdict: string; detail: string }[] };
  events: CallEvent[];
  flags: { seq: number; code: string; text: string; turnSeq: number | null }[];
  answers: Answer[];
  handoff: any;
  metrics: { ivrSeconds: number; holdSeconds: number; talkSeconds: number; totalSeconds: number; timeBasis: string; completeness: { answered: number; planned: number; ratio: number };
    cost: { estimateCents: number; minutes: number; perMinuteCents: number; label: string } };
  permissions: { control: boolean; cancel: boolean };
}

const TERMINAL = ['completed', 'dropped', 'cancelled', 'failed'];
const STATE_TEXT: Record<string, [string, string]> = {
  queued: ['neutral', 'Queued'], dialing: ['review', 'Dialing'], ivr: ['review', 'IVR'], hold: ['review', 'On hold'], transfer: ['review', 'Transferring'],
  rep_connected: ['review', 'Representative'], authenticating: ['review', 'Identifying'], questioning: ['review', 'Questioning'], read_back: ['review', 'Read-back'],
  wrap_up: ['review', 'Wrapping up'], completed: ['verified', 'Completed'], dropped: ['danger', 'Dropped'], cancelled: ['neutral', 'Cancelled'],
  handoff_to_human: ['danger', 'Specialist has the call'], failed: ['danger', 'Failed'],
};
const Q_DONE = ['answered', 'confirmed', 'accepted', 'found', 'not_found', 'declined'];
const Q_GAP = ['unknown', 'refused', 'unconfirmed'];

export function CallStateBadge({ state }: { state: string }) {
  const [tone, text] = STATE_TEXT[state] ?? ['neutral', state];
  return <span className={`badge b-${tone}`}>{text}</span>;
}

export const secs = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`);

function showValue(a: Answer): string {
  if (a.value === null || a.value === undefined) return '—';
  if (a.unit === 'USD_cents') return money(a.value);
  if (typeof a.value === 'object') return a.value.status ? `${String(a.value.status).replace(/_/g, ' ')}${a.value.tat ? ` · ${a.value.tat.value} ${a.value.tat.basis} ${a.value.tat.unit}` : ''}` : JSON.stringify(a.value);
  return String(a.value);
}

function QuestionMark({ status }: { status: string }) {
  if (Q_DONE.includes(status)) return <span className="mark" aria-hidden="true">✓</span>;
  if (Q_GAP.includes(status)) return <span className="mark" aria-hidden="true">!</span>;
  if (status === 'skipped') return <span className="mark" aria-hidden="true">–</span>;
  return <span className="mark" aria-hidden="true">○</span>;
}

export function Transcript({ d }: { d: CallDetail }) {
  const byTurn = new Map<number, Answer[]>();
  for (const a of d.answers) for (const s of a.turnSeqs) byTurn.set(s, [...(byTurn.get(s) ?? []), a]);
  const readBacks = new Map<number, Answer>(d.answers.filter((a) => a.readBackSeq).map((a) => [a.readBackSeq!, a]));
  const flagsByTurn = new Map<number, typeof d.flags>();
  for (const f of d.flags) if (f.turnSeq) flagsByTurn.set(f.turnSeq, [...(flagsByTurn.get(f.turnSeq) ?? []), f]);
  const shown = d.events.filter((e) => e.kind !== 'flag' || !e.data.turnSeq);
  return (
    <ol className="call-transcript" aria-label="Call transcript">
      {shown.map((e) => {
        if (e.kind === 'state') return <li key={e.seq} className="call-state small muted">{e.text}</li>;
        if (e.kind === 'flag') return <li key={e.seq} className="call-flag small"><b>{e.data.code.replace(/_/g, ' ')}</b>: {e.text}</li>;
        const ans = byTurn.get(e.seq) ?? [];
        const rb = readBacks.get(e.seq);
        const fl = flagsByTurn.get(e.seq) ?? [];
        return (
          <li key={e.seq} className={`turn ${e.speaker === 'rep' ? 'rep' : ''} ${e.kind === 'hold' || e.kind === 'system' || e.kind === 'ivr' || e.kind === 'dtmf' ? 'call-sys' : ''} ${ans.length ? 'has-extract' : ''}`}>
            <div className="small muted">#{e.seq} · {e.speaker ?? e.kind} · {secs(Math.round(e.atMs / 1000))}</div>
            <div>{e.text}</div>
            {ans.map((a) => (
              <div key={a.answerId} className="small call-extract">
                <span className="hl">{a.key}: {showValue(a)}</span>{' '}
                <span className={`badge b-${a.status === 'confirmed' || a.status === 'answered' ? 'reported' : a.status === 'quarantined' ? 'danger' : 'neutral'}`}>
                  {a.status === 'confirmed' ? 'Read back · confirmed' : a.status}
                </span>
              </div>
            ))}
            {rb && <div className="small call-extract"><span className="badge b-verified">Read-back confirmation of {rb.key}</span></div>}
            {fl.map((f) => <div key={f.seq} className="small call-flag-inline"><b>{f.code.replace(/_/g, ' ')}</b>: {f.text}</div>)}
          </li>
        );
      })}
    </ol>
  );
}

export function CallPanel({ accountId, onChange }: { accountId: string; onChange: () => void }) {
  const [data, setData] = useState<AccountCalls | null>(null);
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [script, setScript] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.get<AccountCalls>(`/api/accounts/${accountId}/calls`);
      setData(d);
      setErr('');
      const id = selected ?? d.calls[0]?.callId ?? null;
      if (id) setDetail(await api.get<CallDetail>(`/api/calls/${id}`));
      else setDetail(null);
    } catch (e) { setErr(errorText(e)); }
  }, [accountId, selected]);
  useEffect(() => { load(); }, [load]);

  // Live updates while the call is in progress (the worker advances it).
  const live = !!detail && !TERMINAL.includes(detail.call.state);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [live, load]);
  // When a call reaches a terminal state, refresh the account (facts, proposals).
  const [lastState, setLastState] = useState<string | null>(null);
  useEffect(() => {
    if (!detail) return;
    if (lastState && !TERMINAL.includes(lastState) && TERMINAL.includes(detail.call.state)) onChange();
    setLastState(detail.call.state);
  }, [detail, lastState, onChange]);

  const post = async (label: string, path: string, body: unknown, ok: (r: any) => string) => {
    setBusy(label);
    try { const r = await api.post<any>(path, body); toast(ok(r)); await load(); onChange(); return r; } catch (e) { toast(errorText(e), true); await load(); } finally { setBusy(''); }
  };

  if (err) return <Panel title="Payer call"><div className="callout danger">{err}</div></Panel>;
  if (!data) return null;
  const g = data.gate;
  const c = detail?.call;

  return (
    <Panel title="Payer call (simulated line)" id="call-h" actions={c && <CallStateBadge state={c.state} />}>
      <div className="stack">
        <div className={`callout ${g.allowed ? 'ok' : 'info'}`}>
          <b>{g.allowed ? 'Call policy: allowed' : `Call policy: refused (${g.reasonCodes.join(', ')})`}</b>
          <span className="small"> · policy v{g.policy.version}</span>
          <details>
            <summary>Policy gate checks</summary>
            <ul className="call-checks">
              {g.checks.map((ch) => (
                <li key={ch.id} className={`check ${ch.pass ? 'pass' : 'fail'}`}><span className="mark" aria-hidden="true">{ch.pass ? '✓' : '✕'}</span>
                  <span><b>{ch.label}</b>{ch.reasonCode && <span className="mono"> {ch.reasonCode}</span>}<br /><span className="small">{ch.detail}</span></span></li>
              ))}
            </ul>
          </details>
          {g.plan.length > 0 && (
            <details>
              <summary>Question plan ({g.plan.filter((q) => q.purposeful).length} need the payer)</summary>
              <ol className="small">{g.plan.map((q) => <li key={q.id}><b>{q.label}</b> · {q.reason.replace(/_/g, ' ')}{q.readBack ? ' · read back' : ''}<div className="muted">{q.why}</div></li>)}</ol>
            </details>
          )}
        </div>

        {data.permissions.start && (
          <div className="gap8">
            <label htmlFor="sim-script" className="sr">Simulator script</label>
            <select id="sim-script" value={script} onChange={(e) => setScript(e.target.value)} aria-label="Simulator script (synthetic only)">
              <option value="">Simulator: account default script</option>
              {data.scripts.map((s) => <option key={s.id} value={s.id}>{s.adversarial ? 'Adversarial: ' : ''}{s.label}</option>)}
            </select>
            <button className="primary" disabled={!g.allowed || !!busy} title={g.allowed ? undefined : g.reasonCodes.join(', ')}
              onClick={async () => {
                const r = await post('start', `/api/accounts/${accountId}/calls`, { idempotencyKey: `ui-${accountId}-${Date.now()}`, ...(script ? { simScript: script } : {}) }, () => 'Call queued on the simulated payer line');
                if (r?.callId) setSelected(r.callId);
              }}>{busy === 'start' ? 'Starting…' : 'Start call'}</button>
          </div>
        )}

        {data.calls.length > 1 && (
          <div className="gap8 small">
            <label htmlFor="call-pick" style={{ margin: 0 }}>Call</label>
            <select id="call-pick" value={c?.callId ?? ''} onChange={(e) => setSelected(e.target.value)}>
              {data.calls.map((x) => <option key={x.callId} value={x.callId}>{when(x.createdAt)} · {STATE_TEXT[x.state]?.[1] ?? x.state}{x.reasonCode ? ` (${x.reasonCode})` : ''}</option>)}
            </select>
          </div>
        )}

        {detail && c && (
          <>
            <div className="metrics call-metrics">
              <div className="panel metric"><small>IVR</small><strong>{secs(detail.metrics.ivrSeconds)}</strong></div>
              <div className="panel metric"><small>Hold</small><strong>{secs(detail.metrics.holdSeconds)}</strong></div>
              <div className="panel metric"><small>Talk</small><strong>{secs(detail.metrics.talkSeconds)}</strong></div>
              <div className="panel metric"><small>Answered</small><strong>{detail.metrics.completeness.answered}/{detail.metrics.completeness.planned}</strong></div>
              <div className="panel metric"><small>Cost (assumption)</small><strong>{money(detail.metrics.cost.estimateCents)}</strong></div>
            </div>
            <p className="small muted">{detail.metrics.timeBasis}. {detail.metrics.cost.label}</p>
            {c.reasonCode && <div className={`callout ${c.state === 'completed' ? 'info' : 'danger'}`}>Outcome: <b>{c.outcome ?? c.state}</b> · <span className="mono">{c.reasonCode}</span>{c.reconcileRequired && ' · Reconcile with the payer before any new request'}</div>}
            {c.cancelRequested && !TERMINAL.includes(c.state) && <div className="callout info">Cancellation requested: the agent will close politely and end the call.</div>}

            {detail.permissions.control && !TERMINAL.includes(c.state) && (
              <div className="stack">
                <div className="gap8">
                  {c.state !== 'handoff_to_human' && <button disabled={!!busy} onClick={() => post('adv', `/api/calls/${c.callId}/advance`, { steps: 1 }, (r) => `Simulator step: ${r.state}`)}>Advance simulator one step</button>}
                  {c.state !== 'handoff_to_human' && <button disabled={!!busy} onClick={() => post('take', `/api/calls/${c.callId}/takeover`, { reason: reason || 'Specialist took over' }, () => 'You have the call. Automation stopped.')}>Take over call</button>}
                  {c.state === 'handoff_to_human' && <button className="primary" disabled={!!busy} onClick={() => post('end', `/api/calls/${c.callId}/end`, { notes: reason }, () => 'Call ended by specialist')}>End call</button>}
                  {detail.permissions.cancel && <button className="danger" disabled={!!busy || reason.trim().length < 3} title={reason.trim().length < 3 ? 'Enter a reason first' : undefined}
                    onClick={() => post('cancel', `/api/calls/${c.callId}/cancel`, { reason }, (r) => `${r.message} ${r.scope}`)}>Cancel call</button>}
                </div>
                <div>
                  <label htmlFor="call-reason">Reason or notes (required to cancel; notes are not extracted as facts)</label>
                  <input id="call-reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }} />
                </div>
                <p className="small muted">Cancel stops this call only. A request the payer already accepted is not withdrawn; it is reconciled.</p>
              </div>
            )}

            {detail.handoff && (
              <details open={c.state === 'handoff_to_human'}>
                <summary>Handoff packet</summary>
                <dl className="kv small">
                  <dt>Reason</dt><dd>{detail.handoff.reason}</dd>
                  <dt>Identity</dt><dd>{detail.handoff.identityContext.externalId} · claim {detail.handoff.identityContext.claimReference} · DOS {detail.handoff.identityContext.serviceDate}</dd>
                  <dt>Answered</dt><dd>{detail.handoff.answered.map((a: any) => `${a.key}: ${a.unit === 'USD_cents' ? money(a.value) : typeof a.value === 'number' && /Cents$/.test(a.key) ? money(a.value) : JSON.stringify(a.value)}`).join('; ') || 'None'}</dd>
                  <dt>Open questions</dt><dd>{detail.handoff.openQuestions.join('; ') || 'None'}</dd>
                  <dt>Commitments</dt><dd>{detail.handoff.commitments.length ? JSON.stringify(detail.handoff.commitments) : 'None'}</dd>
                  <dt>Line</dt><dd>{detail.handoff.connection.connected ? 'Connected to representative' : detail.handoff.connection.linePhase}</dd>
                </dl>
              </details>
            )}

            <div>
              <h3>Question plan</h3>
              <ul className="call-plan">
                {detail.plan.questions.map((q) => (
                  <li key={q.id} className={`check ${Q_DONE.includes(q.status) ? 'pass' : Q_GAP.includes(q.status) ? 'fail' : ''}`}>
                    <QuestionMark status={q.status} />
                    <span><b>{q.label}</b> <span className="small muted">· {q.status.replace(/_/g, ' ')}{q.readBack ? ' · read-back required' : ''}{q.attempts > 1 ? ` · ${q.attempts} attempts` : ''}</span>
                      {q.note && <><br /><span className="small">{q.note}</span></>}</span>
                  </li>
                ))}
              </ul>
            </div>

            {detail.plan.verification && detail.plan.verification.length > 0 && (
              <div>
                <h3>Verifier</h3>
                <table><tbody>{detail.plan.verification.map((v, i) => <tr key={i}><td className="mono">{v.answerKey}</td><td>{v.verdict.replace(/_/g, ' ')}</td><td className="small">{v.detail}</td></tr>)}</tbody></table>
              </div>
            )}

            <details open>
              <summary>Transcript ({detail.events.filter((e) => e.kind === 'turn').length} turns) · simulated line, untrusted evidence</summary>
              <Transcript d={detail} />
            </details>
          </>
        )}
      </div>
    </Panel>
  );
}
