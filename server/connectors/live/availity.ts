// Availity Coverages API: real, gated adapter (ADR 0100). Replaces the disabled stub registered under
// the same id in live-adapters.ts (its checklist is kept for the UI).
//
// Source AV1 (retrieved 2026-10-14): https://developer.availity.com/blog/2025/10/31/availity-api-guide
//   Token: POST https://api.availity.com/availity/v1/token, grant_type=client_credentials, client_id, client_secret,
//   scope=hipaa (form fields, case sensitive); "The access token is only valid for five minutes" (expires_in 300).
//   Coverages: GET https://api.availity.com/availity/v1/coverages (example query payerId=..&providerNpi=..) with
//   "Authorization: Bearer <token>"; the answer may be statusCode 0 (In Process); poll .../coverages/{id} until 4
//   (Complete), pausing about 2 s between polls. Collection fields: totalCount, count, offset, limit, links, coverages[]
//   (each with id, status, statusCode, ...).
//   Demo plan: self-service, auto-approved, no cost, canned responses only; select a scenario with the
//   X-Api-Mock-Scenario-ID header and confirm with X-Api-Mock-Response: true. Standard plan needs a contract
//   through a Trading Partner Manager. Limits: Demo 5/s and 500/day; Standard 100/s and 100,000/day; every call
//   (token and polls included) counts; 429 when exceeded.
// NOT verified (public reference not readable here): the full list of Coverages query parameters, the
// Claim Statuses and Remittance endpoints, and a BAA. Query parameter names other than payerId and providerNpi
// are passed through from the caller (who reads them in Availity's reference) after a strict name check, and
// coverage answers are stored as connector events only, never turned into facts.
import type { Db } from '../../db/db.ts';
import type { Scope } from '../../services/auth.ts';
import { type AdapterResult, type ConnectorAdapter, type ConnectorRequest, registerAdapter } from '../framework.ts';
import { availity as availityStub } from '../live-adapters.ts';
import { baseUrl, modeOf, readVar } from './config.ts';
import { clientCredentialsToken, errorSummary, httpRequest, HttpFailure, type HttpResponse } from './http.ts';
import { providerGate } from './gate.ts';

export const AVAILITY_SOURCES = [
  { title: 'Availity API guide (AV1)', url: 'https://developer.availity.com/blog/2025/10/31/availity-api-guide', retrievedAt: '2026-10-14' },
  { title: 'Availity HIPAA transactions (S17, ADR 0030)', url: 'https://developer.availity.com/blog/2025/3/25/hipaa-transactions', retrievedAt: '2026-10-12' },
];

export const AVAILITY_POLL_MS = 2000;
const PARAM = /^[A-Za-z][A-Za-z0-9.]{1,40}$/;

async function token(timeoutMs: number): Promise<string> {
  const b = baseUrl('availity', 'api');
  if (!b.url) throw new Error(b.error ?? 'No base URL');
  const id = readVar('AR_AVAILITY_CLIENT_ID');
  const secret = readVar('AR_AVAILITY_CLIENT_SECRET');
  if (!id || !secret) throw new Error('Availity client credentials are not configured');
  return clientCredentialsToken({ cacheKey: `availity:${modeOf('availity')}:${b.url}:${id}`, tokenUrl: `${b.url}/token`, timeoutMs, marginMs: 30_000,
    form: { grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'hipaa' } });
}

function headers(t: string): Record<string, string> {
  const h: Record<string, string> = { authorization: `Bearer ${t}`, accept: 'application/json' };
  const scenario = readVar('AR_AVAILITY_MOCK_SCENARIO_ID');
  if (scenario && modeOf('availity') === 'sandbox') h['x-api-mock-scenario-id'] = scenario.slice(0, 80);
  return h;
}

const statusCodeOf = (j: unknown): string | null => {
  const o = j as { statusCode?: unknown; coverages?: { statusCode?: unknown }[] } | null;
  const v = o?.statusCode ?? o?.coverages?.[0]?.statusCode;
  return v === undefined || v === null ? null : String(v);
};
const idOf = (j: unknown): string | null => {
  const o = j as { id?: unknown; coverages?: { id?: unknown }[] } | null;
  const v = o?.id ?? o?.coverages?.[0]?.id;
  return typeof v === 'string' && /^[\w-]{1,80}$/.test(v) ? v : null;
};

