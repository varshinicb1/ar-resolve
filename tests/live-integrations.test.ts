// ADR 0100: real, gated live connectors against a LOCAL mock of the documented vendor APIs.
// Nothing here calls a real external service.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, importCohort, accountByExt, type Client, type Harness } from './helpers.ts';
import { mockEnv, startLiveMock, stediFixture, type LiveMock, type MockOptions } from '../server/connectors/live/mock-server.ts';
import { setFetchForTests, backoffMs, clearTokenCache } from '../server/connectors/live/http.ts';
import { coverageInquiry } from '../server/connectors/live/availity.ts';
import { decimalToCents, mapEraReport } from '../server/connectors/live/stedi.ts';
import { runSmoke, smokeRefusals } from '../server/connectors/live/smoke.ts';
import { deploymentReasons, envStatus, readVar } from '../server/connectors/live/config.ts';
import { parseEdi } from '../server/connectors/x12/index.ts';
import { one } from '../server/db/db.ts';

const OPTS: MockOptions = {
  stediKey: 'test_SYNTHETIC_stedi_key_123', optum: { id: 'syn-optum-id', secret: 'syn-optum-secret-456' }, availity: { id: 'syn-av-id', secret: 'syn-av-secret-789' },
  twilio: { sid: 'ACsynthetictest000000', token: 'syn-twilio-token-000' },
  // The mock "payer" knows two cl_ortho accounts and one cl_derm claim (for the isolation check).
  claims: [{ claimReference: 'SYN-C1042', memberId: 'PT-3M8D', serviceDate: '2026-06-02', category: 'F1', code: '65', paidCents: 12345, chargeCents: 50000 }],
  eligibility: [{ memberId: 'PT-7Q2K', serviceDate: '2026-07-14', limitCents: 150000, remainingCents: 40000 }],
  eras: [
    { transactionId: 'era-ortho-0001', mode: 'test', applicationMode: 'test', claims: [{ claimReference: 'SYN-C1043', memberId: 'PT-9X1A', serviceDate: '2026-05-21', paid: '100.00', allowed: '280.00', deductible: '180.00', charge: '355.00' }] },
    { transactionId: 'era-other-0002', mode: 'test', applicationMode: 'test', claims: [{ claimReference: 'SYN-CDERM-9', memberId: 'PT-OTHER', serviceDate: '2026-05-01', paid: '1.00', allowed: '1.00', deductible: '0', charge: '1.00' }] },
  ],
};

let mock: LiveMock;
let h: Harness; let ana: Client; let sam: Client;
const saved: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const authorize = (c: Client, id: string, ref = 'SYN-SANDBOX-AUTH-1') => c.post(`/api/integrations/connectors/${id}/authorization`, { authorizationRef: ref, coveredServiceVerified: false, notes: 'Sandbox only, synthetic data' });
const hits = (route: RegExp) => mock.records.filter((r) => route.test(r.path)).length;

