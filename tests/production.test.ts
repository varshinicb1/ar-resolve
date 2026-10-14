// ADR 0090: environments and fail-closed configuration, HTTP hardening (headers, CORS, rate limits,
// body limits, timeouts, error envelope), operability endpoints, structured logs with PHI
// redaction, and graceful shutdown of the API and the worker as real processes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db, run } from '../server/db/db.ts';
import { seed } from '../server/services/seed.ts';
import { createApp, lifecycleOf } from '../server/http/app.ts';
import { ConfigError, loadConfig, deploymentEnv, type Config } from '../server/config.ts';
import { createLogger, redact } from '../server/log.ts';
import { createSession } from '../server/services/auth.ts';
import { createKey } from '../server/services/access.ts';
import { createLoop, installShutdown, seedFor } from '../server/runtime.ts';

// Synthetic test keys, never real secrets.
const PHI = Buffer.alloc(32, 7).toString('base64');
const PROD: Record<string, string> = {
  AR_ENV: 'production', AR_ENVIRONMENT: 'shadow', AR_DB: '/data/ar-resolve.db', AR_PUBLIC_BASE_URL: 'https://ar.example.test',
  AR_SESSION_SECRET: 'x'.repeat(48), AR_PHI_KEYS: `k1:${PHI}`, AR_PHI_ACTIVE_KEY_ID: 'k1', AR_ALLOWED_ORIGINS: 'https://ar.example.test,https://admin.example.test',
  AR_OIDC_ISSUER: 'https://idp.example.test', AR_OIDC_CLIENT_ID: 'client', AR_OIDC_CLIENT_SECRET: 'secret', AR_METRICS_TOKEN: 'm'.repeat(32), AR_BACKUP_DIR: '/backups',
};
// readiness reads the deployment keyring from the process environment.
process.env.AR_PHI_KEYS = `k1:${PHI}`;
process.env.AR_PHI_ACTIVE_KEY_ID = 'k1';

const servers: Server[] = [];
after(async () => { for (const s of servers) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); }); });

