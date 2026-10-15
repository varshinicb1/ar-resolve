// Stedi Healthcare APIs: real, gated adapter (ADR 0100).
//
// Sources (all retrieved 2026-10-14; behaviour below comes only from these):
//   ST1 https://www.stedi.com/docs/healthcare/send-eligibility-checks
//       Raw X12 eligibility: POST https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3/raw-x12,
//       body {"x12": "<270>"}; header "Authorization: <api key>" (no Bearer prefix); ST03 005010X279A1; BHT03
//       1-50 chars and different from ST02. Payers may take up to 60 s; Stedi holds requests up to 120 s;
//       cancelling and retrying early can create duplicate payer requests.
//   ST2 https://www.stedi.com/docs/healthcare/api-reference/post-healthcare-eligibility-raw-x12
//       Response field `x12` carries the 271, or a 999 when the request failed validation. Supports test keys.
//   ST3 https://www.stedi.com/docs/healthcare/api-reference/post-healthcare-claim-status-raw-x12
//       POST https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/claimstatus/v2/raw-x12, body {"x12": "<276>"};
//       response `x12` carries the 277 or a 999. Production key only (no test mode for claim status).
//   ST4 https://www.stedi.com/docs/healthcare/api-reference  (auth header, test vs production keys, 429
//       TOO_MANY_REQUESTS, 403 invalid key, concurrency pool of 50 for real-time eligibility + claim status)
//   ST5 https://www.stedi.com/docs/healthcare/api-reference/get-poll-transactions
//       GET https://core.us.stedi.com/2023-08-01/polling/transactions?pageSize=..&(pageToken|startDateTime);
//       items[].transactionId, direction, mode, x12.metadata.transaction.transactionSetIdentifier, nextPageToken.
//   ST6 https://www.stedi.com/docs/healthcare/api-reference/get-healthcare-reports-835
//       GET https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/{transactionId}/835;
//       {meta: {applicationMode, transactionId}, transactions: [{detailInfo[].paymentInfo[].claimPaymentInfo ...}]}.
//   ST7 https://www.stedi.com/docs/healthcare/account-settings  (sandbox accounts are free and test-mode only;
//       production upgrade is self-serve and includes accepting a BAA)
//   ST8 https://www.stedi.com/docs/healthcare/claim-responses-overview  ("Processing ERAs always requires
//       transaction enrollment with the payer.")
//   ST9 Stedi OpenAPI specs (official, linked from ST6): https://raw.githubusercontent.com/Stedi/openApi/main/healthcare.json
//       and .../core.json. Documented examples are copied verbatim into fixtures/vendors/stedi/ for the mock server.
import type { Db } from '../../db/db.ts';
import type { Scope } from '../../services/auth.ts';
import { type AdapterResult, type ConnectorAdapter, type ConnectorRequest, registerAdapter } from '../framework.ts';
import { parseEdi } from '../x12/index.ts';
import { baseUrl, readVar } from './config.ts';
import { errorSummary, httpRequest, HttpFailure, type HttpResponse } from './http.ts';
import { providerGate } from './gate.ts';
import type { Extracted } from '../observations.ts';

