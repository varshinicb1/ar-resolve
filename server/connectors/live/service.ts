// Account-driven live reads and the live-connector overview (ADR 0100).
//
// Reads only: eligibility (270/271), claim status (276/277) and 835 ERA retrieval. Nothing here writes to
// a payer. Any payer write stays on the existing path: a proposed action, human approval bound to the
// payload hash and account revision, then the outbox (ADR 0001). Every call goes through invokeAsync, so
// the gate, circuit breaker, time budget and connector event apply, and every fact that results keeps its
// provenance (connector event id, raw sha256, transaction, segment or JSON path).
//
// Order of operations: the network call runs outside any database transaction; its answer is then
// ingested in one transaction through the same identity matching and evidence pipeline as EDI uploads.
import { type Db, tx } from '../../db/db.ts';
import { AppError, invalid, now } from '../../util.ts';
import { can, requirePerm, type Scope } from '../../services/auth.ts';
import { getAccountRow } from '../../services/workflow.ts';
import { assertMayIngest } from '../../services/governance.ts';
import { adapterFor, health, invokeAsync, latestAuthorization, newRequest, recentEvents, type ConnectorResponse } from '../framework.ts';
import { build270, build276 } from '../x12/generate.ts';
import { attachItems, buildPreview, matchClaim, optionsFor, traceFor, type PreviewItem } from '../ingest.ts';
import { PROVIDERS, SPECS, envStatus, isProvider, modeOf, baseUrl, type ProviderId } from './config.ts';
import { assertSandboxData, lastSmoke, providerGate, revocation, smokeHistory } from './gate.ts';
import { mapEraReport, type PolledEra } from './stedi.ts';
import { mapClaimStatusJson } from './optum.ts';

const PAYER_ID = /^[A-Za-z0-9]{2,20}$/;
let control = 300000000;

function mayRead(scope: Scope) {
  if (!can(scope, 'investigate') && !can(scope, 'integration_admin')) requirePerm(scope, 'investigate');
}

function payerFrom(body: Record<string, unknown>) {
  const id = String(body.payerId ?? '').trim();
  if (!PAYER_ID.test(id)) throw invalid('payerId is required: the clearinghouse payer identifier (letters and digits, 2-20)');
  const name = String(body.payerName ?? 'PAYER').replace(/[^A-Za-z0-9 .&-]/g, '').slice(0, 60) || 'PAYER';
  return { id, name };
}

function provider(body: Record<string, unknown>, allowed: ProviderId[]): ProviderId {
  const p = String(body.provider ?? '');
  if (!isProvider(p) || !allowed.includes(p)) throw invalid(`provider must be one of: ${allowed.join(', ')}`);
  return p;
}

// Our X12 envelope ids. Stedi documents no required ISA sender/receiver values (its examples use
// placeholders such as SENDER/RECEIVER), so these are this system's own identifiers.
const ENV_IDS = { sender: 'ARRESOLVE', receiver: 'STEDI' };

function summary(res: ConnectorResponse) {
  return { connectorEventId: res.connectorEventId, connectorId: res.connectorId, outcome: res.outcome, latencyMs: res.latencyMs, error: res.error, rawSha256: res.rawSha256, externalRefs: res.externalRefs };
}

/** Ingests a raw X12 answer through the EDI preview (ISA15 PHI gate, identity matching) for one account. */
function ingestX12(db: Db, scope: Scope, accountId: string, res: ConnectorResponse, filename: string) {
  if (!res.raw || res.outcome !== 'success') return { attached: [], note: 'Nothing to ingest' };
  return tx(db, () => {
    const p = buildPreview(db, scope, filename, res.raw!, optionsFor(db, scope, res.connectorId));
    if (!p.valid) return { attached: [], note: `Response rejected: ${p.error.message}` };
    const mine = p.items.filter((i) => i.match.accountId === accountId);
    const att = attachItems(db, scope, mine, `connector:${res.connectorId}:${res.connectorEventId}`, { connectorEventId: res.connectorEventId, rawSha256: res.rawSha256 }, p.mappingOptions, res.connectorId);
    return { attached: att.results, matches: p.items.map((i) => ({ label: i.match.accountId === accountId ? i.label : undefined, status: i.match.status, reason: i.match.reason })), note: `${p.items.length} item(s) in the answer` };
  });
}