async function boot(cfg: Config, db?: Db, lines?: string[]) {
  const d = db ?? openDb(':memory:');
  if (!db) seed(d); // demo users/grants for the tests, whatever the config; production itself never seeds them (see seedFor test)
  const s = createApp(d, { config: cfg, logger: createLogger({ level: 'info', sink: (l) => lines?.push(l) }) });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return { db: d, server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

test('AR_ENV: default synthetic, unknown value refused, synthetic config keeps today\'s behaviour', () => {
  assert.equal(deploymentEnv({}), 'synthetic');
  assert.throws(() => deploymentEnv({ AR_ENV: 'prod' }), ConfigError);
  const c = loadConfig({});
  assert.equal(c.synthetic, true);
  assert.equal(c.devLogin, true);
  assert.equal(c.dbPath, 'data/ar-resolve.db');
  assert.equal(c.rateLimit.ipPerMinute, 0);
  assert.equal(c.metricsToken, null);
  assert.throws(() => loadConfig({ AR_ENVIRONMENT: 'shadow' }), /AR_ENV=synthetic but AR_ENVIRONMENT=shadow/);
});

test('production fails closed: every required setting, removed one at a time, stops startup (gate mutation test)', () => {
  const ok = loadConfig(PROD);
  assert.equal(ok.env, 'production');
  assert.equal(ok.devLogin, false);
  assert.equal(ok.http.hsts, true);
  assert.equal(ok.backup.encrypt, true);
  assert.ok(ok.session.cookieName.startsWith('__Host-'));
  const required: [string, RegExp][] = [
    ['AR_ENVIRONMENT', /AR_ENVIRONMENT=shadow or assisted_live/], ['AR_DB', /AR_DB is required/], ['AR_PUBLIC_BASE_URL', /AR_PUBLIC_BASE_URL is required/],
    ['AR_SESSION_SECRET', /AR_SESSION_SECRET is required/], ['AR_PHI_KEYS', /AR_PHI_KEYS .* is required/], ['AR_ALLOWED_ORIGINS', /AR_ALLOWED_ORIGINS is required/],
    ['AR_OIDC_ISSUER', /AR_OIDC_ISSUER/], ['AR_OIDC_CLIENT_ID', /AR_OIDC_CLIENT_ID/], ['AR_OIDC_CLIENT_SECRET', /AR_OIDC_CLIENT_SECRET/],
    ['AR_METRICS_TOKEN', /AR_METRICS_TOKEN is required/], ['AR_BACKUP_DIR', /AR_BACKUP_DIR is required/],
  ];
  for (const [k, re] of required) {
    const env = { ...PROD };
    delete env[k];
    if (k === 'AR_PHI_KEYS') delete env.AR_PHI_ACTIVE_KEY_ID;
    assert.throws(() => loadConfig(env), (e: ConfigError) => e instanceof ConfigError && e.problems.some((p) => re.test(p)), `removing ${k} must stop startup`);
  }
  const bad: [Record<string, string>, RegExp][] = [
    [{ AR_DB: 'relative.db' }, /AR_DB must be an absolute path/], [{ AR_PUBLIC_BASE_URL: 'http://ar.example.test' }, /must use https/],
    [{ AR_SESSION_SECRET: 'short' }, /AR_SESSION_SECRET/], [{ AR_OIDC_ISSUER: 'http://idp.example.test' }, /AR_OIDC_ISSUER must use https/],
    [{ AR_BACKUP_ENCRYPT: 'off' }, /AR_BACKUP_ENCRYPT=off is not allowed/], [{ AR_ALLOWED_ORIGINS: 'https://ar.example.test/path' }, /bare origin/],
    [{ AR_OIDC_ALLOWED_ALGS: 'HS256' }, /AR_OIDC_ALLOWED_ALGS/], [{ AR_DEV_LOGIN: 'on' }, /AR_DEV_LOGIN is not allowed/],
    [{ AR_PHI_KEYS: 'k1:notbase64', AR_PHI_ACTIVE_KEY_ID: 'k1' }, /PHI keyring invalid/], [{ AR_ENVIRONMENT: 'synthetic' }, /requires AR_ENVIRONMENT/],
  ];
  for (const [patch, re] of bad) assert.throws(() => loadConfig({ ...PROD, ...patch }), (e: ConfigError) => e.problems.some((p) => re.test(p)), JSON.stringify(patch));
  // All problems are reported at once.
  assert.throws(() => loadConfig({ AR_ENV: 'staging' }), (e: ConfigError) => e.problems.length >= 8);
});

test('production app: no dev login, no simulator routes, dev tokens refused, named API keys still work', async () => {
  const cfg = loadConfig(PROD);
  const { db, base } = await boot(cfg);
  for (const [m, p] of [['GET', '/api/dev/users'], ['POST', '/api/dev/login'], ['POST', '/api/ops/faults'], ['POST', '/api/webhooks/sim-payer'], ['POST', '/api/ops/sim-confirm/x'], ['POST', '/api/accounts/x/calls/simulate']]) {
    const r = await fetch(base + p, { method: m, body: m === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  const dev = createSession(db, 'u_sam');
  const refused = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${dev}` } });
  assert.equal(refused.status, 401);
  const { token } = createKey(db, { userId: 'u_sam', displayName: 'Sam', tenantId: 'tn_demo', clientId: 'cl_ortho', roles: ['supervisor'] }, { name: 'pilot export', roles: ['supervisor'], reason: 'machine client for the pilot' });
  const me = await fetch(`${base}/api/accounts`, { headers: { authorization: `Bearer ${token}`, 'x-tenant': 'tn_demo', 'x-client': 'cl_ortho' } });
  assert.equal(me.status, 200);
  const cfgRoute = await (await fetch(`${base}/api/auth/config`)).json();
  assert.deepEqual({ sso: cfgRoute.sso, devLogin: cfgRoute.devLogin, environment: cfgRoute.environment }, { sso: true, devLogin: false, environment: 'production' });
});

test('production seed: reference data only, no demo users or grants', () => {
  const db = openDb(':memory:');
  seedFor(db, loadConfig(PROD));
  assert.equal((db.prepare('SELECT count(*) n FROM users').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT count(*) n FROM grants').get() as { n: number }).n, 0);
  assert.ok((db.prepare('SELECT count(*) n FROM rule_versions').get() as { n: number }).n > 0);
});

test('security headers: CSP for the built UI, HSTS only in production, frame and sniffing protection, request ids', async () => {
  const prod = await boot(loadConfig(PROD));
  const r = await fetch(`${prod.base}/healthz`);
  const csp = r.headers.get('content-security-policy')!;
  for (const d of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'", 'upgrade-insecure-requests']) assert.ok(csp.includes(d), d);
  assert.ok(!/unsafe-(inline|eval)/.test(csp));
  assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('x-request-id')!, /^[0-9a-f-]{36}$/);
  const echoed = await fetch(`${prod.base}/healthz`, { headers: { 'x-request-id': 'req-abc-12345' } });
  assert.equal(echoed.headers.get('x-request-id'), 'req-abc-12345');
  const syn = await boot(loadConfig({}));
  const s = await fetch(`${syn.base}/api/health`);
  assert.equal(s.headers.get('strict-transport-security'), null);
  assert.ok(s.headers.get('content-security-policy'));
});

test('CORS allowlist: preflight, credentialed responses, foreign origins refused', async () => {
  const { base } = await boot(loadConfig(PROD));
  const pre = await fetch(`${base}/api/me`, { method: 'OPTIONS', headers: { origin: 'https://admin.example.test', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://admin.example.test');
  assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
  assert.match(pre.headers.get('access-control-allow-headers')!, /x-csrf-token/);
  const evilPre = await fetch(`${base}/api/me`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(evilPre.status, 403);
  const evilPost = await fetch(`${base}/api/imports`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
  assert.equal(evilPost.status, 403);
  assert.equal((await evilPost.json()).error.code, 'origin_refused');
  const evilGet = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example' } });
  assert.equal(evilGet.status, 200);
  assert.equal(evilGet.headers.get('access-control-allow-origin'), null);
});

test('rate limiting per IP and per credential, with Retry-After; ops endpoints exempt', async () => {
  const { base } = await boot(loadConfig({ AR_RATE_LIMIT_IP_PER_MIN: '5' }));
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await fetch(`${base}/api/health`)).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  const r = await fetch(`${base}/api/health`);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await r.json()).error.code, 'rate_limited');
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const k = await boot(loadConfig({ AR_RATE_LIMIT_KEY_PER_MIN: '2' }));
  const h = { authorization: 'Bearer some-token' };
  const kc = [];
  for (let i = 0; i < 3; i++) kc.push((await fetch(`${k.base}/api/me`, { headers: h })).status);
  assert.deepEqual(kc, [401, 401, 429]);
  assert.equal((await fetch(`${k.base}/api/me`, { headers: { authorization: 'Bearer another' } })).status, 401, 'a different credential has its own bucket');
});

test('body size limit, handler timeout, error envelope without stack traces, request log without query strings or PHI', async () => {
  const lines: string[] = [];
  // A provider that accepts connections and never answers: sign-in start must time out cleanly.
  const blackhole = createServer(() => { /* never respond */ });
  await new Promise<void>((r) => blackhole.listen(0, '127.0.0.1', r));
  servers.push(blackhole);
  const cfg = loadConfig({ ...PROD, AR_BODY_LIMIT_BYTES: '2048', AR_HANDLER_TIMEOUT_MS: '300', AR_RATE_LIMIT_IP_PER_MIN: '0', AR_RATE_LIMIT_KEY_PER_MIN: '0' });
  cfg.oidc!.issuer = `http://127.0.0.1:${(blackhole.address() as AddressInfo).port}`;
  const { db, base } = await boot(cfg, undefined, lines);
  const big = await fetch(`${base}/api/imports`, { method: 'POST', body: 'x'.repeat(4096), headers: { 'content-type': 'application/json' } });
  assert.equal(big.status, 413);
  const env = await big.json();
  assert.equal(env.error.code, 'too_large');
  assert.ok(env.error.requestId);
  const t0 = Date.now();
  const slow = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
  assert.equal(slow.status, 503);
  assert.equal((await slow.json()).error.code, 'timeout');
  assert.ok(Date.now() - t0 < 3000);
  // Force an internal error: the response is generic and the log has no stack outside synthetic.
  const { token } = createKey(db, { userId: 'u_sam', displayName: 'Sam', tenantId: 'tn_demo', clientId: 'cl_ortho', roles: ['supervisor'] }, { name: 'err probe', roles: ['supervisor'], reason: 'probe the error envelope' });
  run(db, 'ALTER TABLE import_batches RENAME TO import_batches_gone');
  const boom = await fetch(`${base}/api/imports?q=Jane%20Doe%20DOB%201980-02-03`, { headers: { authorization: `Bearer ${token}`, 'x-tenant': 'tn_demo', 'x-client': 'cl_ortho' } });
  assert.equal(boom.status, 500);
  const b = await boom.json();
  assert.deepEqual(Object.keys(b.error).sort(), ['code', 'details', 'message', 'requestId']);
  assert.equal(b.error.message, 'Internal error');
  await new Promise((r) => setTimeout(r, 20));
  const all = lines.join('\n');
  assert.ok(lines.some((l) => JSON.parse(l).event === 'http_unhandled_error'));
  assert.ok(!all.includes('"stack"'), 'no stack traces in production logs');
  assert.ok(!all.includes('Jane') && !all.includes('1980-02-03'), 'query strings never reach the log');
  assert.ok(!all.includes(token), 'API keys never reach the log');
  const req = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'http_request' && l.route === '/api/imports' && l.status === 500);
  assert.match(req.principal, /^svc:key_/);
  assert.equal(req.status, 500);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), 'every log line is JSON');
});

test('log redaction: PHI-shaped fields and values never reach the output', () => {
  const lines: string[] = [];
  const log = createLogger({ sink: (l) => lines.push(l) });
  log.info('probe', {
    patientName: 'Jane Q Public', dob: '1980-02-03', member: { subscriberId: 'W123456789' }, ssn: '123-45-6789',
    headers: { authorization: 'Bearer abc.def.ghi', cookie: '__Host-ar_session=secretcookie' },
    note: 'Called payer about Jane Q Public', email: 'jane@example.test',
    message: 'contact jane@example.test or (555) 123-4567, SSN 123-45-6789, born 02/03/1980, key ark_ABCDEFGHIJKLMNOP, token eyJhbGciOi.eyJzdWIiOiJ4In0.sig',
    nested: [{ transcript: 'my date of birth is 1980-02-03' }], count: 3, route: '/api/accounts/:id',
  });
  const out = lines.join('\n');
  for (const secret of ['Jane', '1980-02-03', 'W123456789', '123-45-6789', 'abc.def.ghi', 'secretcookie', 'jane@example.test', '555', '02/03/1980', 'ABCDEFGHIJKLMNOP', 'eyJzdWIiOiJ4In0']) {
    assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
  }
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.count, 3);
  assert.equal(rec.route, '/api/accounts/:id');
  // Mutation check: without redaction the probe would leak (proves the test can fail).
  assert.ok(JSON.stringify({ note: 'Jane' }).includes('Jane'));
  assert.equal((redact({ note: 'Jane' }) as any).note, '[redacted]');
});

test('/healthz, /readyz (writable DB, migrations, keys, draining) and /metrics behind a token', async () => {
  const cfg = loadConfig(PROD);
  const { db, server, base } = await boot(cfg);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
  const ready = await fetch(`${base}/readyz`);
  const rb = await ready.json();
  assert.equal(ready.status, 200, JSON.stringify(rb));
  assert.deepEqual(rb.checks.map((c: any) => c.id), ['accepting', 'db_writable', 'migrations', 'phi_keys', 'session_secret']);
  // Pending migration -> not ready.
  run(db, "DELETE FROM schema_migrations WHERE name='090_production.sql'");
  const pending = await fetch(`${base}/readyz`);
  assert.equal(pending.status, 503);
  assert.equal((await pending.json()).checks.find((c: any) => c.id === 'migrations').ok, false);
  run(db, "INSERT INTO schema_migrations VALUES ('090_production.sql', 'x')");
  // Draining -> not ready.
  lifecycleOf(server)!.draining = true;
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  lifecycleOf(server)!.draining = false;
  // Metrics.
  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const m = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${PROD.AR_METRICS_TOKEN}` } });
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type')!, /text\/plain; version=0.0.4/);
  const text = await m.text();
  assert.match(text, /# TYPE ar_http_requests_total counter/);
  assert.match(text, /ar_http_requests_total\{method="GET",route="ops:\/readyz",status="503"\} 2/);
  assert.match(text, /ar_http_request_duration_seconds_bucket\{method="GET",route="ops:\/healthz",le="\+Inf"\} 1/);
  assert.match(text, /# TYPE ar_outbox_items gauge/);
  assert.match(text, /ar_backup_last_success_timestamp_seconds 0/);
  const syn = await boot(loadConfig({}));
  assert.equal((await fetch(`${syn.base}/metrics`)).status, 200, 'synthetic without a token: open');
});

test('graceful shutdown in process: draining, in-flight request completes, loops finish their item, database closed', async () => {
  const blackhole = createServer(() => { /* never respond */ });
  await new Promise<void>((r) => blackhole.listen(0, '127.0.0.1', r));
  servers.push(blackhole);
  const cfg = loadConfig({ AR_OIDC_ISSUER: `http://127.0.0.1:${(blackhole.address() as AddressInfo).port}`, AR_OIDC_CLIENT_ID: 'c', AR_OIDC_CLIENT_SECRET: 's',
    AR_OIDC_REDIRECT_URI: 'http://127.0.0.1/cb', AR_HANDLER_TIMEOUT_MS: '400', AR_SHUTDOWN_GRACE_MS: '3000' });
  const { db, server, base } = await boot(cfg);
  let finished = false;
  const loop = createLoop('probe', 10_000, async () => { await new Promise((r) => setTimeout(r, 200)); finished = true; }, createLogger({ sink: () => {} }));
  loop.step();
  let exitCode: number | null = null;
  const shutdown = installShutdown({ server, stops: [() => loop.stop()], db, cfg, logger: createLogger({ sink: () => {} }), exit: (c) => { exitCode = c; } });
  const inflight = fetch(`${base}/api/auth/login`, { redirect: 'manual' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lifecycleOf(server)!.inFlight, 1);
  const done = shutdown('TEST');
  assert.equal(lifecycleOf(server)!.draining, true);
  const r = await inflight;
  assert.equal(r.status, 503, 'the in-flight request still got its answer');
  await done;
  assert.equal(finished, true, 'the worker loop finished its current item');
  assert.equal(exitCode, 0);
  assert.equal(db.isOpen, false);
  servers.splice(servers.indexOf(server), 1);
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

test('outside synthetic, simulators never execute and drafts never run as the baseline (separate process with AR_ENV=production)', async () => {
  const script = `
    const { connectorFor } = await import('./server/connectors/executors.ts');
    const { PHASE0_ENVIRONMENT, draftsMayRun } = await import('./server/services/scenario.ts');
    const { getConfig } = await import('./server/connectors/framework.ts');
    const { openDb } = await import('./server/db/db.ts');
    const { ENVIRONMENT } = await import('./server/http/app.ts');
    const db = openDb(':memory:');
    const scope = { userId: 'u', displayName: 'u', tenantId: 't', clientId: 'c', roles: [] };
    let refused = null;
    try { connectorFor('sim_payer').submit(db, 'k', 'h', {}); } catch (e) { refused = e.constructor.name; }
    console.log(JSON.stringify({ payer: connectorFor('sim_payer').name, pm: connectorFor('sim_pm').name, refused, env: PHASE0_ENVIRONMENT, app: ENVIRONMENT,
      drafts: draftsMayRun(), simEnabled: getConfig(db, scope, 'sim_clearinghouse').enabled }));`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env: { PATH: process.env.PATH ?? '', AR_ENV: 'production' } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  assert.equal(await new Promise((r) => child.on('exit', r)), 0, out);
  assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)!), { payer: 'live_payer', pm: 'live_payer', refused: 'LiveExecutionDisabled', env: 'production', app: 'production', drafts: false, simEnabled: false });
});

