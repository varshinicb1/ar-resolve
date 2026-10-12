// SIMULATED clearinghouse. Accepts 276 and 270 requests and answers with 277 and 271 built
// from the synthetic cohort (fixtures/synthetic-cohort.json), which stands in for the payer's
// own records. Latency is simulated (recorded, not slept) and faults can be injected.
// It is not a model of any real clearinghouse's behavior, codes or timing.
import { type Db, one, run, tx } from '../db/db.ts';
import { AppError, invalid, now } from '../util.ts';
import { requirePerm, can, type Scope } from '../services/auth.ts';
import { getAccountRow } from '../services/workflow.ts';
import { cohort, fetchDocuments } from './synthetic-source.ts';
import { type AdapterResult, type ConnectorAdapter, type ConnectorDescriptor, getConfig, invoke, newRequest, registerAdapter } from './framework.ts';
import { parseEdi } from './x12/index.ts';
import { build270, build276 } from './x12/generate.ts';
import { build271, build277, type StatusAnswer } from './x12/responses.ts';
import { attachItems, buildPreview, optionsFor, traceFor } from './ingest.ts';

const PAYER = { name: 'DEMO PAYER A', id: 'DEMOPAYER' };
const SUBMITTER = { name: 'AR RESOLVE SYNTHETIC', id: 'ARRSYN' };
const CH = { name: 'SIMULATED CLEARINGHOUSE', id: 'SIMCH' };
const CONTRACTUAL = 7500;

export const FAULTS = ['timeout', 'error', 'malformed', 'partial'] as const;
export type ChFault = (typeof FAULTS)[number];

// Faults are armed per tenant/client so one client's rehearsal never affects another.
const faultKey = (s: { tenantId: string; clientId: string }, f: ChFault) => `${s.tenantId}/${s.clientId}/${f}`;
export function setChFault(db: Db, scope: { tenantId: string; clientId: string }, fault: ChFault, remaining: number) {
  run(db, 'INSERT INTO sim_clearinghouse_faults VALUES (?, ?) ON CONFLICT(fault) DO UPDATE SET remaining = excluded.remaining', faultKey(scope, fault), remaining);
}
function takeFault(db: Db, scope: { tenantId: string; clientId: string }, fault: ChFault): boolean {
  return run(db, 'UPDATE sim_clearinghouse_faults SET remaining = remaining - 1 WHERE fault = ? AND remaining > 0', faultKey(scope, fault)) === 1;
}
export function listChFaults(db: Db, scope: { tenantId: string; clientId: string }) {
  return FAULTS.map((f) => ({ fault: f, remaining: one<{ remaining: number }>(db, 'SELECT remaining FROM sim_clearinghouse_faults WHERE fault=?', faultKey(scope, f))?.remaining ?? 0 }));
}

interface InvRow { external_id: string; patient_token: string; service_date: string; claim_reference: string; balance_cents: number }
function inventory(clientId: string): InvRow[] {
  const csv = cohort().inventories[clientId];
  if (!csv) return [];
  const [head, ...lines] = csv.trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => { const c = l.split(','); const r = Object.fromEntries(cols.map((k, i) => [k, c[i]])); return { ...r, balance_cents: Number(r.balance_cents) } as unknown as InvRow; });
}

let control = 200000000;

function answerStatus(clientId: string, q: StatusAnswer['query']): StatusAnswer {
  const inv = inventory(clientId).find((r) => r.claim_reference === q.claimReference);
  const today = now().toISOString().slice(0, 10);
  if (!inv) return { query: q, category: 'A4', code: '35', statusDate: today, chargeCents: null, paidCents: null };
  const eob = fetchDocuments(clientId, inv.external_id).find((d) => d.kind === 'eob')?.content as { patientToken: string; processedDate: string; lines: { allowedCents: number; adjustments: { amountCents: number }[] }[] } | undefined;
  const memberOnFile = eob?.patientToken ?? inv.patient_token;
  if (memberOnFile !== q.memberId) return { query: q, category: 'A4', code: '33', statusDate: today, chargeCents: null, paidCents: null };
  if (!eob) return { query: q, category: 'P1', code: '20', statusDate: today, chargeCents: inv.balance_cents + CONTRACTUAL, paidCents: null };
  const line = eob.lines[0];
  const paid = line.allowedCents - line.adjustments.reduce((s, a) => s + a.amountCents, 0);
  return { query: q, category: paid > 0 ? 'F1' : 'F4', code: paid > 0 ? '65' : '1', statusDate: eob.processedDate, chargeCents: line.allowedCents + CONTRACTUAL, paidCents: paid,
    payerClaimControlNumber: `DP${inv.external_id.replace(/\D/g, '')}SIM` };
}

