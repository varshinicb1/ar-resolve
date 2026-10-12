// SIMULATED FHIR connector: a SMART backend-services client reading from the local mock FHIR
// server, plus the EOB/Coverage → observation mapping and the account pull.
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { type Db, tx } from '../../db/db.ts';
import { can, requirePerm, type Scope } from '../../services/auth.ts';
import { getAccountRow } from '../../services/workflow.ts';
import { type AdapterResult, type ConnectorAdapter, invokeAsync, newRequest, registerAdapter } from '../framework.ts';
import { BackendTokenSource, discoverTokenUrl } from './smart.ts';
import { FhirReadClient, type FhirResource } from './client.ts';
import { startMockFhir, type MockFhir } from './mock-server.ts';
import type { Extracted } from '../observations.ts';
import { attachItems, matchClaim, optionsFor, type PreviewItem } from '../ingest.ts';

const ADJ = 'http://terminology.hl7.org/CodeSystem/adjudication';

function cents(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const c = Math.round(v * 100);
  return Math.abs(c - v * 100) < 1e-6 ? c : null; // refuse sub-cent values rather than round them
}

export interface EobSummary { id: string; claimReference: string | null; patientRef: string | null; serviceDate: string | null; allowedCents: number | null; deductibleCents: number | null; outcome: string | null; created: string | null }

export function summarizeEob(eob: FhirResource): EobSummary {
  const item = (eob.item as { servicedDate?: string; adjudication?: { category?: { coding?: { system?: string; code?: string }[] }; amount?: { value?: number } }[] }[] | undefined)?.[0];
  const adj = (code: string) => item?.adjudication?.find((a) => a.category?.coding?.some((c) => c.code === code && (!c.system || c.system === ADJ)))?.amount?.value;
  return { id: eob.id, claimReference: (eob.identifier as { value?: string }[] | undefined)?.[0]?.value ?? null, patientRef: (eob.patient as { reference?: string } | undefined)?.reference ?? null,
    serviceDate: item?.servicedDate ?? null, allowedCents: cents(adj('eligible')), deductibleCents: cents(adj('deductible')), outcome: (eob.outcome as string) ?? null, created: (eob.created as string) ?? null };
}

export function observeEob(s: EobSummary, patientToken: string | null, base: Record<string, unknown>): Extracted[] {
  const out: Extracted[] = [];
  const at = (path: string) => ({ ...base, resource: `ExplanationOfBenefit/${s.id}`, path });
  const cent = (k: string) => (['allowedCents', 'appliedCents'].includes(k) ? 'USD_cents' : null);
  const push = (factKey: string, value: unknown, path: string) => { if (value !== null && value !== undefined) out.push({ factKey, value, unit: cent(factKey), locator: at(path) }); };
  push('claimReference', s.claimReference, 'identifier[0].value');
  push('eobPatientToken', patientToken, 'patient → Patient.identifier[0].value');
  push('eobServiceDate', s.serviceDate, 'item[0].servicedDate');
  push('allowedCents', s.allowedCents, 'item[0].adjudication[eligible].amount');
  push('appliedCents', s.deductibleCents, 'item[0].adjudication[deductible].amount');
  return out;
}

// ---------------------------------------------------------------- simulated connector

let keys: { privateKey: KeyObject; publicKey: KeyObject } | null = null;
const servers = new Map<string, Promise<MockFhir>>();
const KID = 'synthetic-backend-key-1';
const CLIENT_ID = 'ar-resolve-synthetic-backend';
export const FHIR_SCOPES = ['system/ExplanationOfBenefit.rs', 'system/Coverage.rs', 'system/Patient.rs', 'system/Claim.rs', 'system/ClaimResponse.rs'];

function keyPair() {
  keys ??= generateKeyPairSync('ec', { namedCurve: 'P-384' });
  return keys;
}

// One mock server per tenant/client dataset: a client's FHIR endpoint only ever holds that client's data.
function mockFor(scope: { tenantId: string; clientId: string }): Promise<MockFhir> {
  const key = `${scope.tenantId}/${scope.clientId}`;
  if (!servers.has(key)) servers.set(key, startMockFhir({ clientId: CLIENT_ID, kid: KID, publicKey: keyPair().publicKey, dataset: scope.clientId }));
  return servers.get(key)!;
}

export async function closeMockFhirServers() {
  for (const p of servers.values()) await (await p).close();
  servers.clear();
}