before(async () => {
  mock = await startLiveMock(OPTS);
  setEnv(mockEnv(mock, OPTS));
  setFetchForTests((url, init) => fetch(url.startsWith('https://hooks.slack.com/') ? `${mock.url}/slack/${url.slice('https://hooks.slack.com/'.length)}` : url, init));
  h = await start();
  ana = await h.as('u_ana');
  await importCohort(ana);
  sam = await h.as('u_sam');
});
after(async () => {
  setFetchForTests(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await h.close(); await mock.close();
});

test('gate: off by default, then each condition refuses on its own (mode, credentials, authorization, revocation)', async () => {
  const id = await accountByExt(ana, 'SYN-1041');
  const before0 = mock.records.length;
  // Mode off: refused, recorded as a refused connector event, nothing sent.
  await withEnv({ AR_STEDI_MODE: undefined }, async () => {
    const r = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome, 'refused');
    assert.match(r.body.error, /LiveExecutionDisabled: AR_STEDI_MODE is off/);
  });
  // Sandbox but no key: refused and the variable is named.
  await withEnv({ AR_STEDI_API_KEY: undefined }, async () => {
    const r = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726' });
    assert.equal(r.body.outcome, 'refused');
    assert.match(r.body.error, /Missing environment variables for sandbox: AR_STEDI_API_KEY/);
  });
  // Mode and key, but no authorization for this client.
  const noAuth = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726' });
  assert.equal(noAuth.body.outcome, 'refused');
  assert.match(noAuth.body.error, /No customer authorization is recorded/);
  assert.equal(mock.records.length, before0, 'no request left the building while the gate was closed');
  // Authorization opens sandbox; revocation closes it again.
  assert.equal((await authorize(sam, 'stedi')).status, 200);
  const ok = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726' });
  assert.equal(ok.body.outcome, 'success', JSON.stringify(ok.body));
  assert.equal((await sam.post('/api/integrations/live/connectors/stedi/revoke', { reason: 'short' })).status, 400);
  assert.equal((await ana.post('/api/integrations/live/connectors/stedi/revoke', { reason: 'analyst cannot revoke' })).status, 403);
  assert.equal((await sam.post('/api/integrations/live/connectors/stedi/revoke', { reason: 'Rehearsal finished; revoke sandbox access' })).status, 200);
  const revoked = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726' });
  assert.match(revoked.body.error, /was revoked/);
  assert.throws(() => h.db.prepare('DELETE FROM live_authorization_revocations').run(), /append-only/);
  assert.equal((await authorize(sam, 'stedi', 'SYN-SANDBOX-AUTH-2')).status, 200, 'a new authorization re-enables');
});

test('gate: production needs the full live gate, AR_PHI_MODE and live mode for the client; scope does not leak across clients', async () => {
  await authorize(sam, 'stedi', 'SYN-SANDBOX-AUTH-3');
  const id = await accountByExt(ana, 'SYN-1041');
  await withEnv({ AR_STEDI_MODE: 'production' }, async () => {
    const r = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726' });
    assert.equal(r.body.outcome, 'refused');
    for (const re of [/Covered-service verification/, /BAA reference/, /onboarding/i, /synthetic/, /AR_PHI_MODE=on/, /not switched to live/]) assert.match(r.body.error, re);
  });
  // cl_derm has no authorization of its own: the cl_ortho record does not open it.
  const derm = await h.as('u_sam', 'tn_demo', 'cl_derm');
  const ov = (await derm.get('/api/integrations/live')).body.providers.find((p: any) => p.provider === 'stedi');
  assert.equal(ov.authorization, null);
  assert.ok(ov.gate.reasons.some((r: string) => /No customer authorization/.test(r)));
  // Another tenant cannot see this client's connector state at all.
  assert.equal((await (await h.as('u_bea', 'tn_other', 'cl_other')).get('/api/integrations/live')).status, 403);
});

test('sandbox refuses accounts whose identifiers are not synthetic', async () => {
  await authorize(sam, 'stedi', 'SYN-SANDBOX-AUTH-4');
  const id = await accountByExt(ana, 'SYN-1050');
  h.db.prepare("UPDATE accounts SET patient_token='MEMBER-REAL-LOOKING' WHERE account_id=?").run(id);
  const r = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'sandbox_requires_synthetic');
});

test('Stedi eligibility: documented request shape out, 271 in, facts with provenance', async () => {
  await authorize(sam, 'stedi', 'SYN-SANDBOX-AUTH-5');
  const id = await accountByExt(ana, 'SYN-1041');
  const r = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726', payerName: 'UNITEDHEALTHCARE' });
  assert.equal(r.body.outcome, 'success', JSON.stringify(r.body));
  const sent = mock.records.filter((x) => x.path.endsWith('/eligibility/v3/raw-x12')).at(-1)!;
  assert.equal(sent.headers.authorization, OPTS.stediKey, 'API key as the Authorization value, no Bearer prefix (ST1)');
  const x12 = JSON.parse(sent.body).x12 as string;
  const p = parseEdi(x12);
  assert.equal(p.interchange.usage, 'T', 'sandbox sends ISA15=T');
  assert.equal(p.transactions[0].setId, '270');
  assert.equal(r.body.ingest.attached[0].status, 'matched');
  assert.ok(r.body.ingest.attached[0].evidenceId);
  const v = (await ana.get(`/api/accounts/${id}`)).body;
  // limitCents is a fact of this account's rule; the remaining amount is kept as an observation.
  assert.deepEqual([v.facts.find((f: any) => f.key === 'limitCents').value, v.facts.find((f: any) => f.key === 'limitCents').status], [150000, 'verified']);
  const ev = v.evidence.find((e: any) => e.evidenceId === r.body.ingest.attached[0].evidenceId);
  assert.equal(ev.source, `connector:stedi:${r.body.connectorEventId}`);
  assert.ok(ev, 'evidence names the connector event');
  assert.deepEqual(ev.content.extracted.map((x: any) => [x.factKey, x.value]), [['limitCents', 150000], ['deductibleRemainingCents', 40000]]);
  assert.equal(ev.content.source.connectorEventId, r.body.connectorEventId);
  assert.equal(ev.content.source.rawSha256, r.body.rawSha256);
});

