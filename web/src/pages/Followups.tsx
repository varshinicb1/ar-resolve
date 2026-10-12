// Follow-up queue (FR13): overdue, due today, upcoming, snoozed and completed.
// Each date shows its basis: a captured payer commitment, or the client's
// internal review interval (labelled as policy, never as a payer promise).
import { useCallback, useEffect, useState } from 'react';
import { api, errorText, when } from '../api.ts';
import { Heading, Overlay, Panel, toast } from '../ui.tsx';
import { go } from '../App.tsx';

interface Item { followupId: string; accountId: string; externalId: string; payerId: string; basis: string; dueDate: string; label: string; state: string; snoozedUntil: string | null;
  daysUntilDue: number; computation: { steps: string[]; warnings: string[] }; completedAt: string | null; completionCode: string | null; calendar: { id: string; version: number } }
interface Policy { version: number; intervalValue: number; intervalUnit: string; basis: string; reason: string; createdBy: string; createdAt: string }
interface Queue { today: string; counts: Record<string, number>; items: Item[]; policy: Policy | null }
interface Calendar { calendarId: string; version: number; name: string; status: string; source: string; retrievedAt: string | null; payerId: string | null; clientId: string | null; definition: { holidays: { date: string; name: string }[]; coverage: { from: string; to: string }; notes: string } }

const BUCKETS: [string, string][] = [['overdue', 'Overdue'], ['due_today', 'Due today'], ['upcoming', 'Upcoming'], ['snoozed', 'Snoozed'], ['completed', 'Completed']];
const CODES: [string, string][] = [['status_obtained', 'Status obtained'], ['payer_actioned', 'Payer actioned the request'], ['escalated', 'Escalated'], ['no_longer_needed', 'No longer needed']];

export function Followups({ roles }: { roles: string[] }) {
  const [bucket, setBucket] = useState('overdue');
  const [q, setQ] = useState<Queue | null>(null);
  const [err, setErr] = useState('');
  const [snoozing, setSnoozing] = useState<Item | null>(null);
  const [completing, setCompleting] = useState<Item | null>(null);
  const load = useCallback(() => api.get<Queue>(`/api/followups?bucket=${bucket}`).then((r) => { setQ(r); setErr(''); }).catch((e) => setErr(errorText(e))), [bucket]);
  useEffect(() => { load(); }, [load]);
  const canManage = roles.some((r) => ['specialist', 'reviewer', 'supervisor'].includes(r));
  const run = async (label: string, fn: () => Promise<unknown>) => { try { await fn(); toast(label); load(); } catch (e) { toast(errorText(e), true); } };

  return (
    <>
      <Heading eyebrow="Follow-up calendar" title="Follow-ups" subtitle="Dates come from captured payer commitments on a business-day calendar. Without one, the client's review interval applies and is labelled as internal policy." />
      {err && <div className="callout danger">{err}</div>}
      {q && (
        <>
          <div className="tabs" role="group" aria-label="Follow-up buckets">
            {BUCKETS.map(([k, label]) => <button key={k} aria-pressed={bucket === k} onClick={() => setBucket(k)}>{label} <span className="num">({q.counts[k] ?? 0})</span></button>)}
          </div>
          <div className="grid2">
            <Panel title={`${BUCKETS.find((b) => b[0] === bucket)?.[1]} · today ${q.today} (UTC)`}>
              {q.items.length === 0 ? <p className="muted">Nothing here.</p> : (
                <div className="table-wrap"><table><thead><tr><th>Account</th><th>Due</th><th>Basis</th><th /></tr></thead>
                  <tbody>{q.items.map((i) => (
                    <tr key={i.followupId}>
                      <td><button className="link" onClick={() => go(`/account/${i.accountId}`)}>{i.externalId}</button><div className="small muted">{i.payerId}</div></td>
                      <td className="num">{i.dueDate}<div className="small muted">{i.state === 'completed' ? `done ${when(i.completedAt)}` : i.daysUntilDue < 0 ? `${-i.daysUntilDue} days late` : i.daysUntilDue === 0 ? 'today' : `in ${i.daysUntilDue} days`}{i.snoozedUntil ? ` · snoozed to ${i.snoozedUntil}` : ''}</div></td>
                      <td className="small"><span className={`badge ${i.basis === 'payer_commitment' ? 'b-verified' : 'b-review'}`}>{i.basis === 'payer_commitment' ? 'Payer commitment' : 'Policy interval'}</span>
                        <div className="muted">{i.label}</div>
                        <details><summary>Computation</summary><ul style={{ margin: 0, paddingLeft: 18 }}>{[...i.computation.steps, ...i.computation.warnings].map((s) => <li key={s}>{s}</li>)}</ul></details></td>
                      <td className="r">{canManage && i.state !== 'completed' && <div className="gap8"><button onClick={() => setSnoozing(i)}>Snooze</button><button onClick={() => setCompleting(i)}>Complete</button></div>}</td>
                    </tr>))}
                  </tbody></table></div>
              )}
            </Panel>
            <div>
              <PolicyPanel policy={q.policy} supervisor={roles.includes('supervisor')} onSaved={load} />
              <CalendarPanel />
            </div>
          </div>
        </>
      )}
      {snoozing && <SnoozeDialog item={snoozing} today={q!.today} onClose={() => setSnoozing(null)} onSubmit={(until, reason) => run('Snoozed', async () => { await api.post(`/api/followups/${snoozing.followupId}/snooze`, { until, reason }); setSnoozing(null); })} />}
      {completing && <CompleteDialog item={completing} onClose={() => setCompleting(null)} onSubmit={(code, note) => run('Follow-up completed', async () => { await api.post(`/api/followups/${completing.followupId}/complete`, { code, note }); setCompleting(null); })} />}
    </>
  );
}