function spawnNode(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, exited, output: () => out };
}

test('real processes: production without config exits 78; API and worker shut down cleanly on SIGTERM', async () => {
  const bad = spawnNode('server/main.ts', { AR_ENV: 'production' });
  assert.equal(await bad.exited, 78);
  assert.match(bad.output(), /Refusing to start: \d+ configuration problem/);
  assert.match(bad.output(), /AR_SESSION_SECRET is required/);

  const dir = mkdtempSync(join(tmpdir(), 'ar-proc-'));
  const port = await new Promise<number>((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
  const api = spawnNode('server/main.ts', { PORT: String(port), AR_DB: join(dir, 'ar.db'), AR_WORKER: 'off' });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200; } catch { /* starting */ }
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(up, api.output());
  api.child.kill('SIGTERM');
  assert.equal(await api.exited, 0, api.output());
  const events = api.output().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).event);
  assert.ok(events.includes('startup') && events.includes('shutdown_started') && events.includes('shutdown_complete'), events.join(','));

  const worker = spawnNode('server/worker.ts', { AR_DB: join(dir, 'ar.db'), AR_WORKER_INTERVAL_MS: '200' });
  await new Promise((r) => setTimeout(r, 1500));
  worker.child.kill('SIGTERM');
  assert.equal(await worker.exited, 0, worker.output());
  assert.match(worker.output(), /"event":"worker_started"/);
  assert.match(worker.output(), /"event":"shutdown_complete"/);
});