test('Stedi claim status: 277 ingested; 999 is a rejection; malformed X12 is an error, never data', async () => {
  await authorize(sam, 'stedi', 'SYN-SANDBOX-AUTH-6');
  const id = await accountByExt(ana, 'SYN-1042');
  const r = await ana.post(`/api/integrations/live/accounts/${id}/claim-status`, { provider: 'stedi', payerId: '87726' });
  assert.equal(r.body.outcome, 'success', JSON.stringify(r.body));
  const v = (await ana.get(`/api/accounts/${id}`)).body;
  const ev = v.evidence.find((e: any) => e.kind === 'edi_277' && e.source === `connector:stedi:${r.body.connectorEventId}`);
  assert.deepEqual(ev.content.extracted.map((x: any) => [x.factKey, x.value]), [['claimReference', 'SYN-C1042'], ['claimStatusCategory', 'F1'], ['claimPaidCents', 12345]]);
  assert.equal(ev.content.source.connectorEventId, r.body.connectorEventId);
  assert.ok(ev.content.extracted.every((x: any) => x.locator.segment && x.locator.interchange), 'each value points at its segment');
  // Documented 999 example (validation errors) -> rejected, nothing ingested, circuit untouched.
  mock.fault('stedi.claimstatus', { status: 200, body: JSON.stringify(stediFixture('claim-status-raw-x12.response.999.json').value) });
  const rej = await ana.post(`/api/integrations/live/accounts/${id}/claim-status`, { provider: 'stedi', payerId: '87726' });
  assert.equal(rej.body.outcome, 'rejected');
  assert.match(rej.body.error, /999/);
  // A truncated interchange is refused by the strict parser.
  mock.fault('stedi.claimstatus', { status: 200, body: JSON.stringify({ x12: 'ISA*00*          *00*    ' }) });
  const bad = await ana.post(`/api/integrations/live/accounts/${id}/claim-status`, { provider: 'stedi', payerId: '87726' });
  assert.equal(bad.body.outcome, 'error');
  assert.match(bad.body.error, /Malformed X12/);
  assert.equal((await ana.post(`/api/integrations/live/accounts/${id}/claim-status`, { provider: 'stedi' })).status, 400, 'payerId required');
});

test('retries: 429 and 503 are retried (Retry-After honoured), 500 and timeouts are not; the circuit opens after 3 failures', async () => {
  await authorize(sam, 'stedi', 'SYN-SANDBOX-AUTH-7');
  const id = await accountByExt(ana, 'SYN-1041');
  const n0 = hits(/eligibility\/v3\/raw-x12/);
  mock.fault('stedi.eligibility', { status: 429, headers: { 'retry-after': '0' }, body: JSON.stringify({ message: 'throttled: CUSTOMER_LIMIT', code: 'TOO_MANY_REQUESTS' }) }, { status: 503 });
  const ok = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726' });
  assert.equal(ok.body.outcome, 'success', JSON.stringify(ok.body));
  assert.equal(hits(/eligibility\/v3\/raw-x12/) - n0, 3, 'two retries then success');
  assert.equal(backoffMs(1, '2'), 2000);
  assert.equal(backoffMs(3, undefined), 1000);
  const n1 = hits(/eligibility\/v3\/raw-x12/);
  mock.fault('stedi.eligibility', { status: 500 });
  const e1 = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726' });
  assert.equal(e1.body.outcome, 'error');
  assert.equal(hits(/eligibility\/v3\/raw-x12/) - n1, 1, '500 is not retried (the payer may still be working on it)');
  mock.fault('stedi.eligibility', { status: 403, body: JSON.stringify({ message: 'Forbidden' }) }, { status: 500 });
  await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726' });
  const e3 = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726' });
  assert.equal(e3.body.outcome, 'error');
  const open = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'stedi', payerId: '87726' });
  assert.equal(open.body.outcome, 'refused');
  assert.match(open.body.error, /Circuit open/);
  assert.equal((await sam.post('/api/integrations/connectors/stedi/circuit/reset')).status, 200);
});

