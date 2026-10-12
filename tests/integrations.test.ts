import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { start, importCohort, accountByExt, type Client, type Harness } from './helpers.ts';
import { buildSimWebhook } from '../server/connectors/webhooks.ts';
import { startMockFhir } from '../server/connectors/fhir/mock-server.ts';
import { BackendTokenSource, createAssertion, tokenRequestBody } from '../server/connectors/fhir/smart.ts';
import { FhirReadClient } from '../server/connectors/fhir/client.ts';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/x12/${n}`, import.meta.url), 'utf8');

async function ingest(c: Client, name: string, content = fixture(name)) {
  const p = await c.post('/api/integrations/edi/preview', { filename: name, content });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const r = await c.post('/api/integrations/edi/ingest', { filename: name, content, expectedSha256: p.body.rawSha256 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { preview: p.body, result: r.body };
}

const fact = (v: any, k: string) => v.facts.find((f: any) => f.key === k);

async function setup(): Promise<{ h: Harness; ana: Client; sam: Client }> {
  const h = await start();
  const ana = await h.as('u_ana');
  await importCohort(ana);
  return { h, ana, sam: await h.as('u_sam') };
}

test('835 ingestion produces verified facts for SYN accounts; identity mismatch blocks and is reported', async () => {
  const { h, ana, sam } = await setup();
  try {
    const id = await accountByExt(ana, 'SYN-1042');
    // Preview changes nothing.
    const p = await sam.post('/api/integrations/edi/preview', { filename: 'era.edi', content: fixture('835-cl_ortho-era.edi') });
    assert.equal(p.body.valid, true);
    assert.deepEqual(p.body.transactionSets, ['835']);
    assert.equal(p.body.summary.matched, 8);
    assert.equal(p.body.summary.identity_mismatch, 1);
    assert.equal(fact((await ana.get(`/api/accounts/${id}`)).body, 'allowedCents').status, 'missing');
    // Ingest must be bound to the previewed hash.
    assert.equal((await sam.post('/api/integrations/edi/ingest', { filename: 'era.edi', content: fixture('835-cl_ortho-era.edi'), expectedSha256: 'x' })).status, 409);

    const { result } = await ingest(sam, '835-cl_ortho-era.edi');
    assert.equal(result.state, 'partially_ingested');
    const v = (await ana.get(`/api/accounts/${id}`)).body;
    assert.equal(fact(v, 'identityVerified').value, true);
    assert.equal(fact(v, 'identityVerified').status, 'verified');
    for (const [k, val] of [['claimReference', 'SYN-C1042'], ['allowedCents', 42500], ['appliedCents', 42500], ['adjustmentGroup', 'PR']] as const) {
      assert.equal(fact(v, k).status, 'verified', k);
      assert.equal(fact(v, k).value, val, k);
    }
    const ev = v.evidence.find((e: any) => e.kind === 'edi_835');
    assert.ok(ev && /^[0-9a-f]{64}$/.test(ev.sha256));
    assert.equal(ev.content.mapping.id, 'x12-835-claim');
    assert.equal(ev.content.source.rawSha256, result.preview.rawSha256);
    const applied = fact(v, 'appliedCents');
    assert.equal(applied.locator.segment, 'CAS');
    assert.equal(applied.locator.reason, '1');

    // SYN-1044: the 835 names another patient token. Nothing is attached; the mismatch is reported and audited.
    const bad = await accountByExt(ana, 'SYN-1044');
    const vb = (await ana.get(`/api/accounts/${bad}`)).body;
    assert.equal(vb.evidence.filter((e: any) => e.kind === 'edi_835').length, 0);
    assert.ok(vb.timeline.some((t: any) => t.eventType === 'integration_identity_mismatch'));
    const row = result.report.results.find((r: any) => r.externalId === 'SYN-1044');
    assert.equal(row.status, 'identity_mismatch');

    // Re-ingesting the same bytes is idempotent.
    const again = await ingest(sam, '835-cl_ortho-era.edi');
    assert.equal(again.result.duplicate, true);
    assert.equal(again.preview.alreadyIngested.fileId, result.fileId);
    assert.equal((await ana.get(`/api/accounts/${id}`)).body.evidence.filter((e: any) => e.kind === 'edi_835').length, 1);

    // Consistent with the cohort EOB: investigating afterwards keeps the facts verified and the proposal unchanged.
    const r = await ana.post(`/api/accounts/${id}/investigate`);
    assert.equal(r.body.outcome, 'clarify_allocation');
    assert.equal(fact((await ana.get(`/api/accounts/${id}`)).body, 'appliedCents').status, 'verified');

    const files = await sam.get('/api/integrations/edi/files');
    assert.equal(files.body.length, 1);
  } finally { await h.close(); }
});

test('835 reversal + corrected claim: reversal ignored, correction conflicts with the original EOB and supersedes the proposal', async () => {
  const { h, ana, sam } = await setup();
  try {
    const id = await accountByExt(ana, 'SYN-1042');
    const inv = await ana.post(`/api/accounts/${id}/investigate`);
    assert.equal(inv.body.outcome, 'clarify_allocation');
    const { result } = await ingest(sam, '835-cl_ortho-reversal-correction.edi');
    assert.equal(result.report.summary.not_applicable, 1, 'the reversal itself is reported, not ingested');
    const v = (await ana.get(`/api/accounts/${id}`)).body;
    // The corrected adjudication applied no deductible (balanced line, no CARC 1) while the EOB says $425: conflicting, never guessed.
    assert.equal(fact(v, 'appliedCents').status, 'conflicting');
    assert.deepEqual(fact(v, 'appliedCents').candidates.map((c: any) => c.value).sort(), [0, 42500]);
    assert.equal(fact(v, 'allowedCents').status, 'verified');
    assert.equal(v.actions[0].state, 'superseded');
    assert.notEqual(v.account.state, 'awaiting_review');
    const ev = v.evidence.find((e: any) => e.kind === 'edi_835');
    assert.equal(ev.content.record.claim.payerControlNumber, 'DP1042B1');
    assert.ok(ev.content.notes.length === 0 || Array.isArray(ev.content.notes));
    const plb = result.report.fileLevel[0].providerAdjustments;
    assert.equal(plb[0].reason, 'WO');
  } finally { await h.close(); }
});

test('271 ingestion: limit, remaining and other payer; met-before derived only when the client opts in', async () => {
  const { h, ana, sam } = await setup();
  try {
    const id45 = await accountByExt(ana, 'SYN-1045');
    await ingest(sam, '271-cl_ortho-eligibility.edi');
    let v = (await ana.get(`/api/accounts/${id45}`)).body;
    assert.equal(fact(v, 'limitCents').value, 200000);
    assert.equal(fact(v, 'limitCents').status, 'verified');
    assert.equal(fact(v, 'secondaryAtDos').value, 'active');
    assert.equal(fact(v, 'metBeforeCents').status, 'missing', 'not derived by default');
    const hist = (await ana.get(`/api/accounts/${id45}/audit-export`));
    assert.equal(hist.status, 403, 'specialist cannot export');

    // Opt in and ingest the same subject again through a second, different file (new bytes).
    assert.equal((await sam.post('/api/integrations/connectors/edi_upload/settings', { settings: { mappingOptions: { deriveMetBeforeFromRemaining: true, otherPayerMeansSecondary: true } } })).status, 200);
    assert.equal((await sam.post('/api/integrations/connectors/edi_upload/settings', { settings: { surprise: 1 } })).status, 400);
    await ingest(sam, '271-again.edi', fixture('271-cl_ortho-eligibility.edi').replace('SYN271-1045', 'SYN271-1045B'));
    v = (await ana.get(`/api/accounts/${id45}`)).body;
    assert.equal(fact(v, 'metBeforeCents').value, 120000);
    assert.equal(fact(v, 'metBeforeCents').locator.derivation, 'limit - remaining');

    // SYN-1048 (no other payer reported): absence never becomes "none".
    const id48 = await accountByExt(ana, 'SYN-1048');
    assert.equal(fact((await ana.get(`/api/accounts/${id48}`)).body, 'secondaryAtDos').status, 'missing');
  } finally { await h.close(); }
});

test('277 and 277CA ingestion: status category becomes a fact; acknowledgment does not', async () => {
  const { h, ana, sam } = await setup();
  try {
    await ingest(sam, '277-cl_ortho-status.edi');
    await ingest(sam, '277ca-cl_ortho-ack.edi');
    await ingest(sam, '999-ack.edi');
    const h42 = (await sam.get(`/api/accounts/${await accountByExt(ana, 'SYN-1042')}`)).body;
    assert.ok(h42.evidence.some((e: any) => e.kind === 'edi_277'));
    const id41 = await accountByExt(ana, 'SYN-1041');
    const v41 = (await ana.get(`/api/accounts/${id41}`)).body;
    const ack = v41.evidence.find((e: any) => e.kind === 'edi_277');
    assert.equal(ack.content.record.status.variant, '277CA');
    const files = (await sam.get('/api/integrations/edi/files')).body;
    const f999 = files.find((f: any) => f.transactionSets.includes('999'));
    const detail = (await sam.get(`/api/integrations/edi/files/${f999.fileId}`)).body;
    assert.equal(detail.report.fileLevel[0].acknowledgment.groupDisposition, 'P');
  } finally { await h.close(); }
});

test('simulated clearinghouse: 276→277 research step, faults, circuit breaker, and the investigate setting', async () => {
  const { h, ana, sam } = await setup();
  try {
    const id = await accountByExt(ana, 'SYN-1042');
    const r = await ana.post(`/api/integrations/accounts/${id}/status-inquiry`);
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, 'success');
    assert.deepEqual(r.body.statusCategories, ['F4']);
    assert.equal(r.body.adequate, true);
    assert.ok(r.body.request.startsWith('ISA*') && r.body.request.includes('ST*276*'));
    assert.ok(r.body.response.includes('ST*277*'));
    assert.equal(fact((await ana.get(`/api/accounts/${id}`)).body, 'claimReference').status, 'verified');

    // Identity mismatch at the payer (SYN-1044 is filed under another member id): A4/33, nothing ingested.
    const bad = await ana.post(`/api/integrations/accounts/${await accountByExt(ana, 'SYN-1044')}/status-inquiry`);
    assert.equal(bad.body.outcome, 'not_found');
    assert.equal(bad.body.adequate, false);

    // Eligibility 270→271 for SYN-1043.
    const el = await ana.post(`/api/integrations/accounts/${await accountByExt(ana, 'SYN-1043')}/eligibility-inquiry`);
    assert.equal(el.body.outcome, 'success');
    assert.equal(el.body.attached[0].status, 'matched');

    // Faults: malformed response is an error, never data; timeouts open the circuit after three failures.
    assert.equal((await ana.post('/api/integrations/sim-clearinghouse/faults', { fault: 'timeout' })).status, 403, 'specialists cannot arm faults');
    await sam.post('/api/integrations/sim-clearinghouse/faults', { fault: 'malformed', remaining: 1 });
    const m = await ana.post(`/api/integrations/accounts/${id}/status-inquiry`);
    assert.equal(m.body.outcome, 'error');
    assert.match(m.body.error, /Malformed response rejected/);
    await sam.post('/api/integrations/sim-clearinghouse/faults', { fault: 'timeout', remaining: 2 });
    assert.equal((await ana.post(`/api/integrations/accounts/${id}/status-inquiry`)).body.outcome, 'timeout');
    assert.equal((await ana.post(`/api/integrations/accounts/${id}/status-inquiry`)).body.outcome, 'timeout');
    const refused = await ana.post(`/api/integrations/accounts/${id}/status-inquiry`);
    assert.equal(refused.body.outcome, 'refused');
    assert.match(refused.body.error, /Circuit open/);
    const ov = (await sam.get('/api/integrations')).body;
    assert.equal(ov.connectors.find((c: any) => c.id === 'sim_clearinghouse').health.status, 'circuit_open');
    // Faults are per client: cl_derm is unaffected.
    const samDerm = await h.as('u_sam', 'tn_demo', 'cl_derm');
    assert.ok((await samDerm.get('/api/integrations')).body.faults.every((f: any) => f.remaining === 0));
    await sam.post('/api/integrations/connectors/sim_clearinghouse/circuit/reset');
    assert.equal((await ana.post(`/api/integrations/accounts/${id}/status-inquiry`)).body.outcome, 'success');

    // Investigate does not call the clearinghouse unless the client turns the setting on.
    const id43 = await accountByExt(ana, 'SYN-1049');
    const before = (await sam.get('/api/integrations')).body.events.length;
    await ana.post(`/api/accounts/${id43}/investigate`);
    assert.equal((await sam.get('/api/integrations')).body.events.length, before);
    await sam.post('/api/integrations/connectors/sim_clearinghouse/settings', { settings: { structuredStatusFirst: true } });
    const id47 = await accountByExt(ana, 'SYN-1047');
    const inv = await ana.post(`/api/accounts/${id47}/investigate`);
    assert.equal(inv.status, 200);
    const v47 = (await ana.get(`/api/accounts/${id47}`)).body;
    assert.ok(v47.evidence.some((e: any) => e.kind === 'edi_277'), 'structured status collected during investigation');
    assert.equal(v47.latestRun.result.outcome, 'specialist_review', 'rule outcome unchanged by the extra evidence');
  } finally { await h.close(); }
});

test('FHIR R4 mock round trip with SMART backend auth; Patient reduced to a token', async () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const mock = await startMockFhir({ clientId: 'test-client', kid: 'k1', publicKey: keys.publicKey, dataset: 'cl_ortho' });
  try {
    const cfg = { clientId: 'test-client', tokenUrl: mock.tokenUrl, kid: 'k1', privateKey: keys.privateKey, scopes: ['system/ExplanationOfBenefit.rs', 'system/Patient.rs', 'system/Coverage.rs'] };
    const disco = await (await fetch(`${mock.baseUrl}/.well-known/smart-configuration`)).json() as { token_endpoint: string };
    assert.equal(disco.token_endpoint, mock.tokenUrl);
    // No token, no data.
    assert.equal((await fetch(`${mock.baseUrl}/ExplanationOfBenefit?identifier=SYN-C1042`)).status, 401);
    // A replayed assertion (same jti) is refused.
    const assertion = createAssertion(cfg);
    const post = (body: string) => fetch(mock.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    assert.equal((await post(tokenRequestBody(cfg, assertion))).status, 200);
    assert.equal((await post(tokenRequestBody(cfg, assertion))).status, 401);
    // Wrong key is refused.
    const other = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    assert.equal((await post(tokenRequestBody({ ...cfg, privateKey: other.privateKey }, createAssertion({ ...cfg, privateKey: other.privateKey })))).status, 401);

    const client = new FhirReadClient(mock.baseUrl, new BackendTokenSource(cfg));
    const eobs = await client.search('ExplanationOfBenefit', { identifier: 'SYN-C1042' });
    assert.equal(eobs.length, 1);
    assert.equal((eobs[0].item as any)[0].servicedDate, '2026-06-02');
    const pat = await client.read('Patient', 'pat-SYN-1042');
    assert.deepEqual(Object.keys(pat).sort(), ['id', 'identifier', 'resourceType']);
    assert.equal((pat.identifier as any)[0].value, 'PT-3M8D');
    const cov = await client.search('Coverage', { beneficiary: 'Patient/pat-SYN-1042' });
    assert.equal(cov[0].status, 'active');
    // Scope not granted: Claim was not requested.
    await assert.rejects(client.read('Claim', 'clm-SYN-1042'), /403/);
    await assert.rejects(client.read('Observation' as never, 'x'), /not readable/);
  } finally { await mock.close(); }

  // Through the API: the FHIR EOB alone verifies identity and amounts for a fresh account.
  const { h, ana, sam } = await setup();
  try {
    const id = await accountByExt(ana, 'SYN-1043');
    const r = await ana.post(`/api/integrations/accounts/${id}/fhir-pull`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome, 'success');
    assert.equal(r.body.match.status, 'matched');
    const v = (await ana.get(`/api/accounts/${id}`)).body;
    assert.equal(fact(v, 'identityVerified').value, true);
    assert.equal(fact(v, 'allowedCents').value, 18000);
    assert.equal(fact(v, 'appliedCents').value, 18000);
    assert.equal(fact(v, 'adjustmentGroup').status, 'missing', 'FHIR has no CAS group; not invented');
    const eob = v.evidence.find((e: any) => e.kind === 'fhir_eob');
    assert.ok(!JSON.stringify(eob.content).includes('birthDate'), 'no demographics stored');
    // SYN-1044: the FHIR EOB names another patient: blocked, nothing attached.
    const bad = await ana.post(`/api/integrations/accounts/${await accountByExt(ana, 'SYN-1044')}/fhir-pull`);
    assert.equal(bad.body.match.status, 'identity_mismatch');
    assert.equal(bad.body.attached[0].evidenceId, null);
    // SYN-1048 has no EOB.
    assert.equal((await ana.post(`/api/integrations/accounts/${await accountByExt(ana, 'SYN-1048')}/fhir-pull`)).body.outcome, 'not_found');
    void sam;
  } finally { await h.close(); }
});

test('live adapters refuse; the enable gate needs authorization, a complete onboarding record and a non-synthetic environment', async () => {
  const { h, sam } = await setup();
  try {
    for (const id of ['availity', 'optum_change_healthcare', 'epic', 'athenahealth', 'sftp_edi', 'twilio_voice']) {
      const r = await sam.post(`/api/integrations/connectors/${id}/probe`);
      assert.equal(r.status, 200);
      assert.equal(r.body.outcome, 'refused', id);
      assert.match(r.body.error, /LiveExecutionDisabled/, id);
    }
    const gate1 = await sam.post('/api/integrations/connectors/availity/mode', { mode: 'live' });
    assert.equal(gate1.status, 409);
    assert.ok(gate1.body.error.details.reasons.some((r: string) => /authorization/.test(r)));
    assert.ok(gate1.body.error.details.reasons.some((r: string) => /synthetic/.test(r)));
    assert.equal((await sam.post('/api/integrations/connectors/availity/settings', { enabled: true })).status, 409);

    // A PHI vendor needs a BAA reference to mark the service covered.
    assert.equal((await sam.post('/api/integrations/connectors/twilio_voice/authorization', { authorizationRef: 'SYN-AUTH-1', coveredServiceVerified: true })).status, 400);
    assert.equal((await sam.post('/api/integrations/connectors/availity/authorization', { authorizationRef: 'SYN-AUTH-1', coveredServiceVerified: true, baaRef: 'SYN-BAA-1' })).status, 200);
    const fields = (await sam.get('/api/integrations')).body.onboardingFields.map((f: any) => f.key);
    const partial = await sam.post('/api/integrations/connectors/availity/onboarding', { record: { region: 'us-synthetic', operationalOwner: 'Sam' } });
    assert.equal(partial.body.version, 1);
    assert.ok(partial.body.completeness.ratio < 1);
    assert.equal((await sam.post('/api/integrations/connectors/availity/onboarding', { record: { notAField: 'x' } })).status, 400);
    const full = await sam.post('/api/integrations/connectors/availity/onboarding', { record: Object.fromEntries(fields.map((k: string) => [k, `synthetic ${k}`])) });
    assert.equal(full.body.version, 2);
    assert.equal(full.body.completeness.ratio, 1);
    const gate2 = await sam.post('/api/integrations/connectors/availity/mode', { mode: 'live' });
    assert.equal(gate2.status, 409);
    // ADR 0070: the PHI gate (vendor/BAA register, key, hosting, AR_PHI_MODE) adds its own reasons.
    const [envReason, ...phiReasons] = gate2.body.error.details.reasons;
    assert.equal(envReason, 'This environment is synthetic. Live integrations cannot be enabled here (docs/08).');
    assert.ok(phiReasons.length > 0 && phiReasons.every((r: string) => r.startsWith('PHI gate: ')), JSON.stringify(phiReasons));
    assert.ok(phiReasons.some((r: string) => /availity/.test(r)), 'availity needs a BAA in the register');
    const detail = (await sam.get('/api/integrations/connectors/availity')).body;
    assert.equal(detail.mode, 'disabled_live');
    assert.equal(detail.health.status, 'disabled');
    assert.ok(detail.checklist.length > 5);
    assert.ok(detail.sources[0].url.startsWith('https://'));
    assert.ok(detail.events.every((e: any) => e.outcome === 'refused'));
  } finally { await h.close(); }
});

test('signed connector webhooks: replay, forgery, staleness, server-side tenant resolution, out-of-order tolerance', async () => {
  const { h, ana, sam } = await setup();
  try {
    const post = (raw: string, headers: Record<string, string>) => fetch(`${h.base}/api/webhooks/connectors/sim_clearinghouse`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
    const now = new Date().toISOString();
    // The payload claims another tenant; the provider account decides.
    const w1 = buildSimWebhook(h.db, 'SIMCH-ORTHO', { eventId: 'evt-000001', occurredAt: '2026-09-10T00:00:00Z', claimReference: 'SYN-C1042', statusCategory: 'P1', tenantId: 'tn_other', clientId: 'cl_other' }, now);
    const r1 = await post(w1.raw, w1.headers);
    assert.equal(r1.status, 200);
    assert.deepEqual(((await r1.json()) as any).status, 'applied');
    const row = h.db.prepare('SELECT tenant_id, client_id, status FROM webhook_events WHERE event_id=?').get('evt-000001') as any;
    assert.deepEqual([row.tenant_id, row.client_id, row.status], ['tn_demo', 'cl_ortho', 'applied']);
    // Replay of the same event id.
    const r2 = await post(w1.raw, w1.headers);
    assert.equal(((await r2.json()) as any).duplicate, true);
    // Forged signature, tampered body, unknown account, stale timestamp.
    assert.equal((await post(w1.raw, { ...w1.headers, 'x-simch-signature': '0'.repeat(64) })).status, 401);
    assert.equal((await post(w1.raw.replace('P1', 'F1'), w1.headers)).status, 401);
    assert.equal((await post(w1.raw, { ...w1.headers, 'x-simch-account': 'SIMCH-NOPE' })).status, 401);
    const old = buildSimWebhook(h.db, 'SIMCH-ORTHO', { eventId: 'evt-000002', occurredAt: now, claimReference: 'SYN-C1042', statusCategory: 'F1' }, new Date(Date.now() - 10 * 60_000).toISOString());
    assert.equal((await post(old.raw, old.headers)).status, 401);
    // Signed with the other tenant's secret: cannot be replayed as the ortho account.
    const other = buildSimWebhook(h.db, 'SIMCH-OTHER', { eventId: 'evt-000003', occurredAt: now, claimReference: 'SYN-C1042', statusCategory: 'F1' }, now);
    assert.equal((await post(other.raw, { ...other.headers, 'x-simch-account': 'SIMCH-ORTHO' })).status, 401);

    // Newer finalized event applies; an older pending event arriving late is ignored; an explicit correction may move back.
    const fin = buildSimWebhook(h.db, 'SIMCH-ORTHO', { eventId: 'evt-000004', occurredAt: '2026-09-20T00:00:00Z', claimReference: 'SYN-C1042', statusCategory: 'F4' }, now);
    assert.equal(((await (await post(fin.raw, fin.headers)).json()) as any).status, 'applied');
    const late = buildSimWebhook(h.db, 'SIMCH-ORTHO', { eventId: 'evt-000005', occurredAt: '2026-09-15T00:00:00Z', claimReference: 'SYN-C1042', statusCategory: 'P2' }, now);
    assert.equal(((await (await post(late.raw, late.headers)).json()) as any).status, 'ignored_out_of_order');
    const corr = buildSimWebhook(h.db, 'SIMCH-ORTHO', { eventId: 'evt-000006', occurredAt: '2026-09-21T00:00:00Z', claimReference: 'SYN-C1042', statusCategory: 'P2', correction: true }, now);
    assert.equal(((await (await post(corr.raw, corr.headers)).json()) as any).status, 'applied');
    const states = (await sam.get('/api/integrations')).body.webhookStates;
    assert.equal(states.find((s: any) => s.object_ref === 'SYN-C1042').state, 'P2');
    // Status notifications never change facts.
    const csc = fact((await ana.get(`/api/accounts/${await accountByExt(ana, 'SYN-1042')}`)).body, 'claimStatusCategory');
    assert.ok(!csc || csc.status === 'missing', 'webhook notifications are not evidence');
    // The UI simulator path sends a signed event plus a duplicate.
    const sim = await sam.post('/api/integrations/webhooks/simulate', { claimReference: 'SYN-C1043', statusCategory: 'F4', sendDuplicate: true });
    assert.equal(sim.body.first.status, 'applied');
    assert.equal(sim.body.replay.duplicate, true);
  } finally { await h.close(); }
});

test('integration scope isolation and permissions', async () => {
  const { h, ana, sam } = await setup();
  try {
    const { result } = await ingest(sam, '835-cl_ortho-era.edi');
    // Specialists and auditors are not integration admins.
    assert.equal((await ana.get('/api/integrations')).status, 403);
    assert.equal((await ana.post('/api/integrations/edi/preview', { content: fixture('835-cl_ortho-era.edi') })).status, 403);
    const ada = await h.as('u_ada');
    assert.equal((await ada.get('/api/integrations')).status, 403);
    assert.equal((await ada.post('/api/integrations/connectors/availity/onboarding', { record: {} })).status, 403);
    // Another tenant cannot claim this scope, and sees nothing of it from its own.
    const beaSpoof = await h.as('u_bea', 'tn_demo', 'cl_ortho');
    assert.equal((await beaSpoof.get('/api/integrations')).status, 404);
    assert.equal((await beaSpoof.get(`/api/integrations/edi/files/${result.fileId}`)).status, 404);
    const bea = await h.as('u_bea', 'tn_other', 'cl_other');
    await importCohort(bea, 'cl_other');
    assert.equal((await bea.get('/api/integrations')).status, 403, 'u_bea has no supervisor role');
    assert.equal((await bea.post(`/api/integrations/accounts/${await accountByExt(ana, 'SYN-1042')}/status-inquiry`)).status, 404);
    assert.equal((await bea.post(`/api/integrations/accounts/${await accountByExt(ana, 'SYN-1042')}/fhir-pull`)).status, 404);
    // Same tenant, other client: the ortho file is invisible, and the same bytes match nothing in cl_derm.
    const samDerm = await h.as('u_sam', 'tn_demo', 'cl_derm');
    assert.equal((await samDerm.get(`/api/integrations/edi/files/${result.fileId}`)).status, 404);
    assert.equal((await samDerm.get('/api/integrations/edi/files')).body.length, 0);
    const p = await samDerm.post('/api/integrations/edi/preview', { filename: 'era.edi', content: fixture('835-cl_ortho-era.edi') });
    assert.equal(p.body.summary.matched, 0);
    assert.equal(p.body.alreadyIngested, null);
    assert.equal((await samDerm.get('/api/integrations')).body.events.length, 0);
    // Samples are scoped to the client.
    assert.ok((await samDerm.get('/api/integrations/edi/samples')).body.every((s: any) => !s.name.includes('cl_ortho')));
  } finally { await h.close(); }
});