function PolicyPanel({ policy, supervisor, onSaved }: { policy: Policy | null; supervisor: boolean; onSaved: () => void }) {
  const [value, setValue] = useState(String(policy?.intervalValue ?? 10));
  const [unit, setUnit] = useState(policy?.intervalUnit ?? 'days');
  const [basis, setBasis] = useState(policy?.basis ?? 'business');
  const [reason, setReason] = useState('');
  return (
    <Panel title="Review interval (internal policy)">
      <div className="stack">
        {policy ? <p className="small">v{policy.version}: {policy.intervalValue} {policy.basis} {policy.intervalUnit}. Set by {policy.createdBy} {when(policy.createdAt)}. <span className="muted">{policy.reason}</span></p> : <p className="muted">No policy configured.</p>}
        <p className="small muted">Used only when no payer commitment has been captured. It is never presented as a payer promise.</p>
        {supervisor && (
          <>
            <div className="gap8">
              <div><label htmlFor="pv">Every</label><input id="pv" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 70 }} inputMode="numeric" /></div>
              <div><label htmlFor="pu">Unit</label><select id="pu" value={unit} onChange={(e) => setUnit(e.target.value)}><option>days</option><option>weeks</option></select></div>
              <div><label htmlFor="pb">Basis</label><select id="pb" value={basis} onChange={(e) => setBasis(e.target.value)}><option>business</option><option>calendar</option></select></div>
            </div>
            <div><label htmlFor="pr2">Reason (required)</label><input id="pr2" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }} /></div>
            <button disabled={reason.trim().length < 5} onClick={async () => {
              try { await api.post('/api/followup-policy', { intervalValue: Number(value), intervalUnit: unit, basis, reason }); toast('New policy version saved'); setReason(''); onSaved(); } catch (e) { toast(errorText(e), true); }
            }}>Save new version</button>
          </>
        )}
      </div>
    </Panel>
  );
}