const descriptor: ConnectorDescriptor = {
  id: 'sim_clearinghouse', displayName: 'Simulated clearinghouse (276/277, 270/271)', vendor: 'Simulator (synthetic)', kind: 'clearinghouse', defaultMode: 'simulated', liveCapable: false,
  capabilities: ['read_status', 'read_eligibility'], transactions: ['276→277', '270→271'], configFields: [{ key: 'latencyMs', label: 'Simulated latency (ms)' }, { key: 'structuredStatusFirst', label: 'Run structured status before calls' }],
  phi: false, requiresBaa: false,
  notes: ['Answers come from the synthetic cohort, not from any payer.', 'Status codes used: A4/35, A4/33, P1/20, F1/65, F4/1 (descriptions from the x12.org code lists).'],
  sources: [{ title: 'CMS Claim Status Request and Response (S13)', url: 'https://www.cms.gov/medicare/coding-billing/electronic-billing/claim-status-request-response', retrievedAt: 'build pack docs/17' },
    { title: 'x12.org claim status category codes', url: 'https://x12.org/codes/claim-status-category-codes', retrievedAt: '2026-10-12' },
    { title: 'x12.org claim status codes', url: 'https://x12.org/codes/claim-status-codes', retrievedAt: '2026-10-12' }],
};

export const simClearinghouse: ConnectorAdapter = {
  descriptor,
  execute(ctx, req): AdapterResult {
    const latencyMs = Number(ctx.config.settings.latencyMs ?? 120);
    if (takeFault(ctx.db, ctx.scope, 'timeout')) return { outcome: 'timeout', latencyMs: req.timeBudgetMs + 1, error: 'Simulated clearinghouse did not answer within the time budget' };
    if (takeFault(ctx.db, ctx.scope, 'error')) return { outcome: 'error', latencyMs, error: 'Simulated clearinghouse returned a system error (E1 equivalent)' };
    const x12 = String(req.payload.x12 ?? '');
    const parsed = parseEdi(x12);
    const t = parsed.transactions[0];
    const at = now();
    const env = { sender: 'SIMCH', receiver: parsed.interchange.sender || 'ARRSYN', control: ++control, at };
    let raw: string;
    let outcome: AdapterResult['outcome'] = 'success';
    if (t.setId === '276') {
      let answers = t.data.claims.map((q) => answerStatus(ctx.scope.clientId, q));
      if (takeFault(ctx.db, ctx.scope, 'partial') && answers.length > 1) { answers = answers.slice(0, 1); outcome = 'partially_completed'; }
      else if (answers.length && answers.every((a) => a.category === 'A4')) outcome = 'not_found';
      raw = build277({ ...env, payer: PAYER, infoReceiver: CH, provider: t.data.provider, answers, reference: `SIM277-${env.control}` });
    } else if (t.setId === '270') {
      const q = t.data.query;
      const inv = inventory(ctx.scope.clientId).find((r) => r.patient_token === q.memberId);
      const elig = inv ? fetchDocuments(ctx.scope.clientId, inv.external_id).find((d) => d.kind === 'eligibility')?.content as { planDesign?: string; deductibleLimitCents?: number; metBeforeThisClaimCents?: number; secondaryAtDos?: string } | undefined : undefined;
      const year = q.serviceDate.slice(0, 4);
      if (!inv || !elig) outcome = 'not_found';
      raw = build271({ ...env, payer: PAYER, provider: t.data.provider, reference: `SIM271-${env.control}`, answer: {
        query: q, found: !!(inv && elig), planBegin: `${year}-01-01`, planEnd: `${year}-12-31`, planDescription: 'SYNTHETIC PLAN',
        individualLimitCents: elig?.deductibleLimitCents ?? null,
        individualRemainingCents: elig?.deductibleLimitCents !== undefined && elig?.metBeforeThisClaimCents !== undefined ? elig.deductibleLimitCents - elig.metBeforeThisClaimCents : null,
        otherPayer: elig?.secondaryAtDos === 'active',
      } });
    } else {
      throw new AppError(400, 'unsupported_request', `The simulated clearinghouse accepts 276 or 270, not ${t.setId}`);
    }
    if (takeFault(ctx.db, ctx.scope, 'malformed')) raw = raw.slice(0, Math.floor(raw.length * 0.6));
    // Client side of the adapter: a response that fails envelope validation is an error, never data.
    try { parseEdi(raw); } catch (err) {
      return { outcome: 'error', raw, latencyMs, error: `Malformed response rejected: ${(err as Error).message}` };
    }
    return { outcome, raw, latencyMs, sourceTime: at.toISOString(), externalRefs: { interchangeControl: String(env.control), request: t.setId }, evidenceLocator: { response: t.setId === '276' ? '277' : '271' } };
  },
};
registerAdapter(simClearinghouse);

export function structuredStatusEnabled(db: Db, scope: Scope): boolean {
  return getConfig(db, scope, 'sim_clearinghouse').settings.structuredStatusFirst === true;
}

function adequacy(categories: string[]): { adequate: boolean; reason: string } {
  if (!categories.length) return { adequate: false, reason: 'No usable structured status; an authorized call or portal check may be needed' };
  const c = categories[0];
  if (c.startsWith('F')) return { adequate: true, reason: `Finalized (${c}): remittance detail should be used before any call` };
  if (c.startsWith('P')) return { adequate: true, reason: `Pending (${c}): a call is unlikely to add information yet; follow up later` };
  return { adequate: false, reason: `Status ${c} does not answer the question; an authorized call or portal check may be needed` };
}