/** PHI ingest gate for JSON answers: synthetic only when the call ran in sandbox mode. */
function mayIngestJson(db: Db, scope: Scope, p: ProviderId, why: string) {
  assertMayIngest(db, scope, { source: `connector:${SPECS[p].connectorId}`, synthetic: modeOf(p) === 'sandbox', why });
}

async function guarded<T>(fn: () => T | Promise<T>): Promise<T | { ingestError: { code: string; message: string } }> {
  try { return await fn(); } catch (err) {
    if (err instanceof AppError) return { ingestError: { code: err.code, message: err.message } };
    throw err;
  }
}

export async function liveClaimStatus(db: Db, scope: Scope, accountId: string, body: Record<string, unknown>) {
  mayRead(scope);
  const p = provider(body, ['stedi', 'optum']);
  const payer = payerFrom(body);
  const a = getAccountRow(db, scope, accountId);
  assertSandboxData(modeOf(p), { claimReference: a.claim_reference, patientToken: a.patient_token });
  const id = SPECS[p].connectorId;
  if (p === 'stedi') {
    const x12 = build276({ ...ENV_IDS, control: ++control, at: now(), usage: modeOf(p) === 'production' ? 'P' : 'T', payer, submitter: { name: 'AR RESOLVE', id: a.provider_id },
      provider: { name: 'PROVIDER', id: a.provider_id }, reference: `S276-${a.external_id}`.slice(0, 50),
      claims: [{ trace: `S-${a.external_id}`, memberId: a.patient_token, last: 'UNKNOWN', first: 'UNKNOWN', claimReference: a.claim_reference, chargeCents: a.balance_cents, serviceDate: a.service_date }] });
    const res = await invokeAsync(db, scope, id, newRequest(scope, 'read_status', { x12 }, { accountId, accountRevision: a.revision, timeBudgetMs: 70_000 }));
    return { ...summary(res), ingest: await guarded(() => ingestX12(db, scope, accountId, res, 'stedi-277.edi')) };
  }
  const d8 = a.service_date.replace(/-/g, '');
  const req = { controlNumber: String(++control % 1_000_000_000).padStart(9, '0'), tradingPartnerServiceId: payer.id,
    providers: [{ organizationName: 'PROVIDER', npi: a.provider_id, providerType: 'BillingProvider' }],
    subscriber: { memberId: a.patient_token }, encounter: { beginningDateOfService: d8, endDateOfService: d8, trackingNumber: `S-${a.external_id}`.slice(0, 50) } };
  const res = await invokeAsync(db, scope, id, newRequest(scope, 'read_status', { body: req }, { accountId, accountRevision: a.revision, timeBudgetMs: 70_000 }));
  if (res.outcome !== 'success') return { ...summary(res), ingest: { attached: [], note: 'Nothing to ingest' } };
  const ingest = await guarded(() => tx(db, () => {
    mayIngestJson(db, scope, p, 'Optum claim status JSON');
    const base = { connectorEventId: res.connectorEventId, rawSha256: res.rawSha256 };
    const subscriberId = ((res.normalized as { subscriber?: { memberId?: string } })?.subscriber?.memberId) ?? null;
    const items: PreviewItem[] = mapClaimStatusJson(res.normalized, base).map((c) => {
      const identity = { claimReference: c.claimReference, patientToken: subscriberId, serviceDate: c.serviceDate };
      return { transaction: 'claimstatus v2 JSON', setId: '277', index: c.index, kind: 'edi_277', label: `${c.claimReference ?? '(no patient account number)'} ${c.category ?? ''}:${c.code ?? ''}`,
        identity, match: matchClaim(db, scope, identity), extracted: c.extracted, record: { format: 'claimstatus_v2_json', category: c.category, code: c.code }, notes: ['Clearinghouse JSON rendering of a 277.'] };
    });
    const mine = items.filter((i) => i.match.accountId === accountId);
    return { attached: attachItems(db, scope, mine, `connector:${id}:${res.connectorEventId}`, base, optionsFor(db, scope, id), id).results, items: items.map((i) => ({ status: i.match.status, reason: i.match.reason })) };
  }));
  return { ...summary(res), ingest };
}

