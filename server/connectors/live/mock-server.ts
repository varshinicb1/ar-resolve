// LOCAL MOCK of the live vendor APIs (ADR 0100), for the test suite and `smoke:live --mock`.
// It reproduces the documented request and response SHAPES only:
//   - Stedi: documented examples from the official OpenAPI spec, copied verbatim into
//     fixtures/vendors/stedi/ (each file names its source). For synthetic accounts it answers with
//     X12 built by this repo's generators, wrapped in the documented JSON envelope.
//   - Optum, Availity, Twilio, Postmark, Slack: field names and status codes from the pages cited in
//     each provider module; values are synthetic.
// It is not a model of any vendor's behaviour, latency or business rules. It runs on 127.0.0.1 only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { parseEdi } from '../x12/index.ts';
import { build271, build277 } from '../x12/responses.ts';

const FIX = new URL('../../../fixtures/vendors/stedi/', import.meta.url);
export const stediFixture = (name: string) => JSON.parse(readFileSync(new URL(name, FIX), 'utf8')) as { source: string; value: Record<string, unknown> };

export interface MockRecord { method: string; path: string; headers: Record<string, string>; body: string }
export interface Fault { status?: number; headers?: Record<string, string>; body?: string; delayMs?: number; hang?: boolean }

/** What a synthetic account looks like to the mock "payer". */
export interface MockClaim { claimReference: string; memberId: string; serviceDate: string; category: string; code: string; paidCents: number | null; chargeCents: number }
export interface MockEligibility { memberId: string; serviceDate: string; limitCents: number; remainingCents: number }
export interface MockEra { transactionId: string; mode: 'test' | 'production'; applicationMode: 'test' | 'production'; claims: { claimReference: string; memberId: string; serviceDate: string; paid: string; allowed: string; deductible: string; charge: string }[] }

export interface MockOptions {
  stediKey?: string; optum?: { id: string; secret: string }; availity?: { id: string; secret: string }; twilio?: { sid: string; token: string }; postmarkToken?: string;
  claims?: MockClaim[]; eligibility?: MockEligibility[]; eras?: MockEra[];
  availityInProcessPolls?: number;
}