function CalendarPanel() {
  const [cals, setCals] = useState<Calendar[]>([]);
  const [calc, setCalc] = useState({ anchor: new Date().toISOString().slice(0, 10), value: '30', unit: 'days', basis: 'business', payerId: 'demo-payer' });
  const [out, setOut] = useState<{ dueDate: string; steps: string[]; warnings: string[]; calendar: { id: string; name: string } } | null>(null);
  useEffect(() => { api.get<Calendar[]>('/api/calendars').then(setCals).catch(() => {}); }, []);
  const compute = async () => {
    try { setOut(await api.get(`/api/calendars/compute?anchor=${calc.anchor}&value=${calc.value}&unit=${calc.unit}&basis=${calc.basis}&payerId=${encodeURIComponent(calc.payerId)}`)); } catch (e) { toast(errorText(e), true); }
  };
  return (
    <Panel title="Business calendars">
      <div className="stack">
        <table><tbody>{cals.map((c) => (
          <tr key={c.calendarId}><td className="small"><b>{c.name}</b> v{c.version}<div className="muted">{c.payerId ? `Payer ${c.payerId}` : 'All payers'} · {c.definition.holidays.length} holidays {c.definition.coverage.from} to {c.definition.coverage.to}</div>
            <div className="muted">{c.source.startsWith('http') ? <a href={c.source} target="_blank" rel="noreferrer">Source</a> : c.source}{c.retrievedAt ? `, retrieved ${c.retrievedAt}` : ''}</div></td>
            <td><span className={`badge ${c.status === 'reference' ? 'b-verified' : 'b-review'}`}>{c.status}</span></td></tr>))}</tbody></table>
        <h3>Due-date calculator</h3>
        <div className="gap8">
          <div><label htmlFor="ca">From</label><input id="ca" type="date" value={calc.anchor} onChange={(e) => setCalc({ ...calc, anchor: e.target.value })} /></div>
          <div><label htmlFor="cv">Within</label><input id="cv" value={calc.value} onChange={(e) => setCalc({ ...calc, value: e.target.value })} style={{ width: 70 }} /></div>
          <div><label htmlFor="cu">Unit</label><select id="cu" value={calc.unit} onChange={(e) => setCalc({ ...calc, unit: e.target.value })}><option>days</option><option>weeks</option></select></div>
          <div><label htmlFor="cb">Basis</label><select id="cb" value={calc.basis} onChange={(e) => setCalc({ ...calc, basis: e.target.value })}><option>business</option><option>calendar</option></select></div>
          <div><label htmlFor="cp">Payer</label><input id="cp" value={calc.payerId} onChange={(e) => setCalc({ ...calc, payerId: e.target.value })} style={{ width: 130 }} /></div>
        </div>
        <button onClick={compute}>Compute</button>
        {out && <div className="callout info"><b>{out.dueDate}</b> using {out.calendar.name}<ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{[...out.steps, ...out.warnings].map((s) => <li key={s}>{s}</li>)}</ul></div>}
      </div>
    </Panel>
  );
}

function SnoozeDialog({ item, today, onClose, onSubmit }: { item: Item; today: string; onClose: () => void; onSubmit: (until: string, reason: string) => void }) {
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Overlay kind="dialog" label="Snooze follow-up" onClose={onClose}>
      <div className="stack">
        <h2>Snooze {item.externalId}</h2>
        <p className="small muted">The due date ({item.dueDate}) is kept for adherence reporting. Snoozes are limited to 30 days.</p>
        <div><label htmlFor="su">Until</label><input id="su" type="date" min={today} value={until} onChange={(e) => setUntil(e.target.value)} /></div>
        <div><label htmlFor="sr">Reason (required)</label><input id="sr" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }} /></div>
        <div className="gap8"><button className="primary" disabled={!until || reason.trim().length < 5} onClick={() => onSubmit(until, reason)}>Snooze</button><button onClick={onClose}>Cancel</button></div>
      </div>
    </Overlay>
  );
}

function CompleteDialog({ item, onClose, onSubmit }: { item: Item; onClose: () => void; onSubmit: (code: string, note: string) => void }) {
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  return (
    <Overlay kind="dialog" label="Complete follow-up" onClose={onClose}>
      <div className="stack">
        <h2>Complete follow-up for {item.externalId}</h2>
        <div><label htmlFor="cc">Outcome</label><select id="cc" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: '100%' }}><option value="">Choose…</option>{CODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div><label htmlFor="cn">Note (optional, kept in the audit log)</label><textarea id="cn" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="gap8"><button className="primary" disabled={!code} onClick={() => onSubmit(code, note)}>Complete</button><button onClick={onClose}>Cancel</button></div>
      </div>
    </Overlay>
  );
}