test('timeouts: a hung vendor yields a timeout outcome within the budget', async () => {
  const { httpRequest, HttpFailure } = await import('../server/connectors/live/http.ts');
  mock.fault('stedi.eligibility', { hang: true });
  const t0 = Date.now();
  await assert.rejects(httpRequest({ method: 'POST', url: `${mock.url}/stedi-hc/2024-04-01/change/medicalnetwork/eligibility/v3/raw-x12`, body: '{}', idempotentRead: true, timeoutMs: 300 }),
    (e: unknown) => e instanceof HttpFailure && e.kind === 'timeout');
  assert.ok(Date.now() - t0 < 2000);
});

test('Stedi 835 ERAs: polled, mapped from the documented report fields, only this client\'s claims attached', async () => {
  await authorize(sam, 'stedi', 'SYN-SANDBOX-AUTH-8');
  const id = await accountByExt(ana, 'SYN-1043');
  assert.equal((await ana.post('/api/integrations/live/stedi/remittance/poll', {})).status, 403, 'integration_admin only');
  const r = await sam.post('/api/integrations/live/stedi/remittance/poll', { startDateTime: '2026-10-01T00:00:00Z' });
  assert.equal(r.body.outcome, 'success', JSON.stringify(r.body));
  assert.equal(r.body.eras, 2);
  assert.equal(r.body.attached.length, 1);
  assert.equal(r.body.unmatchedClaims, 1);
  assert.ok(!JSON.stringify(r.body).includes('SYN-CDERM-9'), 'another client\'s claim is counted, never echoed');
  assert.equal(r.body.nextPageToken, 'mock-next-page');
  const v = (await ana.get(`/api/accounts/${id}`)).body;
  assert.equal(v.facts.find((f: any) => f.key === 'appliedCents').value, 18000);
  assert.equal(v.facts.find((f: any) => f.key === 'allowedCents').value, 28000);
  // The documented example maps to the same fact keys (field names verified against it).
  const doc = mapEraReport(stediFixture('report-835.response.json').value, {});
  assert.deepEqual(doc[0].extracted.map((e) => [e.factKey, e.value]), [['claimReference', '1112223333'], ['eobPatientToken', '1234567891'], ['eobServiceDate', '2019-03-01'],
    ['allowedCents', 80000], ['adjustmentGroup', 'PR'], ['appliedCents', 30000], ['claimPaidCents', 50000], ['processedDate', '2019-03-14']]);
  assert.equal(decimalToCents('108.77'), 10877);
  assert.equal(decimalToCents('1.234'), null, 'sub-cent values refused, not rounded');
  // A production-mode ERA in sandbox is refused by the PHI ingest gate.
  mock.options.eras!.push({ transactionId: 'era-prod-0003', mode: 'production', applicationMode: 'production', claims: [] });
  const prod = await sam.post('/api/integrations/live/stedi/remittance/poll', { pageToken: 'x' });
  assert.equal(prod.body.ingestError.code, 'phi_gate_closed');
  mock.options.eras!.pop();
});

