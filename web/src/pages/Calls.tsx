// Call operations (docs/10 "Call operations view"): active and recent calls on
// the simulated payer line, intervention needs, policy and telephony status.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText, money, when } from '../api.ts';
import { Heading, Panel, toast } from '../ui.tsx';
import { go } from '../App.tsx';
import { CallStateBadge, secs, type CallSummary } from './CallPanel.tsx';

interface Config {
  policy: { version: number; sha256: string; reason: string; note: string; definition: {
    allowedDestinations: string[]; billingEntityName: string; disclosure: { automationDisclosure: string; announceRecording: boolean };
    recording: { enabled: boolean; consentMode: string; note: string }; verbalReprocessingPreauthorized: boolean; maxStatusAgeHours: number;
    costAssumption: { perMinuteCents: number; label: string } } };
  policyVersions: { version: number; reason: string; created_by: string; created_at: string }[];
  lines: { payerId: string; label: string; destination: string; timezone: string; businessHours: { days: number[]; open: string; close: string };
    maxConcurrent: number; maxCallsPerHour: number; holdTimeoutSeconds: number; inUse: number; placedLastHour: number }[];
  liveAdapter: { name: string; enabled: boolean; status: string };
  procurement: { source: string; retrievedAt: string; items: { id: string; item: string; question: string; status: string; source: string }[] };
  permissions: { editPolicy: boolean };
}

const NEEDS_HUMAN = (c: CallSummary) => c.state === 'handoff_to_human' || c.reconcileRequired || c.state === 'failed';