export const STEDI_SOURCES = [
  { title: 'Stedi: submit eligibility checks (ST1)', url: 'https://www.stedi.com/docs/healthcare/send-eligibility-checks', retrievedAt: '2026-10-14' },
  { title: 'Stedi: Eligibility raw X12 API reference (ST2)', url: 'https://www.stedi.com/docs/healthcare/api-reference/post-healthcare-eligibility-raw-x12', retrievedAt: '2026-10-14' },
  { title: 'Stedi: Claim status raw X12 API reference (ST3)', url: 'https://www.stedi.com/docs/healthcare/api-reference/post-healthcare-claim-status-raw-x12', retrievedAt: '2026-10-14' },
  { title: 'Stedi: API reference, keys, limits, errors (ST4)', url: 'https://www.stedi.com/docs/healthcare/api-reference', retrievedAt: '2026-10-14' },
  { title: 'Stedi: Poll transactions (ST5)', url: 'https://www.stedi.com/docs/healthcare/api-reference/get-poll-transactions', retrievedAt: '2026-10-14' },
  { title: 'Stedi: 835 ERA report (ST6)', url: 'https://www.stedi.com/docs/healthcare/api-reference/get-healthcare-reports-835', retrievedAt: '2026-10-14' },
  { title: 'Stedi: account setup, sandbox and production, BAA (ST7)', url: 'https://www.stedi.com/docs/healthcare/account-settings', retrievedAt: '2026-10-14' },
  { title: 'Stedi: acknowledgments and ERAs overview (ST8)', url: 'https://www.stedi.com/docs/healthcare/claim-responses-overview', retrievedAt: '2026-10-14' },
  { title: 'Stedi: eligibility mock requests for test keys', url: 'https://www.stedi.com/docs/healthcare/api-reference/mock-requests-eligibility-checks', retrievedAt: '2026-10-14' },
  { title: 'Stedi OpenAPI spec (healthcare.json, official) (ST9)', url: 'https://raw.githubusercontent.com/Stedi/openApi/main/healthcare.json', retrievedAt: '2026-10-14' },
  { title: 'Stedi BAA v1.3', url: 'https://legal.stedi.com/legal/baa-4a521009', retrievedAt: '2026-10-14' },
];

export const STEDI_PATHS = {
  eligibilityRawX12: '/change/medicalnetwork/eligibility/v3/raw-x12',
  claimStatusRawX12: '/change/medicalnetwork/claimstatus/v2/raw-x12',
  pollTransactions: '/polling/transactions',
  report835: (transactionId: string) => `/change/medicalnetwork/reports/v2/${encodeURIComponent(transactionId)}/835`,
};

const UUIDISH = /^[0-9A-Za-z-]{8,64}$/;

function auth(): string {
  const key = readVar('AR_STEDI_API_KEY');
  if (!key) throw new Error('AR_STEDI_API_KEY is not configured');
  return key;
}

function classify(r: HttpResponse): AdapterResult['outcome'] {
  if (r.status === 400 || r.status === 422) return 'rejected';
  if (r.status === 404) return 'not_found';
  return 'error'; // 403 (key), 429 after retries, 5xx, 504
}

function failure(err: unknown, started: number): AdapterResult {
  if (err instanceof HttpFailure) return { outcome: err.kind === 'timeout' ? 'timeout' : 'error', error: err.message, latencyMs: Date.now() - started };
  return { outcome: 'error', error: (err as Error).message.slice(0, 300), latencyMs: Date.now() - started };
}