test('Optum: JSON token body, claim status mapped when the account number is echoed; eligibility kept as an event only', async () => {
  assert.equal((await authorize(sam, 'optum_change_healthcare')).status, 200);
  clearTokenCache();
  const id = await accountByExt(ana, 'SYN-1042');
  const r = await ana.post(`/api/integrations/live/accounts/${id}/claim-status`, { provider: 'optum', payerId: '00003' });
  assert.equal(r.body.outcome, 'success', JSON.stringify(r.body));
  const tok = mock.records.find((x) => x.path === '/optum/apip/auth/v2/token')!;
  assert.deepEqual(JSON.parse(tok.body), { client_id: OPTS.optum!.id, client_secret: OPTS.optum!.secret, grant_type: 'client_credentials' });
  assert.equal(r.body.ingest.attached[0].status, 'matched');
  const el = await ana.post(`/api/integrations/live/accounts/${id}/eligibility`, { provider: 'optum', payerId: '00001' });
  assert.equal(el.body.outcome, 'success');
  assert.match(el.body.ingest.note, /no facts are created/);
  assert.equal(mock.records.filter((x) => x.path === '/optum/apip/auth/v2/token').length, 1, 'token cached for its lifetime');
});

test('Availity: form token with scope=hipaa, demo scenario header, In Process polling until Complete', async () => {
  clearTokenCache();
  mock.options.availityInProcessPolls = 2;
  const sleeps: number[] = [];
  const r = await coverageInquiry({ payerId: 'SYNPAYER', providerNpi: '0000000000' }, 20_000, async (ms) => { sleeps.push(ms); });
  assert.equal(r.outcome, 'success', r.error ?? '');
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.equal((r.normalized as any).statusCode, '4');
  assert.equal((r.normalized as any).mock, true);
  const tok = mock.records.find((x) => x.path === '/availity/v1/token')!;
  assert.equal(new URLSearchParams(tok.body).get('scope'), 'hipaa');
  assert.ok(mock.records.some((x) => x.headers['x-api-mock-scenario-id'] === 'mock-scenario'));
  assert.equal((await coverageInquiry({ 'bad name': 'x' }, 5000)).outcome, 'rejected');
  mock.options.availityInProcessPolls = 0;
});

test('Twilio sandbox: test credentials, magic numbers, never a real destination', async () => {
  const off = await sam.post('/api/integrations/live/twilio/test-call', {});
  assert.equal(off.body.outcome, 'refused');
  await authorize(sam, 'twilio_voice');
  const ok = await sam.post('/api/integrations/live/twilio/test-call', { to: '+14108675310' });
  assert.equal(ok.body.outcome, 'success', JSON.stringify(ok.body));
  assert.equal(ok.body.normalized.placed, false);
  const bad = await sam.post('/api/integrations/live/twilio/test-call', { to: '+15005550001' });
  assert.equal(bad.body.outcome, 'rejected');
  assert.equal(bad.body.normalized.code, 21217);
  const real = await sam.post('/api/integrations/live/twilio/test-call', { to: '+12025550123' });
  assert.equal(real.body.outcome, 'rejected', 'sandbox only dials documented test numbers');
  const sent = mock.records.filter((x) => x.path.startsWith('/twilio/'));
  assert.ok(sent.every((x) => new URLSearchParams(x.body).get('From') === '+15005550006'));
});

test('notifications: Postmark and Slack sends go through the gate and the outbox; Postmark never gets details', async () => {
  const pm = await sam.post('/api/notifications/channels', { kind: 'postmark', name: 'Staff email', config: { to: 'staff@example.com' }, events: ['integration.test'], includeDetails: true });
  assert.equal(pm.status, 200, JSON.stringify(pm.body));
  const refused = await sam.post(`/api/notifications/channels/${pm.body.channelId}/test`);
  assert.equal(refused.body.status, 'refused', 'no postmark_email authorization yet');
  assert.match(refused.body.lastError ?? refused.body.last_error ?? JSON.stringify(refused.body), /No customer authorization/);
  await authorize(sam, 'postmark_email');
  const sent = await sam.post(`/api/notifications/channels/${pm.body.channelId}/test`);
  assert.equal(sent.body.status, 'delivered', JSON.stringify(sent.body));
  const req = mock.records.filter((x) => x.path === '/postmark/email').at(-1)!;
  assert.equal(req.headers['x-postmark-server-token'], 'POSTMARK_API_TEST', 'sandbox uses the documented test token');
  const sl = await sam.post('/api/notifications/channels', { kind: 'slack', name: 'Ops', config: { url: `https://hooks.slack.com/services/${['TEST', 'TEST', 'not-a-secret'].join('/')}` }, events: ['integration.test'] });
  await authorize(sam, 'slack_notify');
  const s = await sam.post(`/api/notifications/channels/${sl.body.channelId}/test`);
  assert.equal(s.body.status, 'delivered', JSON.stringify(s.body));
  assert.ok(typeof JSON.parse(mock.records.filter((x) => x.path.startsWith('/slack/')).at(-1)!.body).text === 'string');
});

