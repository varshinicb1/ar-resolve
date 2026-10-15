// ADR 0110: Connect providers. Keys and modes entered in the app, over the real HTTP API, against a
// LOCAL mock of the documented vendor APIs. Nothing here calls a real external service.
// Security properties: a secret never appears in a response, audit row, history row, smoke row or log
// line; only integration_admin reads or writes; the environment beats a stored value; sealing fails
// closed outside synthetic; production is refused in synthetic; the test refuses production; the
// per-provider rate limit holds; a stored key is the one the Stedi adapter actually sends.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb, all, type Db } from '../server/db/db.ts';
import { seed } from '../server/services/seed.ts';
import { createApp } from '../server/http/app.ts';
import { loadConfig } from '../server/config.ts';
import { createLogger } from '../server/log.ts';
import { createSession } from '../server/services/auth.ts';
import { cohort } from '../server/connectors/synthetic-source.ts';
import { startLiveMock, type LiveMock } from '../server/connectors/live/mock-server.ts';
import { resetTestRateLimit, useConnectorSettings } from '../server/connectors/live/connector-settings.ts';

const SECRET = 'test_fake_SECRETVALUE_7c1d4f2a';
const ENV_KEY = 'env_wins_key_000000000000';
const tmp = mkdtempSync(join(tmpdir(), 'ar-connect-'));
const KEY_FILE = join(tmp, 'connector-settings.key');

const logs: string[] = [];
const seen: string[] = []; // every response body, as text
let mock: LiveMock;
let db: Db; let server: Server; let base = '';
const savedEnv: Record<string, string | undefined> = {};

interface Res { status: number; body: any }
type Call = (method: string, path: string, body?: unknown) => Promise<Res>;

function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}