// "Structured status first" research step (docs/07 channel strategy). Generates a 276,
// sends it to the simulated clearinghouse, ingests the matched 277 as evidence and reports
// whether the structured answer is adequate. Safe inside an existing transaction.
export function structuredStatusFirst(db: Db, scope: Scope, accountId: string, o: { reevaluate?: boolean } = {}) {
  const a = getAccountRow(db, scope, accountId);
  const x12 = build276({ sender: 'ARRSYN', receiver: 'SIMCH', control: ++control, at: now(), payer: PAYER, submitter: SUBMITTER, provider: { name: 'SYNTHETIC PROVIDER', id: a.provider_id },
    reference: `S276-${a.external_id}`, claims: [{ trace: `S-${a.external_id}`, memberId: a.patient_token, last: 'SYNTHETIC', first: 'PATIENT', claimReference: a.claim_reference, chargeCents: a.balance_cents, serviceDate: a.service_date }] });
  const req = newRequest(scope, 'read_status', { x12 }, { accountId, accountRevision: a.revision, timeBudgetMs: 5000 });
  const res = invoke(db, scope, 'sim_clearinghouse', req);
  const out = { connectorEventId: res.connectorEventId, outcome: res.outcome, latencyMs: res.latencyMs, error: res.error, request: x12, response: res.raw ?? null,
    statusCategories: [] as string[], attached: [] as unknown[], adequate: false, reason: '' };
  if (res.raw && (res.outcome === 'success' || res.outcome === 'partially_completed' || res.outcome === 'not_found')) {
    const p = buildPreview(db, scope, 'sim-277.edi', res.raw);
    if (!p.valid) { out.error = `Response rejected: ${p.error.message}`; out.reason = 'Malformed structured response; nothing ingested'; return out; }
    const mine = p.items.filter((i) => i.match.accountId === accountId || i.identity.claimReference === a.claim_reference);
    out.statusCategories = mine.flatMap((i) => (i.extracted.find((e) => e.factKey === 'claimStatusCategory')?.value as string | undefined) ?? []);
    const att = attachItems(db, scope, mine, `connector:sim_clearinghouse:${res.connectorEventId}`, { connectorEventId: res.connectorEventId, rawSha256: res.rawSha256 },
      optionsFor(db, scope, 'sim_clearinghouse'), 'sim_clearinghouse', o.reevaluate ?? true);
    out.attached = att.results;
  }
  Object.assign(out, adequacy(out.statusCategories));
  return out;
}

export function eligibilityInquiry(db: Db, scope: Scope, accountId: string) {
  const a = getAccountRow(db, scope, accountId);
  const x12 = build270({ sender: 'ARRSYN', receiver: 'SIMCH', control: ++control, at: now(), payer: PAYER, provider: { name: 'SYNTHETIC PROVIDER', id: a.provider_id }, reference: `S270-${a.external_id}`,
    originator: 'ARRSYN', query: { trace: traceFor(a.external_id), memberId: a.patient_token, last: 'SYNTHETIC', first: 'PATIENT', serviceDate: a.service_date } });
  const req = newRequest(scope, 'read_eligibility', { x12 }, { accountId, accountRevision: a.revision, timeBudgetMs: 5000 });
  const res = invoke(db, scope, 'sim_clearinghouse', req);
  const out = { connectorEventId: res.connectorEventId, outcome: res.outcome, latencyMs: res.latencyMs, error: res.error, request: x12, response: res.raw ?? null, attached: [] as unknown[] };
  if (res.raw && (res.outcome === 'success' || res.outcome === 'not_found')) {
    const p = buildPreview(db, scope, 'sim-271.edi', res.raw, optionsFor(db, scope, 'sim_clearinghouse'));
    if (!p.valid) { out.error = `Response rejected: ${p.error.message}`; return out; }
    const mine = p.items.filter((i) => i.match.accountId === accountId);
    out.attached = attachItems(db, scope, mine, `connector:sim_clearinghouse:${res.connectorEventId}`, { connectorEventId: res.connectorEventId, rawSha256: res.rawSha256 }, p.mappingOptions, 'sim_clearinghouse').results;
  }
  return out;
}

// API wrappers (scope + permission + transaction).
export function runStatusInquiry(db: Db, scope: Scope, accountId: string) {
  if (!can(scope, 'investigate') && !can(scope, 'integration_admin')) requirePerm(scope, 'investigate');
  return tx(db, () => structuredStatusFirst(db, scope, accountId));
}
export function runEligibilityInquiry(db: Db, scope: Scope, accountId: string) {
  if (!can(scope, 'investigate') && !can(scope, 'integration_admin')) requirePerm(scope, 'investigate');
  return tx(db, () => eligibilityInquiry(db, scope, accountId));
}
export function armFault(db: Db, scope: Scope, fault: unknown, remaining: unknown) {
  requirePerm(scope, 'integration_admin');
  if (!FAULTS.includes(fault as ChFault)) throw invalid(`Unknown fault; use one of ${FAULTS.join(', ')}`);
  setChFault(db, scope, fault as ChFault, Math.max(0, Math.min(5, Number(remaining ?? 1))));
  return listChFaults(db, scope);
}