/** Raw X12 exchange: validates the 2xx body has an `x12` interchange that parses and holds the expected set (or a 999). */
async function rawX12(path: string, x12: string, expect: '271' | '277', timeoutMs: number): Promise<AdapterResult> {
  const started = Date.now();
  const base = baseUrl('stedi', 'healthcare');
  if (!base.url) return { outcome: 'error', error: base.error ?? 'No base URL' };
  let r: HttpResponse;
  try {
    // A read: retried only on 429/503 (not processed). Never on timeouts (ST1: duplicate payer requests).
    r = await httpRequest({ method: 'POST', url: base.url + path, headers: { authorization: auth(), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ x12 }), idempotentRead: true, timeoutMs });
  } catch (err) { return failure(err, started); }
  const body = r.json as { x12?: unknown; errors?: { code?: string; description?: string }[]; status?: string; id?: string; controlNumber?: string } | null;
  if (r.status < 200 || r.status >= 300) {
    const codes = Array.isArray(body?.errors) ? body!.errors.map((e) => e.code).filter(Boolean) : [];
    return { outcome: classify(r), error: `${errorSummary(r)}${codes.length ? ` (codes ${codes.join(', ')})` : ''}`, latencyMs: r.latencyMs, raw: r.text, normalized: { httpStatus: r.status, errorCodes: codes } };
  }
  if (!body || typeof body.x12 !== 'string' || !body.x12.startsWith('ISA')) return { outcome: 'error', error: 'Response has no x12 interchange (validation failed)', latencyMs: r.latencyMs, raw: r.text };
  let sets: string[];
  try { sets = parseEdi(body.x12).transactions.map((t) => t.setId); } catch (err) {
    return { outcome: 'error', error: `Malformed X12 in response rejected: ${(err as Error).message}`, latencyMs: r.latencyMs, raw: body.x12 };
  }
  const refs: Record<string, string> = {};
  if (typeof body.id === 'string') refs.stediId = body.id;
  if (typeof body.controlNumber === 'string') refs.controlNumber = body.controlNumber;
  if (sets.includes('999') && !sets.includes(expect)) {
    return { outcome: 'rejected', error: 'Stedi returned a 999: the request failed X12 validation', raw: body.x12, latencyMs: r.latencyMs, externalRefs: refs, normalized: { sets, attempts: r.attempts } };
  }
  if (!sets.includes(expect)) return { outcome: 'error', error: `Expected a ${expect}, got ${sets.join(', ')}`, raw: body.x12, latencyMs: r.latencyMs };
  return { outcome: 'success', raw: body.x12, latencyMs: r.latencyMs, externalRefs: refs, sourceTime: new Date().toISOString(), evidenceLocator: { response: expect, format: 'x12' },
    normalized: { sets, attempts: r.attempts, stediStatus: body.status ?? null } };
}

export interface PolledEra { transactionId: string; mode: string | null; processedAt: string | null; report: unknown }

/** 835 retrieval: poll processed transactions, keep inbound 835s, fetch each ERA report (JSON). Reads only. */
async function pollRemittance(payload: Record<string, unknown>, timeoutMs: number): Promise<AdapterResult> {
  const started = Date.now();
  const core = baseUrl('stedi', 'core');
  const hc = baseUrl('stedi', 'healthcare');
  if (!core.url || !hc.url) return { outcome: 'error', error: core.error ?? hc.error ?? 'No base URL' };
  const q = new URLSearchParams({ pageSize: String(Math.max(1, Math.min(500, Number(payload.pageSize ?? 100)))) });
  if (typeof payload.pageToken === 'string' && payload.pageToken) q.set('pageToken', payload.pageToken.slice(0, 1024));
  else if (typeof payload.startDateTime === 'string' && !Number.isNaN(Date.parse(payload.startDateTime))) q.set('startDateTime', new Date(payload.startDateTime).toISOString());
  else return { outcome: 'rejected', error: 'pageToken or startDateTime is required (ST5)' };
  try {
    const key = auth();
    const r = await httpRequest({ method: 'GET', url: `${core.url}${STEDI_PATHS.pollTransactions}?${q}`, headers: { authorization: key, accept: 'application/json' }, idempotentRead: true, timeoutMs });
    if (r.status !== 200) return { outcome: classify(r), error: errorSummary(r), latencyMs: r.latencyMs };
    const page = r.json as { items?: unknown; nextPageToken?: unknown } | null;
    if (!page || !Array.isArray(page.items)) return { outcome: 'error', error: 'Polling response has no items array', latencyMs: r.latencyMs, raw: r.text };
    const items = page.items as { transactionId?: string; direction?: string; mode?: string; processedAt?: string; x12?: { metadata?: { transaction?: { transactionSetIdentifier?: string } } } }[];
    const eras = items.filter((i) => i.direction === 'INBOUND' && i.x12?.metadata?.transaction?.transactionSetIdentifier === '835' && typeof i.transactionId === 'string' && UUIDISH.test(i.transactionId)).slice(0, 25);
    const out: PolledEra[] = [];
    for (const e of eras) {
      const left = timeoutMs - (Date.now() - started);
      if (left <= 200) break;
      const rr = await httpRequest({ method: 'GET', url: hc.url + STEDI_PATHS.report835(e.transactionId!), headers: { authorization: key, accept: 'application/json' }, idempotentRead: true, timeoutMs: left });
      if (rr.status !== 200 || !rr.json || !Array.isArray((rr.json as { transactions?: unknown }).transactions)) {
        return { outcome: 'partially_completed', error: `ERA ${e.transactionId}: ${errorSummary(rr)}`, latencyMs: Date.now() - started, raw: JSON.stringify({ eras: out }),
          normalized: { eras: out, nextPageToken: null, seen: items.length } };
      }
      out.push({ transactionId: e.transactionId!, mode: e.mode ?? null, processedAt: e.processedAt ?? null, report: rr.json });
    }
    const next = typeof page.nextPageToken === 'string' ? page.nextPageToken : null;
    return { outcome: 'success', latencyMs: Date.now() - started, raw: JSON.stringify({ eras: out }), normalized: { eras: out, nextPageToken: next, seen: items.length },
      externalRefs: { eras: String(out.length) }, evidenceLocator: { response: '835 report JSON' } };
  } catch (err) { return failure(err, started); }
}