async function client(baseUrl: string, token: string, tenantId = 'tn_demo', clientId = 'cl_ortho'): Promise<Call> {
  return async (method, path, body) => {
    const r = await fetch(baseUrl + path, { method, headers: { authorization: `Bearer ${token}`, 'x-tenant': tenantId, 'x-client': clientId, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    seen.push(text);
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
}
const as = (userId: string, tenantId?: string, clientId?: string) => client(base, createSession(db, userId), tenantId, clientId);
const stedi = (s: Res) => s.body.providers.find((p: any) => p.provider === 'stedi');
const stediVar = (s: Res, name = 'AR_STEDI_API_KEY') => stedi(s).vars.find((v: any) => v.name === name);
const stediHits = () => mock.records.filter((r) => r.path.startsWith('/stedi-'));
/** Each test sets the state it needs, so a single test can run alone (scripts/stress/mutate.ts does that). */
async function storeStediSandbox(sam: Call) {
  const v = await sam('PUT', '/api/integrations/connect/stedi/values', { values: { AR_STEDI_API_KEY: SECRET } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal((await sam('PUT', '/api/integrations/connect/stedi/mode', { mode: 'sandbox' })).status, 200);
}

before(async () => {
  for (const k of ['AR_STEDI_MODE', 'AR_STEDI_API_KEY', 'AR_STEDI_API_KEY_FILE', 'AR_PHI_KEY', 'AR_PHI_KEYS', 'AR_PHI_ACTIVE_KEY_ID']) setEnv(k, undefined);
  mock = await startLiveMock({ stediKey: SECRET });
  setEnv('AR_CONNECTOR_KEY_FILE', KEY_FILE);
  setEnv('AR_LIVE_ALLOW_LOOPBACK', '1');
  setEnv('AR_STEDI_HEALTHCARE_BASE_URL', `${mock.url}/stedi-hc/2024-04-01`);
  setEnv('AR_STEDI_CORE_BASE_URL', `${mock.url}/stedi-core/2023-08-01`);
  db = openDb(':memory:');
  seed(db);
  server = createApp(db, { logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }) });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); });
  await mock.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('connect: only integration_admin reads or writes; u_bea and u_ada cannot read settings', async () => {
  for (const [user, t, c] of [['u_ana'], ['u_rui'], ['u_ada'], ['u_bea', 'tn_other', 'cl_other'], ['u_bea']] as [string, string?, string?][]) {
    const call = await as(user, t, c);
    const g = await call('GET', '/api/integrations/connect');
    assert.ok(g.status === 403 || (user === 'u_bea' && !t && g.status === 404), `${user} ${t ?? ''} read settings: ${g.status}`);
    assert.equal(g.body.providers, undefined);
    assert.ok([403, 404].includes((await call('PUT', '/api/integrations/connect/stedi/values', { values: { AR_STEDI_API_KEY: SECRET } })).status));
    assert.ok([403, 404].includes((await call('PUT', '/api/integrations/connect/stedi/mode', { mode: 'sandbox' })).status));
    assert.ok([403, 404].includes((await call('POST', '/api/integrations/connect/stedi/test')).status));
    assert.ok([403, 404].includes((await call('GET', '/api/integrations/connect/stedi/history')).status));
  }
  assert.equal(all(db, 'SELECT * FROM connector_settings').length, 0, 'nothing stored by a non-admin');
});

test('connect: synthetic without a sealing key creates a 0600 key file, seals the secret and shows only the last 4', async () => {
  const sam = await as('u_sam');
  const s0 = await sam('GET', '/api/integrations/connect');
  assert.equal(s0.status, 200);
  assert.deepEqual(s0.body.providers.map((p: any) => p.provider), ['stedi', 'availity', 'optum', 'twilio', 'slack', 'postmark']);
  assert.equal(s0.body.sealing.mode, 'local_file');
  assert.equal(stediVar(s0).source, 'missing');
  assert.equal(existsSync(KEY_FILE), false, 'key file is created lazily');

  const put = await sam('PUT', '/api/integrations/connect/stedi/values', { values: { AR_STEDI_API_KEY: SECRET } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(statSync(KEY_FILE).mode & 0o777, 0o600);
  const row = all<{ value: string; last4: string }>(db, "SELECT value, last4 FROM connector_settings WHERE name='AR_STEDI_API_KEY'")[0];
  assert.match(row.value, /^enc:v2:local:/);
  assert.ok(!row.value.includes(SECRET));
  assert.equal(row.last4, '4f2a');

  const s1 = await sam('GET', '/api/integrations/connect');
  const v = stediVar(s1);
  assert.equal(v.source, 'saved');
  assert.equal(v.last4, '4f2a');
  assert.equal(v.value, null);
  assert.equal(v.setBy.userId, 'u_sam');
  assert.equal(stedi(s1).gate.status[0], 'Off');
  const hist = await sam('GET', '/api/integrations/connect/stedi/history');
  assert.equal(hist.body.changes[0].fingerprint, '…4f2a');
  assert.equal(hist.body.changes[0].action, 'set');
});

test('connect: empty string leaves a value unchanged; unknown names and control characters are refused without echo', async () => {
  const sam = await as('u_sam');
  const before0 = all(db, 'SELECT * FROM connector_settings');
  assert.equal((await sam('PUT', '/api/integrations/connect/stedi/values', { values: { AR_STEDI_API_KEY: '' } })).status, 400, 'nothing to change');
  assert.deepEqual(all(db, 'SELECT * FROM connector_settings'), before0);
  const bad = await sam('PUT', '/api/integrations/connect/stedi/values', { values: { AR_PHI_MODE: 'off' } });
  assert.equal(bad.status, 400);
  const other = await sam('PUT', '/api/integrations/connect/stedi/values', { values: { AR_OPTUM_CLIENT_SECRET: 'x' } });
  assert.equal(other.status, 400, 'a name of another provider is refused');
  const nl = await sam('PUT', '/api/integrations/connect/stedi/values', { values: { AR_STEDI_API_KEY: `${SECRET}\nX` } });
  assert.equal(nl.status, 400);
  assert.ok(!JSON.stringify(nl.body).includes(SECRET));
  assert.equal((await sam('PUT', '/api/integrations/connect/nope/values', { values: {} })).status, 400);
});

test('connect: production mode is refused in synthetic', async () => {
  const sam = await as('u_sam');
  const r = await sam('PUT', '/api/integrations/connect/stedi/mode', { mode: 'production' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'production_needs_non_synthetic');
  const s = await sam('GET', '/api/integrations/connect');
  assert.equal(stedi(s).productionAllowed, false);
  assert.equal(stedi(s).mode, 'off');
});

test('connect: a stored Stedi key is used end to end (save, sandbox, test via API, adapter call) and the mock sees it', async () => {
  const sam = await as('u_sam');
  resetTestRateLimit();
  await storeStediSandbox(sam);
  const runs0 = all(db, "SELECT 1 FROM live_smoke_runs WHERE provider='stedi'").length;
  const t = await sam('POST', '/api/integrations/connect/stedi/test');
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.outcome, 'pass', t.body.lines.join('\n'));
  assert.equal(t.body.target, 'local_mock', 'a loopback override is recorded as a mock rehearsal, not the vendor sandbox');
  assert.ok(t.body.lines.some((l: string) => /PASS/.test(l)));
  assert.ok(stediHits().length > 0);
  assert.ok(stediHits().every((r) => r.headers.authorization === SECRET), 'the mock saw the stored key');
  const run = all<{ outcome: string; run_by: string }>(db, "SELECT outcome, run_by FROM live_smoke_runs WHERE provider='stedi' ORDER BY rowid");
  assert.equal(run.length, runs0 + 1);
  assert.equal(run.at(-1)!.outcome, 'pass');
  assert.equal(run.at(-1)!.run_by, 'app:u_sam');

  // The adapter path (account eligibility through the gate) uses the stored key too.
  const ana = await as('u_ana');
  assert.equal((await ana('POST', '/api/imports', { sourceName: 'cl_ortho.csv', csv: cohort().inventories.cl_ortho })).status, 200);
  const acct = (await ana('GET', '/api/accounts?q=SYN-1041')).body.items.find((i: any) => i.externalId === 'SYN-1041').accountId;
  assert.equal((await sam('POST', '/api/integrations/connectors/stedi/authorization', { authorizationRef: 'SYN-SANDBOX-AUTH-1', coveredServiceVerified: false, notes: 'Sandbox only' })).status, 200);
  const s = await sam('GET', '/api/integrations/connect');
  assert.deepEqual(stedi(s).gate.status, ['Ready for sandbox']);
  const n = stediHits().length;
  const e = await ana('POST', `/api/integrations/live/accounts/${acct}/eligibility`, { provider: 'stedi', payerId: '87726' });
  assert.equal(e.body.outcome, 'success', JSON.stringify(e.body));
  assert.equal(stediHits().length, n + 1);
  assert.equal(stediHits().at(-1)!.headers.authorization, SECRET);
});

test('connect: the test is rate limited to one run per provider per 10 seconds', async () => {
  const sam = await as('u_sam');
  resetTestRateLimit();
  await storeStediSandbox(sam);
  assert.equal((await sam('POST', '/api/integrations/connect/stedi/test')).status, 200);
  const r = await sam('POST', '/api/integrations/connect/stedi/test');
  assert.equal(r.status, 429);
  assert.equal(r.body.error.code, 'rate_limited');
});

test('connect: the environment beats a stored value and locks the field', async () => {
  const sam = await as('u_sam');
  await storeStediSandbox(sam);
  setEnv('AR_STEDI_API_KEY', ENV_KEY);
  try {
    const s = await sam('GET', '/api/integrations/connect');
    assert.equal(stediVar(s).source, 'environment');
    assert.equal(stediVar(s).last4, null);
    const put = await sam('PUT', '/api/integrations/connect/stedi/values', { values: { AR_STEDI_API_KEY: 'another_fake_value_123456' } });
    assert.equal(put.status, 409);
    assert.equal(put.body.error.code, 'locked_by_environment');
    resetTestRateLimit();
    const n = stediHits().length;
    const t = await sam('POST', '/api/integrations/connect/stedi/test');
    assert.equal(t.body.outcome, 'fail', 'the mock refuses the environment key, so the stored key was not used');
    assert.ok(stediHits().slice(n).every((r) => r.headers.authorization === ENV_KEY));
  } finally { setEnv('AR_STEDI_API_KEY', undefined); }
  setEnv('AR_STEDI_MODE', 'off');
  try {
    const s = await sam('GET', '/api/integrations/connect');
    assert.equal(stedi(s).mode, 'off');
    assert.equal(stedi(s).modeSource, 'environment');
    assert.equal((await sam('PUT', '/api/integrations/connect/stedi/mode', { mode: 'sandbox' })).status, 409);
  } finally { setEnv('AR_STEDI_MODE', undefined); }
});

test('connect: the test refuses production mode exactly as smoke:live does', async () => {
  const sam = await as('u_sam');
  await storeStediSandbox(sam); // keys present: only production mode can refuse
  setEnv('AR_STEDI_MODE', 'production');
  try {
    resetTestRateLimit();
    const n = stediHits().length;
    const t = await sam('POST', '/api/integrations/connect/stedi/test');
    assert.equal(t.status, 200);
    assert.equal(t.body.outcome, 'refused');
    assert.match(t.body.reasons[0], /never in production mode/);
    assert.equal(stediHits().length, n, 'nothing sent');
  } finally { setEnv('AR_STEDI_MODE', undefined); }
});

test('connect: an insecure local key file is refused', async () => {
  const sam = await as('u_sam');
  chmodSync(KEY_FILE, 0o644);
  try {
    const r = await sam('PUT', '/api/integrations/connect/stedi/values', { values: { AR_STEDI_API_KEY: 'another_fake_value_123456' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'sealing_key_insecure');
  } finally { chmodSync(KEY_FILE, 0o600); }
});

test('connect: outside synthetic, no sealing key refuses a secret; a keyring from the environment seals it', async () => {
  const sdb = openDb(':memory:');
  seed(sdb);
  const cfg = { ...loadConfig(), env: 'staging' as const, synthetic: false };
  const s2 = createApp(sdb, { config: cfg, logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }) });
  await new Promise<void>((r) => s2.listen(0, r));
  const sam = await client(`http://127.0.0.1:${(s2.address() as AddressInfo).port}`, createSession(sdb, 'u_sam'));
  try {
    const g = await sam('GET', '/api/integrations/connect');
    assert.equal(g.body.sealing.mode, 'missing');
    assert.equal(stedi(g).productionAllowed, true);
    const r = await sam('PUT', '/api/integrations/connect/stedi/values', { values: { AR_STEDI_API_KEY: SECRET } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'sealing_key_missing');
    assert.match(r.body.error.message, /AR_PHI_KEYS/);
    assert.equal(all(sdb, 'SELECT * FROM connector_settings').length, 0);
    // A non-secret value needs no sealing key.
    assert.equal((await sam('PUT', '/api/integrations/connect/optum/values', { values: { AR_OPTUM_CLIENT_ID: 'syn-client-id' } })).status, 200);
    // Production mode may be chosen outside synthetic; the live gate still applies on top.
    assert.equal((await sam('PUT', '/api/integrations/connect/optum/mode', { mode: 'production' })).status, 200);
    const g2 = await sam('GET', '/api/integrations/connect');
    const optum = g2.body.providers.find((p: any) => p.provider === 'optum');
    assert.equal(optum.mode, 'production');
    assert.equal(optum.gate.open, false);
    assert.ok(optum.gate.status.some((x: string) => /BAA/.test(x)), optum.gate.status.join('; '));
    setEnv('AR_PHI_KEYS', `k1:${randomBytes(32).toString('base64')}`);
    setEnv('AR_PHI_ACTIVE_KEY_ID', 'k1');
    try {
      const ok = await sam('PUT', '/api/integrations/connect/stedi/values', { values: { AR_STEDI_API_KEY: SECRET } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.match(all<{ value: string }>(sdb, "SELECT value FROM connector_settings WHERE name='AR_STEDI_API_KEY'")[0].value, /^enc:v2:k1:/);
    } finally { setEnv('AR_PHI_KEYS', undefined); setEnv('AR_PHI_ACTIVE_KEY_ID', undefined); }
  } finally {
    await new Promise<void>((r) => { s2.close(() => r()); s2.closeAllConnections?.(); });
    useConnectorSettings(db, { synthetic: true, dbPath: ':memory:' }); // the main app's store again
  }
});

test('connect: clear removes a stored value and is recorded', async () => {
  const sam = await as('u_sam');
  const r = await sam('PUT', '/api/integrations/connect/stedi/values', { clear: ['AR_STEDI_API_KEY'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changes, [{ name: 'AR_STEDI_API_KEY', action: 'cleared' }]);
  const s = await sam('GET', '/api/integrations/connect');
  assert.equal(stediVar(s).source, 'missing');
  assert.equal(stedi(s).gate.status[0], 'Missing: API key');
  const hist = await sam('GET', '/api/integrations/connect/stedi/history');
  assert.equal(hist.body.changes[0].action, 'cleared');
});

test('connect: the secret never appears in any response, audit row, history, smoke row, connector event or log line', async () => {
  assert.ok(seen.length > 20, 'responses were captured');
  for (const text of seen) assert.ok(!text.includes(SECRET), `response leaked the secret: ${text.slice(0, 200)}`);
  for (const line of logs) assert.ok(!line.includes(SECRET), `log leaked the secret: ${line.slice(0, 200)}`);
  assert.ok(logs.some((l) => l.includes('/api/integrations/connect')), 'request logs were captured');
  const tables = ['audit_events', 'connector_setting_changes', 'live_smoke_runs', 'connector_events', 'connector_settings'];
  for (const t of tables) {
    const dump = JSON.stringify(all(db, `SELECT * FROM ${t}`));
    assert.ok(!dump.includes(SECRET), `${t} holds the secret in clear`);
  }
  const audits = all<{ event_type: string; details: string }>(db, "SELECT event_type, details FROM audit_events WHERE object_type='connector_settings'");
  assert.ok(audits.some((a) => a.event_type === 'connector_settings_changed'));
  assert.ok(audits.some((a) => a.event_type === 'connector_mode_changed'));
  assert.ok(audits.some((a) => a.event_type === 'connector_test_run'));
  for (const a of audits) assert.ok(!a.details.includes('4f2a'), 'audit rows carry names and actions only, not even the last 4');
});