export function Calls() {
  const [filter, setFilter] = useState<'active' | 'recent' | 'all'>('active');
  const [calls, setCalls] = useState<{ items: CallSummary[]; counts: { active: number; needsAttention: number } } | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [err, setErr] = useState('');
  const [reason, setReason] = useState('');
  const load = useCallback(() => Promise.all([
    api.get<typeof calls>(`/api/calls?filter=${filter}`).then(setCalls),
    api.get<Config>('/api/calls/config').then(setCfg),
  ]).then(() => setErr('')).catch((e) => setErr(errorText(e))), [filter]);
  useEffect(() => { load(); const t = setInterval(load, 2500); return () => clearInterval(t); }, [load]);
  if (err) return <div className="callout danger">{err}</div>;
  if (!calls || !cfg) return <p className="muted">Loading…</p>;
  const p = cfg.policy.definition;

  const setVerbal = async (on: boolean) => {
    try {
      await api.post('/api/calls/policy', { patch: { verbalReprocessingPreauthorized: on }, reason });
      toast(`Call policy updated: verbal reprocessing ${on ? 'pre-authorized' : 'not authorized'}`); setReason(''); load();
    } catch (e) { toast(errorText(e), true); }
  };

  return (
    <>
      <Heading eyebrow="Call operations" title="Calls" subtitle="Payer calls on the simulated line: state, hold time, outcome and calls that need a person." />
      <div className="metrics">
        <div className="panel metric"><small>Active calls</small><strong>{calls.counts.active}</strong></div>
        <div className="panel metric"><small>Needs a person</small><strong>{calls.items.filter(NEEDS_HUMAN).length}</strong><span className="small muted">Handoff, failed or reconcile</span></div>
        {cfg.lines.map((l) => <div key={l.payerId} className="panel metric"><small>{l.payerId} lines in use</small><strong>{l.inUse}/{l.maxConcurrent}</strong><span className="small muted">{l.placedLastHour}/{l.maxCallsPerHour} placed this hour</span></div>)}
      </div>
      <Panel title="Calls" actions={
        <div className="tabs" role="group" aria-label="Filter calls">
          {(['active', 'recent', 'all'] as const).map((f) => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>)}
        </div>}>
        {calls.items.length === 0 ? <p className="muted">{filter === 'active' ? 'No calls in progress. Start one from an account workspace.' : 'No calls yet.'}</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Account</th><th>State</th><th>Payer</th><th className="r">Hold</th><th className="r">Duration</th><th className="r">Answered</th><th>Outcome</th><th>Started</th></tr></thead>
            <tbody>{calls.items.map((c) => (
              <tr key={c.callId} className={NEEDS_HUMAN(c) ? 'call-attention' : undefined}>
                <td><button className="link" onClick={() => go(`/account/${c.accountId}`)}>{c.externalId}</button>{c.simScript && <div className="small muted">{c.simScript.replace(/_/g, ' ')}</div>}</td>
                <td><CallStateBadge state={c.state} />{c.reconcileRequired && <div className="small" style={{ color: 'var(--danger)' }}>Reconcile before re-request</div>}</td>
                <td className="small">{c.payerId}</td>
                <td className="r num">{secs(c.holdSeconds)}</td>
                <td className="r num">{secs(c.totalSeconds)}</td>
                <td className="r num">{c.completeness.answered}/{c.completeness.planned}</td>
                <td className="small">{c.outcome ? c.outcome.replace(/_/g, ' ') : '—'}{c.reasonCode && <div className="mono">{c.reasonCode}</div>}</td>
                <td className="small">{when(c.createdAt)}</td>
              </tr>))}
            </tbody>
          </table></div>
        )}
        <p className="small muted" style={{ marginTop: 8 }}>Durations are simulated line time. Completed calls are not recovered accounts; outcomes are tracked on the account.</p>
      </Panel>

      <div className="grid2" style={{ marginTop: 16 }}>
        <div>
          <Panel title={`Client call policy v${cfg.policy.version}`}>
            <dl className="kv small">
              <dt>Allowed destinations</dt><dd>{p.allowedDestinations.join(', ') || 'None'}</dd>
              <dt>Billing entity</dt><dd>{p.billingEntityName}</dd>
              <dt>Automation disclosure</dt><dd>{p.disclosure.automationDisclosure}</dd>
              <dt>Recording</dt><dd>{p.recording.enabled ? 'On' : 'Off'} · consent config: {p.recording.consentMode.replace('_', '-')} · announce: {p.disclosure.announceRecording ? 'yes' : 'no'}</dd>
              <dt>Verbal reprocessing</dt><dd>{p.verbalReprocessingPreauthorized ? 'Pre-authorized by client' : 'Not authorized (agent may only ask for an explanation)'}</dd>
              <dt>Status freshness</dt><dd>Investigation within {p.maxStatusAgeHours}h before dialing</dd>
              <dt>Cost assumption</dt><dd>{money(p.costAssumption.perMinuteCents)}/min · {p.costAssumption.label}</dd>
            </dl>
            <p className="small muted" style={{ marginTop: 8 }}>{cfg.policy.note}</p>
            {cfg.permissions.editPolicy && (
              <div className="stack" style={{ marginTop: 12 }}>
                <label htmlFor="pol-reason">Reason for a policy change (creates a new immutable version)</label>
                <input id="pol-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="gap8">
                  <button disabled={reason.trim().length < 5} onClick={() => setVerbal(!p.verbalReprocessingPreauthorized)}>
                    {p.verbalReprocessingPreauthorized ? 'Withdraw verbal reprocessing authorization' : 'Record client pre-authorization for verbal reprocessing'}</button>
                </div>
              </div>
            )}
          </Panel>
          <Panel title="Payer lines (synthetic)">
            {cfg.lines.map((l) => (
              <dl key={l.payerId} className="kv small">
                <dt>Line</dt><dd>{l.label}</dd><dt>Destination</dt><dd className="mono">{l.destination}</dd>
                <dt>Hours</dt><dd>{l.businessHours.open}-{l.businessHours.close} {l.businessHours.days.length === 7 ? "daily" : "Mon-Fri"}, {l.timezone} (holiday calendar not configured)</dd>
                <dt>Limits</dt><dd>{l.maxConcurrent} concurrent · {l.maxCallsPerHour}/hour · hold timeout {secs(l.holdTimeoutSeconds)}</dd>
              </dl>
            ))}
          </Panel>
        </div>
        <div>
          <Panel title="Live telephony">
            <div className="callout danger"><b>{cfg.liveAdapter.status}.</b> No provider selected, no BAA, no covered-service verification and no customer authorization recorded.</div>
            <h3 style={{ marginTop: 12 }}>Procurement checklist</h3>
            <table><thead><tr><th>Item</th><th>Status</th></tr></thead>
              <tbody>{cfg.procurement.items.map((i) => <tr key={i.id}><td>{i.item}<div className="small muted">{i.question}</div></td><td><span className="badge b-neutral">{i.status.replace('_', ' ')}</span></td></tr>)}</tbody>
            </table>
            <p className="small muted" style={{ marginTop: 8 }}>Source: {cfg.procurement.source} (read {cfg.procurement.retrievedAt}).</p>
          </Panel>
        </div>
      </div>
    </>
  );
}