export async function coverageInquiry(query: Record<string, string>, timeoutMs: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<AdapterResult> {
  const started = Date.now();
  const b = baseUrl('availity', 'api');
  if (!b.url) return { outcome: 'error', error: b.error ?? 'No base URL' };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (!PARAM.test(k) || typeof v !== 'string' || v.length > 80) return { outcome: 'rejected', error: `Invalid query parameter ${k}` };
    q.set(k, v);
  }
  try {
    const t = await token(timeoutMs);
    let r: HttpResponse = await httpRequest({ method: 'GET', url: `${b.url}/coverages?${q}`, headers: headers(t), idempotentRead: true, timeoutMs: Math.max(500, timeoutMs - (Date.now() - started)) });
    let polls = 0;
    // Asynchronous answers: statusCode 0 (In Process) until 4 (Complete) (AV1).
    while (r.status === 200 && statusCodeOf(r.json) === '0' && idOf(r.json)) {
      if (Date.now() - started + AVAILITY_POLL_MS > timeoutMs - 250) return { outcome: 'uncertain', error: 'Coverage still In Process when the time budget ran out', latencyMs: Date.now() - started, externalRefs: { coverageId: idOf(r.json)! }, normalized: { statusCode: '0', polls } };
      await sleep(AVAILITY_POLL_MS);
      polls++;
      r = await httpRequest({ method: 'GET', url: `${b.url}/coverages/${encodeURIComponent(idOf(r.json)!)}`, headers: headers(t), idempotentRead: true, timeoutMs: Math.max(500, timeoutMs - (Date.now() - started)) });
    }
    if (r.status !== 200) return { outcome: r.status === 400 ? 'rejected' : r.status === 404 ? 'not_found' : 'error', error: errorSummary(r), latencyMs: Date.now() - started };
    if (!r.json || typeof r.json !== 'object') return { outcome: 'error', error: 'Response is not JSON', latencyMs: Date.now() - started };
    const id = idOf(r.json);
    return { outcome: 'success', raw: r.text, latencyMs: Date.now() - started, externalRefs: id ? { coverageId: id } : {}, sourceTime: new Date().toISOString(),
      normalized: { statusCode: statusCodeOf(r.json), polls, mock: r.headers['x-api-mock-response'] === 'true', body: r.json }, evidenceLocator: { response: 'coverages', format: 'json' } };
  } catch (err) {
    if (err instanceof HttpFailure) return { outcome: err.kind === 'timeout' ? 'timeout' : 'error', error: err.message, latencyMs: Date.now() - started };
    return { outcome: 'error', error: (err as Error).message.slice(0, 300), latencyMs: Date.now() - started };
  }
}

export const availityAdapter: ConnectorAdapter = {
  descriptor: {
    ...availityStub.descriptor,
    capabilities: ['read_eligibility'],
    transactions: ['270/271 (Coverages API, asynchronous)'],
    configFields: [{ key: 'AR_AVAILITY_MODE', label: 'off | sandbox | production (environment)' }, { key: 'AR_AVAILITY_CLIENT_ID', label: 'Client ID' },
      { key: 'AR_AVAILITY_CLIENT_SECRET', label: 'Client secret', secret: true }, { key: 'AR_AVAILITY_MOCK_SCENARIO_ID', label: 'Demo scenario id (sandbox)' }],
    documentedPaths: [
      { path: 'POST https://api.availity.com/availity/v1/token (client_credentials, scope=hipaa, 300 s tokens)', source: AVAILITY_SOURCES[0].url },
      { path: 'GET https://api.availity.com/availity/v1/coverages ; GET .../coverages/{id} (poll until statusCode 4)', source: AVAILITY_SOURCES[0].url },
    ],
    notes: [
      'Sandbox = the self-service Demo plan (canned responses, 5 requests/s, 500/day). Real data needs the Standard plan through an Availity Trading Partner Manager contract.',
      'Only the token and Coverages calls are implemented; Claim Statuses and Remittance endpoints were not documented on the pages read.',
      'Coverage answers are stored as connector events only: the response mapping was not verified, so no facts are created.',
    ],
    sources: AVAILITY_SOURCES,
  },
  gate: (db: Db, scope: Scope) => providerGate(db, scope, 'availity').reasons,
  execute() { throw new Error('availity performs network I/O; use the async path'); },
  async executeAsync(_ctx, req: ConnectorRequest): Promise<AdapterResult> {
    if (req.actionClass !== 'read_eligibility') return { outcome: 'rejected', error: `Unsupported action class ${req.actionClass}` };
    const query = req.payload.query as Record<string, string> | undefined;
    if (!query || typeof query !== 'object') return { outcome: 'rejected', error: 'payload.query is required' };
    return coverageInquiry(query, Math.max(1000, req.timeBudgetMs - 250));
  },
};
registerAdapter(availityAdapter);
