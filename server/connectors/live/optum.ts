// Optum / Change Healthcare Medical Network: real, gated adapter (ADR 0100). Replaces the disabled
// stub registered under the same id in live-adapters.ts (its checklist is kept for the UI).
//
// Sources (retrieved 2026-10-14):
//   OP1 https://developer.optum.com/eligibilityandclaims/docs/api-environments
//       Token: https://sandbox-apigw.optum.com/apip/auth/v2/token (sandbox), https://apigw.optum.com/apip/auth/v2/token (production).
//   OP2 https://developer.optum.com/eligibilityandclaims/docs/try-test-apis
//       Token request: POST, content-type application/json, body {client_id, client_secret, grant_type: "client_credentials"}.
//   OP3 https://developer.optum.com/eligibilityandclaims/docs/api-onboarding
//       grant_type is always client_credentials; token lifetime 3600 s; sandbox credentials are requested on the
//       Optum Marketplace; production credentials after a signed contract or subscription. Sample request uses
//       "Authorization: Bearer <token>", accept/content-type application/json, to .../medicalnetwork/eligibility/v3/.
//   OP4 https://developer.optum.com/eligibilityandclaims/docs/api-urls
//       Bases https://sandbox-apigw.optum.com/medicalnetwork/ and https://apigw.optum.com/medicalnetwork/;
//       eligibility/v3, claimstatus/v2/ (JSON and raw-x12).
//   OP5 https://developer.optum.com/eligibilityandclaims/docs/claim-status-api-example
//       Claim status JSON fields: controlNumber, tradingPartnerServiceId, providers[] {organizationName, npi|taxId,
//       providerType}, subscriber {memberId, firstName, lastName, gender, dateOfBirth}, encounter
//       {beginningDateOfService, endDateOfService, trackingNumber}; response claims[].claimStatus {statusCategoryCode,
//       statusCode, amountPaid, claimServiceDate, ...}.
//   OP6 https://developer.optum.com/eligibilityandclaims/docs/eligibility-request-with-known-tradingpartnerserviceid
//       Eligibility JSON fields: controlNumber, tradingPartnerServiceId, provider {organizationName, npi},
//       subscriber {firstName, lastName, dateOfBirth}, encounter {dateOfService}; response planStatus[], benefitsInformation[].
//   OP7 https://developer.optum.com/eligibilityandclaims/docs/sandbox-predefined-fields-and-values and
//       .../claim-status-sandbox-api-values-and-test-responses: sandbox answers only predefined values.
// NOT verified: rate limits (not stated), the error body shape, and the eligibility benefit amount fields
// (absent from the sample), so eligibility answers are recorded as connector events and NOT turned into facts.
import type { Db } from '../../db/db.ts';
import type { Scope } from '../../services/auth.ts';
import { type AdapterResult, type ConnectorAdapter, type ConnectorRequest, registerAdapter } from '../framework.ts';
import { optum as optumStub } from '../live-adapters.ts';
import { baseUrl, modeOf, readVar } from './config.ts';
import { clientCredentialsToken, errorSummary, httpRequest, HttpFailure } from './http.ts';
import { providerGate } from './gate.ts';
import { decimalToCents } from './stedi.ts';
import type { Extracted } from '../observations.ts';

export const OPTUM_SOURCES = [
  { title: 'Optum API environments (OP1)', url: 'https://developer.optum.com/eligibilityandclaims/docs/api-environments', retrievedAt: '2026-10-14' },
  { title: 'Optum try test APIs, token request (OP2)', url: 'https://developer.optum.com/eligibilityandclaims/docs/try-test-apis', retrievedAt: '2026-10-14' },
  { title: 'Optum API onboarding (OP3)', url: 'https://developer.optum.com/eligibilityandclaims/docs/api-onboarding', retrievedAt: '2026-10-14' },
  { title: 'Optum API URLs (OP4)', url: 'https://developer.optum.com/eligibilityandclaims/docs/api-urls', retrievedAt: '2026-10-14' },
  { title: 'Optum claim status request and response (OP5)', url: 'https://developer.optum.com/eligibilityandclaims/docs/claim-status-api-example', retrievedAt: '2026-10-14' },
  { title: 'Optum eligibility request example (OP6)', url: 'https://developer.optum.com/eligibilityandclaims/docs/eligibility-request-with-known-tradingpartnerserviceid', retrievedAt: '2026-10-14' },
  { title: 'Optum sandbox predefined values (OP7)', url: 'https://developer.optum.com/eligibilityandclaims/docs/sandbox-predefined-fields-and-values', retrievedAt: '2026-10-14' },
  { title: 'Optum create a sandbox account', url: 'https://developer.optum.com/eligibilityandclaims/docs/create-a-sandbox-account', retrievedAt: '2026-10-14' },
];

export const OPTUM_PATHS = { token: '/apip/auth/v2/token', eligibility: '/medicalnetwork/eligibility/v3/', claimStatus: '/medicalnetwork/claimstatus/v2/' };

async function token(timeoutMs: number): Promise<string> {
  const b = baseUrl('optum', 'api');
  if (!b.url) throw new Error(b.error ?? 'No base URL');
  const id = readVar('AR_OPTUM_CLIENT_ID');
  const secret = readVar('AR_OPTUM_CLIENT_SECRET');
  if (!id || !secret) throw new Error('Optum client credentials are not configured');
  return clientCredentialsToken({ cacheKey: `optum:${modeOf('optum')}:${b.url}:${id}`, tokenUrl: b.url + OPTUM_PATHS.token, timeoutMs,
    json: { client_id: id, client_secret: secret, grant_type: 'client_credentials' } });
}