export async function liveEligibility(db: Db, scope: Scope, accountId: string, body: Record<string, unknown>) {
  mayRead(scope);
  const p = provider(body, ['stedi', 'optum', 'availity']);
  const payer = payerFrom(body);
  const a = getAccountRow(db, scope, accountId);
  assertSandboxData(modeOf(p), { claimReference: a.claim_reference, patientToken: a.patient_token });
  const id = SPECS[p].connectorId;
  if (p === 'stedi') {
    const x12 = build270({ ...ENV_IDS, control: ++control, at: now(), usage: modeOf(p) === 'production' ? 'P' : 'T', payer, provider: { name: 'PROVIDER', id: a.provider_id },
      reference: `S270-${a.external_id}`.slice(0, 50), originator: 'ARRESOLVE', query: { trace: traceFor(a.external_id), memberId: a.patient_token, last: 'UNKNOWN', first: 'UNKNOWN', serviceDate: a.service_date } });
    const res = await invokeAsync(db, scope, id, newRequest(scope, 'read_eligibility', { x12 }, { accountId, accountRevision: a.revision, timeBudgetMs: 70_000 }));
    return { ...summary(res), ingest: await guarded(() => ingestX12(db, scope, accountId, res, 'stedi-271.edi')) };
  }
  const d8 = a.service_date.replace(/-/g, '');
  const payload = p === 'optum'
    ? { body: { controlNumber: String(++control % 1_000_000_000).padStart(9, '0'), tradingPartnerServiceId: payer.id, provider: { organizationName: 'PROVIDER', npi: a.provider_id },
      subscriber: { memberId: a.patient_token }, encounter: { dateOfService: d8 } } }
    : { query: { payerId: payer.id, providerNpi: a.provider_id } };
  const res = await invokeAsync(db, scope, id, newRequest(scope, 'read_eligibility', payload, { accountId, accountRevision: a.revision, timeBudgetMs: 30_000 }));
  // Response mappings for Optum and Availity eligibility JSON were not verified: stored as the connector event only.
  return { ...summary(res), ingest: { attached: [], note: 'Eligibility JSON is kept as the connector event only; no facts are created (mapping not verified, ADR 0100).' } };
}

