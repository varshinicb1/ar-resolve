// ADR 0060 account-page pieces that join workstreams: the KB explanation of every
// adjustment code shown in the facts, and verbal payer requests (voice <-> review guard).
import { useCallback, useEffect, useState } from 'react';
import { api, errorText, when } from '../api.ts';
import { Panel, toast } from '../ui.tsx';
import { CodeExplain } from '../kb.tsx';

interface FactLite { key: string; status: string; value: unknown; candidates: { value: unknown }[] }
interface Adj { group: string; carc: string }

const valuesOf = (f: FactLite | undefined): unknown[] => {
  if (!f || f.status === 'missing') return [];
  if (f.status === 'conflicting') return f.candidates.map((c) => c.value);
  return f.value === null || f.value === undefined ? [] : [f.value];
};

// Collects (group, CARC) pairs from the facts. The DED01 `adjustmentGroup` fact is, by
// construction of both extractors (EOB: server/services/evidence.ts; 835:
// server/connectors/observations.ts), the group of the CARC 1 (deductible) adjustment.
export function adjustmentPairs(facts: FactLite[]): { pairs: Adj[]; rarcs: string[] } {
  const by = (k: string) => facts.find((f) => f.key === k);
  const seen = new Map<string, Adj>();
  const add = (group: unknown, carc: unknown) => {
    if (typeof group !== 'string' || typeof carc !== 'string' || !group || !carc) return;
    seen.set(`${group}|${carc}`, { group, carc });
  };
  for (const v of valuesOf(by('lineAdjustments'))) if (Array.isArray(v)) for (const a of v) add(a?.group, a?.carc);
  for (const g of valuesOf(by('adjustmentGroup'))) add(g, '1');
  const rarcs = [...new Set(valuesOf(by('remarkCodes')).flatMap((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])))];
  return { pairs: [...seen.values()], rarcs };
}

export function AdjustmentCodes({ facts }: { facts: FactLite[] }) {
  const { pairs, rarcs } = adjustmentPairs(facts);
  if (!pairs.length) return null;
  return (
    <Panel title="Adjustment codes explained" id="codes-h" actions={<a className="small" href="#/knowledge">Knowledge base</a>}>
      <div className="stack">
        {pairs.map((p) => (
          <details key={`${p.group}-${p.carc}`} open={pairs.length === 1}>
            <summary className="mono">{p.group}-{p.carc}{rarcs.length ? ` · RARC ${rarcs.join(', ')}` : ''}</summary>
            <CodeExplain group={p.group} carc={p.carc} rarcs={rarcs} />
          </details>
        ))}
      </div>
    </Panel>
  );
}

interface VerbalRequest {
  answerId: string; callId: string; acceptedAt: string; kind: string; actionKinds: string[]; reconciled: boolean;
  reconciledBy: { type: string; ref: string; at: string; by?: string; reason?: string } | null;
}
const RECONCILED_TEXT: Record<string, string> = {
  receipt: 'payer receipt recorded', adjudication: 'adjudication change on remittance', no_request_on_file: 'payer reported no request on file', reviewer_override: 'released by reviewer',
};

export function VerbalRequests({ accountId, canRelease, revision, onChange }: { accountId: string; canRelease: boolean; revision: number; onChange: () => void }) {
  const [list, setList] = useState<VerbalRequest[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setList((await api.get<{ requests: VerbalRequest[] }>(`/api/accounts/${accountId}/verbal-requests`)).requests); } catch { setList([]); }
  }, [accountId]);
  useEffect(() => { load(); }, [load, revision]);
  if (!list.length) return null;
  const release = async (answerId: string) => {
    setBusy(true);
    try { await api.post(`/api/verbal-requests/${answerId}/release`, { reason }); toast('Verbal request released'); setReason(''); await load(); onChange(); }
    catch (e) { toast(errorText(e), true); } finally { setBusy(false); }
  };
  return (
    <Panel title="Verbal payer requests" id="verbal-h">
      <p className="small muted">A request the payer accepted on a call is not sent again through the outbox until it is reconciled.</p>
      {list.map((r) => (
        <div key={r.answerId} className="stack" style={{ marginBottom: 8 }}>
          <div className="row">
            <span>Reprocessing request accepted on call <span className="mono">{r.callId}</span> · {when(r.acceptedAt)}</span>
            <span className={`badge ${r.reconciled ? 'b-verified' : 'b-review'}`}>{r.reconciled ? 'Reconciled' : 'Open: blocks a new request'}</span>
          </div>
          {r.reconciledBy && <p className="small">{RECONCILED_TEXT[r.reconciledBy.type] ?? r.reconciledBy.type} · {when(r.reconciledBy.at)}{r.reconciledBy.reason ? ` · “${r.reconciledBy.reason}”` : ''}</p>}
          {!r.reconciled && canRelease && (
            <div className="stack">
              <label htmlFor={`rel-${r.answerId}`}>Release with reason (reviewer)</label>
              <textarea id={`rel-${r.answerId}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why a new request is justified (for example, the payer has no request on file)" />
              <div><button disabled={busy || reason.trim().length < 15} onClick={() => release(r.answerId)}>Release verbal request</button></div>
            </div>
          )}
        </div>
      ))}
    </Panel>
  );
}