// ---------------------------------------------------------------- 835 report JSON -> observations

/** Exact decimal string ("108.77", "500") to integer cents; refuses more than 2 decimals or junk. */
export function decimalToCents(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string' || !/^-?\d{1,12}(\.\d{1,2})?$/.test(v.trim())) return null;
  const [w, f = ''] = v.trim().replace('-', '').split('.');
  const c = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return v.trim().startsWith('-') ? -c : c;
}

const ymd = (s: unknown) => (typeof s === 'string' && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);

export interface EraClaim { claimReference: string | null; memberId: string | null; serviceDate: string | null; path: string; extracted: Extracted[]; record: Record<string, unknown> }

/** Maps one Stedi 835 report (ST6 field names, verified against the documented example) to per-claim observations. */
export function mapEraReport(report: unknown, base: Record<string, unknown>): EraClaim[] {
  const out: EraClaim[] = [];
  const txs = (report as { transactions?: unknown[] })?.transactions;
  if (!Array.isArray(txs)) return out;
  txs.forEach((t, ti) => {
    const tr = t as { productionDate?: string; controlNumber?: string; detailInfo?: { paymentInfo?: unknown[] }[] };
    const processed = ymd(tr.productionDate);
    (tr.detailInfo ?? []).forEach((d, di) => (d.paymentInfo ?? []).forEach((p, pi) => {
      const pay = p as { claimPaymentInfo?: Record<string, string>; patientName?: { memberId?: string }; serviceLines?: { serviceDate?: string; serviceAdjustments?: Record<string, string>[]; serviceSupplementalAmounts?: { allowedActual?: string } }[] };
      const cpi = pay.claimPaymentInfo ?? {};
      const path = `transactions[${ti}].detailInfo[${di}].paymentInfo[${pi}]`;
      const at = (field: string) => ({ ...base, format: 'stedi_835_report_json', transaction: `835 ${tr.controlNumber ?? ''}`.trim(), path: `${path}.${field}` });
      const ex: Extracted[] = [];
      const push = (factKey: string, value: unknown, field: string, unit: string | null = null) => { if (value !== null && value !== undefined && value !== '') ex.push({ factKey, value, unit, locator: at(field) }); };
      // CLP02 22 is a reversal (ADR 0030): no observations, same as the X12 path.
      const reversal = cpi.claimStatusCode === '22';
      const line = pay.serviceLines?.[0];
      const dos = ymd(line?.serviceDate);
      if (!reversal) {
        push('claimReference', cpi.patientControlNumber, 'claimPaymentInfo.patientControlNumber');
        push('eobPatientToken', pay.patientName?.memberId, 'patientName.memberId');
        push('eobServiceDate', dos, 'serviceLines[0].serviceDate');
        push('allowedCents', decimalToCents(line?.serviceSupplementalAmounts?.allowedActual), 'serviceLines[0].serviceSupplementalAmounts.allowedActual', 'USD_cents');
        const ded = line?.serviceAdjustments?.find((a) => a.adjustmentReasonCode1 === '1');
        if (ded) {
          push('adjustmentGroup', ded.claimAdjustmentGroupCode, 'serviceLines[0].serviceAdjustments[reason 1].claimAdjustmentGroupCode');
          push('appliedCents', decimalToCents(ded.adjustmentAmount1), 'serviceLines[0].serviceAdjustments[reason 1].adjustmentAmount1', 'USD_cents');
        }
        push('claimPaidCents', decimalToCents(cpi.claimPaymentAmount), 'claimPaymentInfo.claimPaymentAmount', 'USD_cents');
        push('processedDate', processed, `transactions[${ti}].productionDate`);
      }
      out.push({ claimReference: cpi.patientControlNumber ?? null, memberId: pay.patientName?.memberId ?? null, serviceDate: dos, path, extracted: ex,
        record: { claimStatusCode: cpi.claimStatusCode ?? null, payerClaimControlNumber: cpi.payerClaimControlNumber ?? null, reversal } });
    }));
  });
  return out;
}