async function postJson(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<AdapterResult> {
  const started = Date.now();
  const b = baseUrl('optum', 'api');
  if (!b.url) return { outcome: 'error', error: b.error ?? 'No base URL' };
  try {
    const t = await token(timeoutMs);
    const r = await httpRequest({ method: 'POST', url: b.url + path, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), idempotentRead: true, timeoutMs: Math.max(500, timeoutMs - (Date.now() - started)) });
    if (r.status < 200 || r.status >= 300) return { outcome: r.status === 400 || r.status === 422 ? 'rejected' : r.status === 404 ? 'not_found' : 'error', error: errorSummary(r), latencyMs: Date.now() - started };
    if (!r.json || typeof r.json !== 'object') return { outcome: 'error', error: 'Response is not JSON', latencyMs: Date.now() - started };
    return { outcome: 'success', raw: r.text, normalized: r.json, latencyMs: Date.now() - started, sourceTime: new Date().toISOString(), evidenceLocator: { response: path, format: 'json' } };
  } catch (err) {
    if (err instanceof HttpFailure) return { outcome: err.kind === 'timeout' ? 'timeout' : 'error', error: err.message, latencyMs: Date.now() - started };
    return { outcome: 'error', error: (err as Error).message.slice(0, 300), latencyMs: Date.now() - started };
  }
}

/** Claim status JSON -> observations, field names from OP5. Identity: patientAccountNumber when the payer echoes it. */
export function mapClaimStatusJson(resp: unknown, base: Record<string, unknown>) {
  const claims = (resp as { claims?: unknown[] })?.claims;
  if (!Array.isArray(claims)) return [];
  return claims.map((c, i) => {
    const s = ((c as { claimStatus?: Record<string, string> }).claimStatus ?? {});
    const at = (field: string) => ({ ...base, format: 'claimstatus_v2_json', path: `claims[${i}].claimStatus.${field}` });
    const ex: Extracted[] = [];
    if (s.patientAccountNumber) ex.push({ factKey: 'claimReference', value: s.patientAccountNumber, unit: null, locator: at('patientAccountNumber') });
    if (s.statusCategoryCode) ex.push({ factKey: 'claimStatusCategory', value: s.statusCategoryCode, unit: null, locator: at('statusCategoryCode') });
    const paid = decimalToCents(s.amountPaid);
    if (paid !== null) ex.push({ factKey: 'claimPaidCents', value: paid, unit: 'USD_cents', locator: at('amountPaid') });
    const dos = typeof s.claimServiceDate === 'string' && /^\d{8}/.test(s.claimServiceDate) ? `${s.claimServiceDate.slice(0, 4)}-${s.claimServiceDate.slice(4, 6)}-${s.claimServiceDate.slice(6, 8)}` : null;
    return { index: i, claimReference: s.patientAccountNumber ?? null, serviceDate: dos, category: s.statusCategoryCode ?? null, code: s.statusCode ?? null, extracted: ex };
  });
}

export const optumAdapter: ConnectorAdapter = {
  descriptor: {
    ...optumStub.descriptor,
    displayName: 'Optum / Change Healthcare (eligibility v3, claim status v2)',
    capabilities: ['read_status', 'read_eligibility'],
    transactions: ['270/271 (Eligibility v3 JSON)', '276/277 (Claim Status v2 JSON)'],
    configFields: [{ key: 'AR_OPTUM_MODE', label: 'off | sandbox | production (environment)' }, { key: 'AR_OPTUM_CLIENT_ID', label: 'Client ID' }, { key: 'AR_OPTUM_CLIENT_SECRET', label: 'Client secret', secret: true }],
    documentedPaths: [
      { path: 'POST https://sandbox-apigw.optum.com/apip/auth/v2/token | https://apigw.optum.com/apip/auth/v2/token', source: OPTUM_SOURCES[0].url },
      { path: 'POST {base}/medicalnetwork/eligibility/v3/ ; {base}/medicalnetwork/claimstatus/v2/', source: OPTUM_SOURCES[3].url },
    ],
    notes: [
      'Sandbox answers only Optum\'s predefined values (OP7); real-world or invented values return errors.',
      'Claim status answers become claimStatusCategory / claimPaidCents facts only when the payer echoes the patient account number and it matches one account; eligibility answers are stored as connector events only (benefit amount fields not verified).',
      'Rate limits are not stated on the pages read.',
    ],
    sources: OPTUM_SOURCES,
  },
  gate: (db: Db, scope: Scope) => providerGate(db, scope, 'optum').reasons,
  execute() { throw new Error('optum performs network I/O; use the async path'); },
  async executeAsync(_ctx, req: ConnectorRequest): Promise<AdapterResult> {
    const budget = Math.max(1000, req.timeBudgetMs - 250);
    const body = req.payload.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') return { outcome: 'rejected', error: 'payload.body (the request JSON) is required' };
    if (req.actionClass === 'read_eligibility') return postJson(OPTUM_PATHS.eligibility, body, budget);
    if (req.actionClass === 'read_status') return postJson(OPTUM_PATHS.claimStatus, body, budget);
    return { outcome: 'rejected', error: `Unsupported action class ${req.actionClass}` };
  },
};
registerAdapter(optumAdapter);