export async function pollStediRemittance(db: Db, scope: Scope, body: Record<string, unknown>) {
  requirePerm(scope, 'integration_admin');
  const payload: Record<string, unknown> = {};
  if (typeof body.pageToken === 'string') payload.pageToken = body.pageToken;
  else if (typeof body.startDateTime === 'string') payload.startDateTime = body.startDateTime;
  else payload.startDateTime = new Date(now().getTime() - 24 * 3600_000).toISOString();
  const res = await invokeAsync(db, scope, 'stedi', newRequest(scope, 'read_remittance', payload, { timeBudgetMs: 60_000 }));
  const n = res.normalized as { eras?: PolledEra[]; nextPageToken?: string | null; seen?: number } | null;
  const out = { ...summary(res), nextPageToken: n?.nextPageToken ?? null, transactionsSeen: n?.seen ?? 0, eras: (n?.eras ?? []).length, attached: [] as unknown[], unmatchedClaims: 0 };
  if ((res.outcome !== 'success' && res.outcome !== 'partially_completed') || !n?.eras?.length) return out;
  const ingest = await guarded(() => tx(db, () => {
    const attached: unknown[] = [];
    let unmatched = 0;
    for (const era of n.eras!) {
      const meta = (era.report as { meta?: { applicationMode?: string } })?.meta;
      // Synthetic only when Stedi itself says the ERA is a test-mode transaction and we are in sandbox.
      assertMayIngest(db, scope, { source: 'connector:stedi', synthetic: modeOf('stedi') === 'sandbox' && era.mode === 'test' && meta?.applicationMode !== 'production', why: `ERA ${era.transactionId} mode ${era.mode ?? '?'}` });
      const base = { connectorEventId: res.connectorEventId, rawSha256: res.rawSha256, transactionId: era.transactionId };
      const items: PreviewItem[] = mapEraReport(era.report, base).map((c, i) => {
        const identity = { claimReference: c.claimReference, patientToken: c.memberId, serviceDate: c.serviceDate };
        const reversal = (c.record as { reversal?: boolean }).reversal === true;
        const match = matchClaim(db, scope, identity);
        return { transaction: `835 report ${era.transactionId}`, setId: '835', index: i, kind: reversal ? null : 'edi_835', label: `${c.claimReference ?? '?'} (${era.transactionId})`,
          identity, match: reversal ? { ...match, status: 'not_applicable' } : match, extracted: c.extracted, record: { format: 'stedi_835_report_json', path: c.path, ...c.record }, notes: [] };
      });
      // Scope isolation: one Stedi account may carry ERAs for other clients. Only this scope's matched
      // claims are attached or reported; the rest are counted, never echoed.
      const mine = items.filter((i) => i.match.status === 'matched');
      unmatched += items.length - mine.length;
      attached.push(...attachItems(db, scope, mine, `connector:stedi:${res.connectorEventId}`, base, optionsFor(db, scope, 'stedi'), 'stedi').results);
    }
    return { attached, unmatched };
  }));
  if ('ingestError' in ingest) return { ...out, ingestError: ingest.ingestError };
  return { ...out, attached: ingest.attached, unmatchedClaims: ingest.unmatched };
}

/** Sandbox-only Twilio test call through the framework (no call is placed: test credentials). */
export async function twilioTestCall(db: Db, scope: Scope, body: Record<string, unknown>) {
  requirePerm(scope, 'integration_admin');
  const res = await invokeAsync(db, scope, 'twilio_voice', newRequest(scope, 'call', { to: String(body.to ?? '+14108675310') }, { timeBudgetMs: 15_000 }));
  return { ...summary(res), normalized: res.normalized };
}

/** Everything the Integrations page shows per live connector. Env var NAMES only, never values. */
export function liveOverview(db: Db, scope: Scope) {
  requirePerm(scope, 'integration_admin');
  return PROVIDERS.map((p) => {
    const spec = SPECS[p];
    const gate = providerGate(db, scope, p);
    const auth = latestAuthorization(db, scope, spec.connectorId);
    const rev = auth ? revocation(db, scope, spec.connectorId, auth.authorization_id) : null;
    const d = adapterFor(spec.connectorId).descriptor;
    const bases = Object.fromEntries(Object.keys(spec.baseUrls.sandbox).map((k) => [k, baseUrl(p, k).url]));
    return {
      provider: p, connectorId: spec.connectorId, label: spec.label, mode: gate.mode, modeVar: spec.modeVar, envVars: envStatus(p), baseUrls: bases,
      authorization: auth ? { authorizationId: auth.authorization_id, ref: auth.authorization_ref, coveredServiceVerified: !!auth.covered_service_verified, baaRef: auth.baa_ref,
        recordedAt: auth.recorded_at, revoked: rev ? { at: rev.revoked_at, by: rev.revoked_by } : null } : null,
      gate: { open: gate.open, reasons: gate.reasons }, lastSmoke: lastSmoke(db, p), smokeHistory: smokeHistory(db, p, 5), health: d.capabilities.length ? health(db, scope, spec.connectorId) : null,
      recentEvents: d.capabilities.length ? (recentEvents(db, scope, spec.connectorId, 5) as unknown as { outcome: string; action_class: string; received_time: string; error: string | null }[]).map((e) => ({ outcome: e.outcome, action: e.action_class, at: e.received_time, error: e.error })) : [],
      capabilities: d.capabilities, notes: d.notes, sources: d.sources,
    };
  });
}