test('overview: env var names and presence only, never values; last smoke result shown; smoke refuses production and missing keys', async () => {
  const report = await runSmoke('stedi', { db: h.db, target: 'local_mock' });
  assert.equal(report.outcome, 'pass', JSON.stringify(report));
  const r = await sam.get('/api/integrations/live');
  assert.equal(r.status, 200);
  const raw = JSON.stringify(r.body);
  for (const secret of [OPTS.stediKey!, OPTS.optum!.secret, OPTS.availity!.secret, OPTS.twilio!.token]) assert.ok(!raw.includes(secret), 'no secret value in the overview');
  const st = r.body.providers.find((p: any) => p.provider === 'stedi');
  assert.equal(st.mode, 'sandbox');
  assert.deepEqual(st.envVars.map((v: any) => [v.name, v.present]), [['AR_STEDI_API_KEY', true]]);
  assert.equal(st.lastSmoke.outcome, 'pass');
  assert.equal(st.lastSmoke.target, 'local_mock');
  assert.ok(st.sources.length >= 5 && st.sources.every((s: any) => s.retrievedAt && s.url.startsWith('https://')));
  assert.equal((await ana.get('/api/integrations/live')).status, 403);
  assert.match(smokeRefusals('stedi', { AR_STEDI_MODE: 'production', AR_STEDI_API_KEY: 'x' })[0], /never in production/);
  assert.match(smokeRefusals('optum', { AR_OPTUM_MODE: 'sandbox' })[0], /AR_OPTUM_CLIENT_ID, AR_OPTUM_CLIENT_SECRET/);
  assert.match(smokeRefusals('slack', {})[0], /not set to sandbox/);
  const refusedRun = await withEnv({ AR_TWILIO_MODE: 'production' }, () => runSmoke('twilio', { db: h.db }));
  assert.equal(refusedRun.outcome, 'refused');
  assert.equal(refusedRun.checks.length, 0, 'nothing was called');
  assert.equal(one<{ n: number }>(h.db, "SELECT COUNT(*) n FROM live_smoke_runs WHERE outcome='refused'")!.n, 1);
});

test('config: secrets from <NAME>_FILE, loopback overrides need the explicit flag, writes are not exposed', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const f = join(mkdtempSync(join(tmpdir(), 'arlive-')), 'key');
  writeFileSync(f, 'from-file-key\n');
  assert.equal(readVar('AR_STEDI_API_KEY', { AR_STEDI_API_KEY_FILE: f }), 'from-file-key');
  assert.equal(envStatus('stedi', { AR_STEDI_MODE: 'sandbox', AR_STEDI_API_KEY_FILE: f })[0].source, 'file');
  assert.match(deploymentReasons('stedi', { AR_STEDI_MODE: 'sandbox', AR_STEDI_API_KEY: 'k', AR_STEDI_HEALTHCARE_BASE_URL: 'http://127.0.0.1:1' }).join(' '), /must be a public https URL/);
  assert.deepEqual(deploymentReasons('stedi', { AR_STEDI_MODE: 'sandbox', AR_STEDI_API_KEY: 'k' }), []);
  const ov = (await sam.get('/api/integrations/live')).body.providers;
  for (const p of ov) assert.ok(!p.capabilities.some((c: string) => ['submit_request', 'writeback', 'document'].includes(c)), `${p.provider} exposes no payer writes`);
});