export interface LiveMock {
  url: string; records: MockRecord[]; faults: Map<string, Fault[]>; options: MockOptions;
  /** Queue faults for a route key such as "stedi.eligibility". Each request consumes one. */
  fault(route: string, ...f: Fault[]): void;
  close(): Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

let control = 500000000;

function stedi271(x12: string, o: MockOptions): string | null {
  const t = parseEdi(x12).transactions[0];
  if (t.setId !== '270') return null;
  const q = t.data.query;
  const e = (o.eligibility ?? []).find((x) => x.memberId === q.memberId);
  const year = (e?.serviceDate ?? '2026-01-01').slice(0, 4);
  return build271({ sender: 'STEDI', receiver: 'ARRESOLVE', control: ++control, at: new Date(), payer: t.data.payer, provider: t.data.provider, reference: `M271-${control}`,
    answer: { query: q, found: !!e, planBegin: `${year}-01-01`, planEnd: `${year}-12-31`, planDescription: 'SYNTHETIC PLAN', individualLimitCents: e?.limitCents ?? null, individualRemainingCents: e?.remainingCents ?? null } });
}

function stedi277(x12: string, o: MockOptions): string | null {
  const t = parseEdi(x12).transactions[0];
  if (t.setId !== '276') return null;
  const answers = t.data.claims.map((q) => {
    const c = (o.claims ?? []).find((x) => x.claimReference === q.claimReference && x.memberId === q.memberId);
    return c ? { query: q, category: c.category, code: c.code, statusDate: c.serviceDate, chargeCents: c.chargeCents, paidCents: c.paidCents }
      : { query: q, category: 'A4', code: '35', statusDate: new Date().toISOString().slice(0, 10), chargeCents: null, paidCents: null };
  });
  return build277({ sender: 'STEDI', receiver: 'ARRESOLVE', control: ++control, at: new Date(), payer: t.data.payer, infoReceiver: { name: 'AR RESOLVE', id: 'ARRESOLVE' }, provider: t.data.provider, answers, reference: `M277-${control}` });
}

function eraReport(e: MockEra) {
  // Same field names as the documented example (fixtures/vendors/stedi/report-835.response.json).
  return { meta: { applicationMode: e.applicationMode, senderId: 'MOCK', transactionId: e.transactionId },
    transactions: [{ controlNumber: '000000001', productionDate: '20261010', detailInfo: [{ assignedNumber: '1', paymentInfo: e.claims.map((c) => ({
      claimPaymentInfo: { claimPaymentAmount: c.paid, claimStatusCode: '1', patientControlNumber: c.claimReference, payerClaimControlNumber: `PCN${c.claimReference}`, totalClaimChargeAmount: c.charge },
      patientName: { firstName: 'SYNTHETIC', lastName: 'PATIENT', memberId: c.memberId },
      serviceLines: [{ serviceDate: c.serviceDate.replace(/-/g, ''), serviceAdjustments: [{ adjustmentAmount1: c.deductible, adjustmentReasonCode1: '1', claimAdjustmentGroupCode: 'PR' }],
        servicePaymentInformation: { lineItemChargeAmount: c.charge, lineItemProviderPaymentAmount: c.paid }, serviceSupplementalAmounts: { allowedActual: c.allowed } }],
    })) }], financialInformation: { totalActualProviderPaymentAmount: e.claims.reduce((s, c) => s + Number(c.paid), 0).toFixed(2) } }] };
}

export async function startLiveMock(o: MockOptions = {}): Promise<LiveMock> {
  const records: MockRecord[] = [];
  const faults = new Map<string, Fault[]>();
  let availityPolls = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse, body: string) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    records.push({ method: req.method ?? '', path: p + url.search, headers, body });
    const route = routeKey(req.method ?? '', p);
    const f = faults.get(route)?.shift();
    if (f) {
      if (f.hang) return; // never answers: exercises the client timeout
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      if (f.status) { res.writeHead(f.status, { 'content-type': 'application/json', ...(f.headers ?? {}) }); res.end(f.body ?? JSON.stringify({ message: 'mock fault' })); return; }
    }
    // ---------------- Stedi (ST2, ST3, ST4, ST5, ST6)
    if (p.startsWith('/stedi-')) {
      if (headers.authorization !== o.stediKey) return json(res, 403, { message: 'Forbidden' });
      if (route === 'stedi.eligibility' || route === 'stedi.claimstatus') {
        let x12 = '';
        try { x12 = String(JSON.parse(body).x12 ?? ''); } catch { return json(res, 400, { message: 'invalid JSON' }); }
        if (route === 'stedi.eligibility' && x12 === stediFixture('eligibility-raw-x12.request.uhc-mock.json').value.x12) return json(res, 200, stediFixture('eligibility-raw-x12.response.200.json').value);
        if (route === 'stedi.claimstatus' && x12 === stediFixture('claim-status-raw-x12.request.accepted.json').value.x12) return json(res, 200, stediFixture('claim-status-raw-x12.response.accepted.json').value);
        let out: string | null = null;
        try { out = route === 'stedi.eligibility' ? stedi271(x12, o) : stedi277(x12, o); } catch { out = null; }
        if (!out) return json(res, 400, stediFixture('eligibility-raw-x12.response.400.json').value);
        return json(res, 200, { id: `mock_${control}`, controlNumber: String(control), x12: out });
      }
      if (route === 'stedi.poll') {
        if (!url.searchParams.get('pageToken') && !url.searchParams.get('startDateTime')) return json(res, 400, { message: 'pageToken or startDateTime required' });
        const documented = stediFixture('polling-transactions.response.json').value.items as Record<string, unknown>[];
        const items = [...documented, ...(o.eras ?? []).map((e) => ({ ...documented[0], transactionId: e.transactionId, direction: 'INBOUND', mode: e.mode, processedAt: new Date().toISOString(),
          x12: { metadata: { transaction: { controlNumber: '0001', transactionSetIdentifier: '835' } } } }))];
        return json(res, 200, { items, nextPageToken: 'mock-next-page' });
      }
      const m = /\/reports\/v2\/([^/]+)\/835$/.exec(p);
      if (m) {
        const e = (o.eras ?? []).find((x) => x.transactionId === decodeURIComponent(m[1]));
        if (e) return json(res, 200, eraReport(e));
        if (m[1] === (stediFixture('report-835.response.json').value.meta as { transactionId: string }).transactionId) return json(res, 200, stediFixture('report-835.response.json').value);
        return json(res, 404, { message: 'Not found' });
      }
      return json(res, 404, { message: 'Not found' });
    }
    // ---------------- Optum (OP1-OP6)
    if (p.startsWith('/optum/')) {
      if (route === 'optum.token') {
        const j = JSON.parse(body || '{}');
        if (!o.optum || j.client_id !== o.optum.id || j.client_secret !== o.optum.secret || j.grant_type !== 'client_credentials') return json(res, 401, { error: 'invalid_client' });
        return json(res, 200, { access_token: 'mock-optum-token', token_type: 'bearer', expires_in: 3600 });
      }
      if (headers.authorization !== 'Bearer mock-optum-token') return json(res, 401, { message: 'Unauthorized' });
      const j = JSON.parse(body || '{}');
      if (route === 'optum.claimstatus') {
        const c = (o.claims ?? []).find((x) => x.memberId === j.subscriber?.memberId);
        const claimStatus = c ? { amountPaid: c.paidCents === null ? '0' : (c.paidCents / 100).toFixed(2), claimServiceDate: c.serviceDate.replace(/-/g, ''), patientAccountNumber: c.claimReference,
          statusCategoryCode: c.category, statusCode: c.code, submittedAmount: (c.chargeCents / 100).toFixed(2) } : { statusCategoryCode: 'D0', statusCode: '35', amountPaid: '0' };
        return json(res, 200, { controlNumber: j.controlNumber, tradingPartnerServiceId: j.tradingPartnerServiceId, subscriber: { memberId: j.subscriber?.memberId }, claims: [{ claimStatus }] });
      }
      if (route === 'optum.eligibility') return json(res, 200, { controlNumber: j.controlNumber, planStatus: [{ statusCode: '1', status: 'Active Coverage', serviceTypeCodes: ['30'] }], benefitsInformation: [{ code: '1', name: 'Active Coverage', coverageLevelCode: 'IND', serviceTypeCodes: ['30'] }] });
      return json(res, 404, { message: 'Not found' });
    }
    // ---------------- Availity (AV1)
    if (p.startsWith('/availity/')) {
      if (route === 'availity.token') {
        const f2 = new URLSearchParams(body);
        if (!o.availity || f2.get('client_id') !== o.availity.id || f2.get('client_secret') !== o.availity.secret || f2.get('grant_type') !== 'client_credentials' || f2.get('scope') !== 'hipaa') return json(res, 401, { error: 'invalid_client' });
        return json(res, 200, { access_token: 'mock-availity-token', token_type: 'bearer', expires_in: 300 });
      }
      if (headers.authorization !== 'Bearer mock-availity-token') return json(res, 401, { message: 'Unauthorized' });
      const mockHeaders: Record<string, string> = headers['x-api-mock-scenario-id'] ? { 'x-api-mock-response': 'true' } : {};
      const status = availityPolls < (o.availityInProcessPolls ?? 0) ? '0' : '4';
      if (route === 'availity.coverages') { availityPolls++; return json(res, 200, { totalCount: 1, count: 1, offset: 0, limit: 50, links: {}, coverages: [{ id: 'cov-mock-1', status: status === '0' ? 'In Process' : 'Complete', statusCode: status }] }, mockHeaders); }
      if (route === 'availity.coverage') { availityPolls++; return json(res, 200, { id: 'cov-mock-1', status: status === '0' ? 'In Process' : 'Complete', statusCode: status }, mockHeaders); }
      return json(res, 404, { message: 'Not found' });
    }
    // ---------------- Twilio (TW-T1, TW-T2)
    if (p.startsWith('/twilio/')) {
      const expected = o.twilio ? `Basic ${Buffer.from(`${o.twilio.sid}:${o.twilio.token}`).toString('base64')}` : null;
      if (!expected || headers.authorization !== expected) return json(res, 401, { code: 20003, message: 'Authenticate', status: 401 });
      const f2 = new URLSearchParams(body);
      const codes: Record<string, number> = { '+15005550001': 21217, '+15005550002': 21214, '+15005550003': 21215, '+15005550004': 21216 };
      if (f2.get('From') !== '+15005550006') return json(res, 400, { code: 21210, message: 'From is not a valid phone number', status: 400 });
      const code = codes[f2.get('To') ?? ''];
      if (code) return json(res, 400, { code, message: 'mock test-credential error', status: 400 });
      return json(res, 201, { sid: 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'completed', to: f2.get('To'), from: f2.get('From') });
    }
    // ---------------- Postmark (PM1, PM2)
    if (p === '/postmark/email') {
      const token = headers['x-postmark-server-token'];
      if (token !== 'POSTMARK_API_TEST' && token !== o.postmarkToken) return json(res, 401, { ErrorCode: 10, Message: 'Bad or missing Server API token.' });
      const j = JSON.parse(body || '{}');
      if (!j.From || !j.To || !j.Subject) return json(res, 422, { ErrorCode: 300, Message: 'Invalid email request' });
      return json(res, 200, { To: j.To, SubmittedAt: new Date().toISOString(), MessageID: '00000000-0000-0000-0000-000000000000', ErrorCode: 0, Message: 'OK' });
    }
    // ---------------- Slack (SL1): any JSON body with text
    if (p.startsWith('/slack/services/')) {
      try { if (typeof JSON.parse(body).text !== 'string') throw new Error(); } catch { res.writeHead(400); res.end('invalid_payload'); return; }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return;
    }
    json(res, 404, { message: 'Not found' });
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { handle(req, res, body).catch((e) => json(res, 500, { message: String(e) })); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, records, faults, options: o,
    fault(route, ...f) { faults.set(route, [...(faults.get(route) ?? []), ...f]); },
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

export function routeKey(method: string, p: string): string {
  if (p.endsWith('/eligibility/v3/raw-x12')) return 'stedi.eligibility';
  if (p.endsWith('/claimstatus/v2/raw-x12')) return 'stedi.claimstatus';
  if (p.endsWith('/polling/transactions')) return 'stedi.poll';
  if (/\/reports\/v2\/[^/]+\/835$/.test(p)) return 'stedi.report835';
  if (p === '/optum/apip/auth/v2/token') return 'optum.token';
  if (p === '/optum/medicalnetwork/eligibility/v3/') return 'optum.eligibility';
  if (p === '/optum/medicalnetwork/claimstatus/v2/') return 'optum.claimstatus';
  if (p === '/availity/v1/token') return 'availity.token';
  if (p === '/availity/v1/coverages') return 'availity.coverages';
  if (/^\/availity\/v1\/coverages\/[^/]+$/.test(p)) return 'availity.coverage';
  if (p.startsWith('/twilio/')) return 'twilio.calls';
  if (p === '/postmark/email') return 'postmark.email';
  if (p.startsWith('/slack/')) return 'slack.post';
  return `${method} ${p}`;
}

/** Environment that points every provider at the mock (sandbox mode, loopback allowed). */
export function mockEnv(m: LiveMock, o: MockOptions): Record<string, string> {
  return {
    AR_LIVE_ALLOW_LOOPBACK: '1',
    AR_STEDI_MODE: 'sandbox', AR_STEDI_API_KEY: o.stediKey ?? '', AR_STEDI_HEALTHCARE_BASE_URL: `${m.url}/stedi-hc/2024-04-01`, AR_STEDI_CORE_BASE_URL: `${m.url}/stedi-core/2023-08-01`,
    AR_OPTUM_MODE: 'sandbox', AR_OPTUM_CLIENT_ID: o.optum?.id ?? '', AR_OPTUM_CLIENT_SECRET: o.optum?.secret ?? '', AR_OPTUM_BASE_URL: `${m.url}/optum`,
    AR_AVAILITY_MODE: 'sandbox', AR_AVAILITY_CLIENT_ID: o.availity?.id ?? '', AR_AVAILITY_CLIENT_SECRET: o.availity?.secret ?? '', AR_AVAILITY_BASE_URL: `${m.url}/availity/v1`, AR_AVAILITY_MOCK_SCENARIO_ID: 'mock-scenario',
    AR_TWILIO_MODE: 'sandbox', AR_TWILIO_TEST_ACCOUNT_SID: o.twilio?.sid ?? '', AR_TWILIO_TEST_AUTH_TOKEN: o.twilio?.token ?? '', AR_TWILIO_API_BASE_URL: `${m.url}/twilio`,
    AR_POSTMARK_MODE: 'sandbox', AR_POSTMARK_FROM: 'ar-resolve@example.com', AR_POSTMARK_SMOKE_TO: 'staff@example.com', AR_POSTMARK_BASE_URL: `${m.url}/postmark`,
    AR_SLACK_MODE: 'sandbox', AR_SLACK_WEBHOOK_URL: `https://hooks.slack.com/services/${['TEST', 'TEST', 'not-a-secret'].join('/')}`,
  };
}