export const simFhir: ConnectorAdapter = {
  descriptor: {
    id: 'sim_fhir', displayName: 'Simulated FHIR R4 payer/EHR endpoint (SMART backend services)', vendor: 'Local mock server (synthetic)', kind: 'fhir', defaultMode: 'simulated', liveCapable: false,
    capabilities: ['read_clinical_financial'], transactions: ['ExplanationOfBenefit', 'Coverage', 'Claim', 'ClaimResponse', 'Patient (token only)'],
    configFields: [{ key: 'latencyMs', label: 'Not used (real loopback latency is measured)' }], phi: false, requiresBaa: false,
    notes: ['Runs an in-process mock FHIR server on 127.0.0.1 per client with synthetic resources.', 'Patient resources are reduced to identifiers at the client boundary.'],
    sources: [{ title: 'FHIR R4 ExplanationOfBenefit', url: 'https://hl7.org/fhir/R4/explanationofbenefit.html', retrievedAt: '2026-10-12' },
      { title: 'FHIR R4 Coverage', url: 'https://hl7.org/fhir/R4/coverage.html', retrievedAt: '2026-10-12' },
      { title: 'FHIR R4 ClaimResponse', url: 'https://hl7.org/fhir/R4/claimresponse.html', retrievedAt: '2026-10-12' },
      { title: 'FHIR R4 adjudication code system', url: 'https://hl7.org/fhir/R4/codesystem-adjudication.html', retrievedAt: '2026-10-12' },
      { title: 'SMART App Launch v2.2.0 Backend Services', url: 'https://hl7.org/fhir/smart-app-launch/backend-services.html', retrievedAt: '2026-10-12' }],
  },
  execute() { throw new Error('sim_fhir performs network I/O; use the async path'); },
  async executeAsync(ctx, req): Promise<AdapterResult> {
    const started = Date.now();
    const mock = await mockFor(ctx.scope);
    // Token endpoint from SMART discovery (ADR 0070); loopback is allowed for the local mock only.
    const tokenUrl = await discoverTokenUrl(mock.baseUrl, { allowLoopback: true });
    const client = new FhirReadClient(mock.baseUrl, new BackendTokenSource({ clientId: CLIENT_ID, tokenUrl, kid: KID, privateKey: keyPair().privateKey, scopes: FHIR_SCOPES }), { allowLoopback: true });
    const claimReference = String(req.payload.claimReference ?? '');
    const eobs = await client.search('ExplanationOfBenefit', { identifier: claimReference });
    if (!eobs.length) return { outcome: 'not_found', latencyMs: Date.now() - started, normalized: { eobs: [] }, externalRefs: { claimReference } };
    const eob = eobs[0];
    const summary = summarizeEob(eob);
    const patient = summary.patientRef ? await client.read('Patient', summary.patientRef.split('/')[1]) : null;
    const coverages = summary.patientRef ? await client.search('Coverage', { beneficiary: summary.patientRef }) : [];
    const patientToken = ((patient?.identifier as { value?: string }[] | undefined)?.[0]?.value) ?? null;
    const normalized = { eob: summary, patient, patientToken, coverages: coverages.map((c) => ({ id: c.id, status: c.status, period: c.period, order: c.order ?? null })), eobCount: eobs.length };
    return { outcome: eobs.length > 1 ? 'partially_completed' : 'success', latencyMs: Date.now() - started, normalized, raw: JSON.stringify({ eob, patient, coverages }),
      externalRefs: { eob: `ExplanationOfBenefit/${eob.id}` }, sourceTime: summary.created, evidenceLocator: { resource: `ExplanationOfBenefit/${eob.id}` } };
  },
};
registerAdapter(simFhir);

export async function pullFhir(db: Db, scope: Scope, accountId: string) {
  if (!can(scope, 'investigate') && !can(scope, 'integration_admin')) requirePerm(scope, 'investigate');
  const a = getAccountRow(db, scope, accountId);
  const req = newRequest(scope, 'read_clinical_financial', { claimReference: a.claim_reference }, { accountId, accountRevision: a.revision, timeBudgetMs: 8000 });
  const res = await invokeAsync(db, scope, 'sim_fhir', req);
  const out = { connectorEventId: res.connectorEventId, outcome: res.outcome, latencyMs: res.latencyMs, error: res.error, normalized: res.normalized, attached: [] as unknown[] };
  if (res.outcome !== 'success') return out;
  const n = res.normalized as { eob: EobSummary; patientToken: string | null; coverages: { id: string; status: string; period: unknown }[] };
  const base = { connectorEventId: res.connectorEventId };
  return tx(db, () => {
    const identity = { claimReference: n.eob.claimReference, patientToken: n.patientToken, serviceDate: n.eob.serviceDate };
    const match = matchClaim(db, scope, identity);
    const items: PreviewItem[] = [{ transaction: 'FHIR', setId: 'ExplanationOfBenefit', index: 0, kind: 'fhir_eob', label: `ExplanationOfBenefit/${n.eob.id}`, identity, match,
      extracted: observeEob(n.eob, n.patientToken, base), record: { eob: n.eob, patientToken: n.patientToken }, notes: [] }];
    for (const c of n.coverages) items.push({ transaction: 'FHIR', setId: 'Coverage', index: items.length, kind: 'fhir_coverage', label: `Coverage/${c.id}`, identity, match,
      extracted: [{ factKey: 'coverageStatus', value: c.status, unit: null, locator: { ...base, resource: `Coverage/${c.id}`, path: 'status' } }], record: { coverage: c }, notes: ['Coverage.order does not imply primary or secondary (FHIR R4).'] });
    out.attached = attachItems(db, scope, items, `connector:sim_fhir:${res.connectorEventId}`, base, optionsFor(db, scope), 'sim_fhir').results;
    return { ...out, match };
  });
}