// ---------------------------------------------------------------- adapter

export const stediAdapter: ConnectorAdapter = {
  descriptor: {
    id: 'stedi', displayName: 'Stedi (real-time eligibility, claim status, 835 ERAs)', vendor: 'Stedi', kind: 'clearinghouse', defaultMode: 'disabled_live', liveCapable: true,
    capabilities: ['read_eligibility', 'read_status', 'read_remittance'],
    transactions: ['270/271 (raw X12, real-time)', '276/277 (raw X12, real-time; production keys only)', '835 (transaction polling + ERA report)'],
    configFields: [{ key: 'AR_STEDI_MODE', label: 'off | sandbox | production (environment)' }, { key: 'AR_STEDI_API_KEY', label: 'API key (environment or AR_STEDI_API_KEY_FILE)', secret: true }],
    documentedPaths: [
      { path: `POST https://healthcare.us.stedi.com/2024-04-01${STEDI_PATHS.eligibilityRawX12}`, source: STEDI_SOURCES[1].url },
      { path: `POST https://healthcare.us.stedi.com/2024-04-01${STEDI_PATHS.claimStatusRawX12}`, source: STEDI_SOURCES[2].url },
      { path: `GET https://core.us.stedi.com/2023-08-01${STEDI_PATHS.pollTransactions}`, source: STEDI_SOURCES[4].url },
      { path: 'GET https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/{transactionId}/835', source: STEDI_SOURCES[5].url },
    ],
    phi: true, requiresBaa: true,
    notes: [
      'Sandbox (free account, Test-mode API key) returns mock eligibility responses only for Stedi\'s documented mock requests; claim status has no test mode (production keys only).',
      'Production needs a paid account (self-serve upgrade includes accepting Stedi\'s BAA) and, for ERAs, transaction enrollment with each payer.',
      'Account-driven calls send the account\'s identifiers as stored. A real member-ID crosswalk is still blocked on a design partner (ADR 0030), so production 271/277 answers only match accounts whose patient token is the member ID.',
    ],
    sources: STEDI_SOURCES,
    vendors: ['stedi'],
  } as ConnectorAdapter['descriptor'] & { vendors: string[] },
  gate: (db: Db, scope: Scope) => providerGate(db, scope, 'stedi').reasons,
  execute() { throw new Error('stedi performs network I/O; use the async path'); },
  async executeAsync(_ctx, req: ConnectorRequest): Promise<AdapterResult> {
    const budget = Math.max(1000, req.timeBudgetMs - 250);
    if (req.actionClass === 'read_eligibility') return rawX12(STEDI_PATHS.eligibilityRawX12, String(req.payload.x12 ?? ''), '271', budget);
    if (req.actionClass === 'read_status') return rawX12(STEDI_PATHS.claimStatusRawX12, String(req.payload.x12 ?? ''), '277', budget);
    if (req.actionClass === 'read_remittance') return pollRemittance(req.payload, budget);
    return { outcome: 'rejected', error: `Unsupported action class ${req.actionClass}` };
  },
};
registerAdapter(stediAdapter);
