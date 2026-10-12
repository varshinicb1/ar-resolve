// LOCAL MOCK FHIR R4 server with a SMART backend-services token endpoint. Serves synthetic
// resources built from the synthetic cohort for one client. Shapes follow the R4 pages read
// for this build (ExplanationOfBenefit, Coverage, ClaimResponse, Claim; adjudication code system
// http://terminology.hl7.org/CodeSystem/adjudication). It is a test double, not a FHIR server.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, type KeyObject } from 'node:crypto';
import { cohort, fetchDocuments } from '../synthetic-source.ts';
import { verifyAssertion, CLIENT_ASSERTION_TYPE } from './smart.ts';
import type { FhirResource } from './client.ts';

const ADJ = 'http://terminology.hl7.org/CodeSystem/adjudication';
export const ALLOWED_SCOPES = ['system/Coverage.rs', 'system/ExplanationOfBenefit.rs', 'system/Claim.rs', 'system/ClaimResponse.rs', 'system/Patient.rs'];

const money = (cents: number) => ({ value: cents / 100, currency: 'USD' });

export function syntheticResources(clientId: string): FhirResource[] {
  const csv = cohort().inventories[clientId];
  if (!csv) return [];
  const [head, ...lines] = csv.trim().split('\n');
  const cols = head.split(',');
  const out: FhirResource[] = [];
  for (const l of lines) {
    const r = Object.fromEntries(cols.map((k, i) => [k, l.split(',')[i]]));
    const ext = r.external_id;
    const docs = fetchDocuments(clientId, ext);
    const eob = docs.find((d) => d.kind === 'eob')?.content as { claimReference: string; patientToken: string; serviceDate: string; processedDate: string; lines: { allowedCents: number; adjustments: { group: string; carc: string; amountCents: number }[] }[] } | undefined;
    const elig = docs.find((d) => d.kind === 'eligibility')?.content as { secondaryAtDos?: string } | undefined;
    const token = eob?.patientToken ?? r.patient_token;
    out.push({ resourceType: 'Patient', id: `pat-${ext}`, identifier: [{ system: 'urn:synthetic:patient-token', value: token }],
      name: [{ family: 'SYNTHETIC', given: ['PATIENT'] }], birthDate: '1970-01-01', gender: 'unknown' });
    if (elig) out.push({ resourceType: 'Coverage', id: `cov-${ext}`, status: 'active', beneficiary: { reference: `Patient/pat-${ext}` }, payor: [{ display: 'Demo Payer A' }],
      period: { start: `${r.service_date.slice(0, 4)}-01-01`, end: `${r.service_date.slice(0, 4)}-12-31` }, order: 1 });
    out.push({ resourceType: 'Claim', id: `clm-${ext}`, identifier: [{ system: 'urn:synthetic:claim', value: r.claim_reference }], status: 'active', type: { coding: [{ code: 'professional' }] },
      use: 'claim', patient: { reference: `Patient/pat-${ext}` }, created: r.service_date, provider: { display: 'Synthetic Provider' }, priority: { coding: [{ code: 'normal' }] },
      insurance: [{ sequence: 1, focal: true, coverage: { reference: `Coverage/cov-${ext}` } }],
      item: [{ sequence: 1, productOrService: { text: 'SYN-PROC-1' }, servicedDate: r.service_date, net: money(Number(r.balance_cents)) }], total: money(Number(r.balance_cents)) });
    if (!eob) continue;
    const line = eob.lines[0];
    const ded = line.adjustments.find((a) => a.carc === '1' && a.group === 'PR');
    const adjudication = [{ category: { coding: [{ system: ADJ, code: 'eligible' }] }, amount: money(line.allowedCents) },
      ...(ded ? [{ category: { coding: [{ system: ADJ, code: 'deductible' }] }, amount: money(ded.amountCents) }] : [])];
    out.push({ resourceType: 'ExplanationOfBenefit', id: `eob-${ext}`, identifier: [{ system: 'urn:synthetic:claim', value: eob.claimReference }], status: 'active',
      type: { coding: [{ code: 'professional' }] }, use: 'claim', patient: { reference: `Patient/pat-${ext}` }, created: eob.processedDate, insurer: { display: 'Demo Payer A' },
      provider: { display: 'Synthetic Provider' }, outcome: 'complete', claim: { reference: `Claim/clm-${ext}` },
      insurance: [{ focal: true, coverage: { reference: `Coverage/cov-${ext}` } }],
      item: [{ sequence: 1, productOrService: { text: 'SYN-PROC-1' }, servicedDate: eob.serviceDate, adjudication }] });
    out.push({ resourceType: 'ClaimResponse', id: `clr-${ext}`, status: 'active', type: { coding: [{ code: 'professional' }] }, use: 'claim', patient: { reference: `Patient/pat-${ext}` },
      created: eob.processedDate, insurer: { display: 'Demo Payer A' }, request: { reference: `Claim/clm-${ext}` }, outcome: 'complete', item: [{ itemSequence: 1, adjudication }] });
  }
  return out;
}

export interface MockFhir { baseUrl: string; tokenUrl: string; close: () => Promise<void>; requests: string[] }

export async function startMockFhir(o: { clientId: string; kid: string; publicKey: KeyObject; dataset: string; tokenLifetime?: number }): Promise<MockFhir> {
  const resources = syntheticResources(o.dataset);
  const tokens = new Map<string, { scopes: string[]; expiresAt: number }>();
  const seenJti = new Set<string>();
  const requests: string[] = [];
  let base = '';
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: unknown, type = 'application/fhir+json') => { res.writeHead(status, { 'content-type': type }); res.end(JSON.stringify(body)); };
    const outcome = (status: number, msg: string) => send(status, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'processing', diagnostics: msg }] });
    try {
      if (url.pathname === '/.well-known/smart-configuration') return send(200, { token_endpoint: `${base}/token`, grant_types_supported: ['client_credentials'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES384'], scopes_supported: ALLOWED_SCOPES }, 'application/json');
      if (url.pathname === '/token' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        if (form.get('grant_type') !== 'client_credentials' || form.get('client_assertion_type') !== CLIENT_ASSERTION_TYPE) return send(400, { error: 'invalid_request' }, 'application/json');
        try { verifyAssertion(form.get('client_assertion') ?? '', o.publicKey, { clientId: o.clientId, tokenUrl: `${base}/token`, kid: o.kid, seenJti }); }
        catch (e) { return send(401, { error: 'invalid_client', error_description: (e as Error).message }, 'application/json'); }
        const requested = (form.get('scope') ?? '').split(' ').filter(Boolean);
        const granted = requested.filter((s) => ALLOWED_SCOPES.includes(s));
        if (!granted.length) return send(400, { error: 'invalid_scope' }, 'application/json');
        const token = randomBytes(24).toString('base64url');
        const life = o.tokenLifetime ?? 300;
        tokens.set(token, { scopes: granted, expiresAt: Date.now() + life * 1000 });
        return send(200, { access_token: token, token_type: 'bearer', expires_in: life, scope: granted.join(' ') }, 'application/json');
      }
      const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const t = tokens.get(auth);
      if (!t || t.expiresAt < Date.now()) return outcome(401, 'Missing or expired token');
      if (req.method !== 'GET') return outcome(405, 'Read-only server');
      const [, type, id] = url.pathname.split('/');
      if (!t.scopes.includes(`system/${type}.rs`)) return outcome(403, `Token lacks system/${type}.rs`);
      const ofType = resources.filter((r) => r.resourceType === type);
      if (id) {
        const r = ofType.find((x) => x.id === id);
        return r ? send(200, r) : outcome(404, `${type}/${id} not found`);
      }
      let hits = ofType;
      const ident = url.searchParams.get('identifier');
      if (ident) hits = hits.filter((r) => (r.identifier as { value: string }[] | undefined)?.some((i) => i.value === ident.split('|').pop()));
      const pat = url.searchParams.get('patient') ?? url.searchParams.get('beneficiary');
      if (pat) hits = hits.filter((r) => ((r.patient ?? r.beneficiary) as { reference?: string } | undefined)?.reference === pat);
      const reqRef = url.searchParams.get('request');
      if (reqRef) hits = hits.filter((r) => (r.request as { reference?: string } | undefined)?.reference === reqRef);
      return send(200, { resourceType: 'Bundle', type: 'searchset', total: hits.length, entry: hits.map((r) => ({ resource: r })) });
    } catch (e) {
      return outcome(500, (e as Error).message);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  server.unref(); // never keeps the API process alive on its own
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl: base, tokenUrl: `${base}/token`, requests, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}
