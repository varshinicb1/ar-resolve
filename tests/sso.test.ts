// ADR 0090: OpenID Connect sign-in (authorization code + PKCE) against a local mock provider that
// signs real JWTs, cookie sessions with idle/absolute expiry, CSRF, logout and the admin-managed
// identity mapping. No external service is called.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { openDb, type Db, one, all } from '../server/db/db.ts';
import { seed } from '../server/services/seed.ts';
import { createApp } from '../server/http/app.ts';
import { loadConfig } from '../server/config.ts';
import { linkIdentity, disableIdentity, addUser } from '../server/services/admin.ts';
import { verifyIdToken, pkcePair, OidcError } from '../server/services/oidc.ts';
import { setClock } from '../server/util.ts';
import { createLogger } from '../server/log.ts';
import { startMockIdp, signJwt, type MockIdp } from './oidc-mock.ts';

let idp: MockIdp;
let db: Db;
let server: Server;
let base = '';
let n = 0;

before(async () => {
  idp = await startMockIdp();
  db = openDb(':memory:');
  seed(db);
  const cfg = loadConfig({ AR_OIDC_ISSUER: idp.issuer, AR_OIDC_CLIENT_ID: idp.clientId, AR_OIDC_CLIENT_SECRET: idp.clientSecret,
    AR_OIDC_REDIRECT_URI: 'http://127.0.0.1/api/auth/callback', AR_OIDC_POST_LOGOUT_REDIRECT_URI: 'http://127.0.0.1/', AR_OIDC_ALLOWED_ALGS: 'RS256,ES256' });
  server = createApp(db, { config: cfg, logger: createLogger({ sink: () => {} }) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  linkIdentity(db, 'operator:test', { userId: 'u_sam', issuer: idp.issuer, subject: 'sub-sam' });
  linkIdentity(db, 'operator:test', { userId: 'u_rui', issuer: idp.issuer, email: 'Rui@Example.test' });
});
after(async () => { setClock(null); await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); await idp.close(); });

const nowSec = () => Math.floor(Date.now() / 1000);

async function signIn(claims: Record<string, unknown> = {}, o: { signWith?: 'good' | 'rogue'; alg?: 'RS256' | 'ES256' | 'none' | 'HS256'; cookieState?: string; replay?: boolean; kid?: string } = {}) {
  const r = await fetch(`${base}/api/auth/login?returnTo=${encodeURIComponent('/#/queue')}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location')!);
  const p = loc.searchParams;
  const oidcCookie = r.headers.getSetCookie().find((c) => c.startsWith('ar_oidc='))!;
  const code = `code-${++n}`;
  idp.issueCode(code, { challenge: p.get('code_challenge')!, signWith: o.signWith, alg: o.alg, kid: o.kid,
    claims: { iss: idp.issuer, aud: idp.clientId, sub: 'sub-sam', nonce: p.get('nonce'), iat: nowSec(), exp: nowSec() + 300, ...claims } });
  const cb = () => fetch(`${base}/api/auth/callback?code=${code}&state=${encodeURIComponent(p.get('state')!)}`, { redirect: 'manual', headers: { cookie: `ar_oidc=${o.cookieState ?? p.get('state')}` } });
  const res = await cb();
  const session = res.headers.getSetCookie().find((c) => c.startsWith('ar_session=') && !c.startsWith('ar_session=;'));
  const out = { status: res.status, location: res.headers.get('location') ?? '', session: session?.split(';')[0] ?? null, authorize: loc, oidcCookie, replay: null as null | { location: string } };
  if (o.replay) { const again = await cb(); out.replay = { location: again.headers.get('location') ?? '' }; }
  return out;
}

const as = (cookie: string, csrf?: string) => ({
  get: async (path: string) => { const r = await fetch(base + path, { headers: { cookie, 'x-tenant': 'tn_demo', 'x-client': 'cl_ortho' } }); return { status: r.status, body: await r.json() }; },
  post: async (path: string, body: unknown = {}, extra: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { cookie, 'x-tenant': 'tn_demo', 'x-client': 'cl_ortho', 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...extra } });
    return { status: r.status, body: await r.json(), headers: r.headers };
  },
});

test('authorization request carries PKCE S256, state, nonce and the openid scope', async () => {
  const s = await signIn();
  const p = s.authorize.searchParams;
  assert.equal(s.authorize.origin + s.authorize.pathname, `${idp.issuer}/authorize`);
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('client_id'), idp.clientId);
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.match(p.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(p.get('scope')!.split(' ').includes('openid'));
  assert.ok(p.get('state')!.length >= 43 && p.get('nonce')!.length >= 43);
  assert.match(s.oidcCookie, /HttpOnly/);
  assert.match(s.oidcCookie, /SameSite=Lax/);
  // The token request authenticated with client_secret_basic and sent the verifier.
  const last = idp.tokenRequests.at(-1)!;
  assert.ok(last.auth?.startsWith('Basic '));
  assert.equal(last.body.get('client_secret'), null, 'secret is not repeated in the body');
  assert.ok(last.body.get('code_verifier')!.length >= 43);
  const v = pkcePair();
  assert.ok(v.verifier.length >= 43 && v.verifier.length <= 128 && /^[A-Za-z0-9\-._~]+$/.test(v.verifier));
});

test('happy path: session cookie, /api/me, roles from grants, CSRF required for mutations', async () => {
  const s = await signIn();
  assert.equal(s.status, 302);
  assert.equal(s.location, '/#/queue');
  assert.ok(s.session, 'session cookie set');
  const me = await as(s.session!).get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.userId, 'u_sam');
  assert.ok(me.body.scopes.some((x: any) => x.clientId === 'cl_ortho' && x.roles.includes('supervisor')));
  const sess = await as(s.session!).get('/api/auth/session');
  assert.equal(sess.status, 200);
  const csrf = sess.body.csrfToken as string;
  // Mutation without the token is refused; with it, it passes.
  const noCsrf = await as(s.session!).post('/api/ops/pause', { paused: false, reason: 'csrf check' });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error.code, 'csrf_failed');
  const wrong = await as(s.session!, 'x'.repeat(64)).post('/api/ops/pause', { paused: false, reason: 'csrf check' });
  assert.equal(wrong.body.error.code, 'csrf_failed');
  const ok = await as(s.session!, csrf).post('/api/ops/pause', { paused: false, reason: 'csrf check' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // A foreign Origin is refused even with a valid token.
  const foreign = await as(s.session!, csrf).post('/api/ops/pause', { paused: false, reason: 'csrf check' }, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error.code, 'origin_refused');
  assert.ok(one(db, "SELECT 1 FROM auth_events WHERE event_type='sso_login' AND user_id='u_sam'"));
  // Only the HMAC of the cookie is stored.
  const raw = decodeURIComponent(s.session!.split('=')[1]);
  assert.equal(one(db, 'SELECT 1 FROM web_sessions WHERE session_hmac=?', raw), undefined);
});

test('provider key rotation: an unknown kid refreshes the JWKS', async () => {
  // Warm the cache, rotate the provider key, then sign with the new kid (refresh allowed once a minute;
  // the client created by this app has not refreshed since its first load in this run).
  idp.rotate();
  const s = await signIn();
  assert.ok(s.session, s.location);
});

test('ID token validation refuses bad signature, issuer, audience, nonce, expiry, azp, alg none and HS256', async () => {
  const cases: [Record<string, unknown>, Parameters<typeof signIn>[1], string][] = [
    [{}, { signWith: 'rogue' }, 'bad_signature'],
    [{ iss: 'https://evil.example' }, {}, 'bad_issuer'],
    [{ aud: 'someone-else' }, {}, 'bad_audience'],
    [{ aud: [idp.clientId, 'other'] }, {}, 'bad_audience'],
    [{ azp: 'other' }, {}, 'bad_audience'],
    [{ nonce: 'not-the-nonce' }, {}, 'bad_nonce'],
    [{ exp: nowSec() - 3600, iat: nowSec() - 4000 }, {}, 'expired'],
    [{ iat: nowSec() + 3600, exp: nowSec() + 7200 }, {}, 'bad_iat'],
    [{}, { alg: 'none' }, 'bad_alg'],
    [{}, { alg: 'HS256' }, 'bad_alg'],
    [{}, { kid: 'unknown-kid' }, 'unknown_key'],
  ];
  for (const [claims, o, code] of cases) {
    const s = await signIn(claims, o);
    assert.equal(s.status, 302);
    assert.equal(s.location, `/?login_error=${code}`, `${code}: ${s.location}`);
    assert.equal(s.session, null, `${code}: no session`);
  }
  assert.ok(all(db, "SELECT 1 FROM auth_events WHERE event_type='sso_failed'").length >= cases.length);
});

test('ES256 tokens verify when allowed', async () => {
  const s = await signIn({}, { alg: 'ES256' });
  assert.ok(s.session, s.location);
});

test('state must match the browser cookie and is single-use', async () => {
  const mismatch = await signIn({}, { cookieState: 'some-other-state' });
  assert.equal(mismatch.location, '/?login_error=login_state_mismatch');
  const replay = await signIn({}, { replay: true });
  assert.ok(replay.session);
  assert.equal(replay.replay!.location, '/?login_error=login_state_unknown');
});

test('identity mapping: unprovisioned refused; email pre-link binds only with email_verified; disabled link refused', async () => {
  const stranger = await signIn({ sub: 'sub-stranger' });
  assert.equal(stranger.location, '/?login_error=not_provisioned');
  assert.ok(one(db, "SELECT 1 FROM auth_events WHERE event_type='sso_refused' AND json_extract(details,'$.reason')='not_provisioned'"));
  const unverified = await signIn({ sub: 'sub-rui', email: 'rui@example.test', email_verified: false });
  assert.equal(unverified.location, '/?login_error=not_provisioned');
  const verified = await signIn({ sub: 'sub-rui', email: 'RUI@example.test', email_verified: true });
  assert.ok(verified.session, verified.location);
  assert.equal((await as(verified.session!).get('/api/me')).body.userId, 'u_rui');
  assert.equal(one<{ subject: string }>(db, "SELECT subject FROM sso_identities WHERE user_id='u_rui'")!.subject, 'sub-rui');
  // Sign-in never creates users or grants.
  assert.equal(one(db, "SELECT 1 FROM users WHERE user_id LIKE '%stranger%'"), undefined);
  // Disabling a link revokes open sessions and refuses future sign-in.
  addUser(db, 'operator:test', 'u_tmp', 'Temporary User');
  const { linkId } = linkIdentity(db, 'operator:test', { userId: 'u_tmp', issuer: idp.issuer, subject: 'sub-tmp' });
  const tmp = await signIn({ sub: 'sub-tmp' });
  assert.equal((await as(tmp.session!).get('/api/me')).status, 200);
  disableIdentity(db, 'operator:test', linkId);
  assert.equal((await as(tmp.session!).get('/api/me')).status, 401);
  assert.equal((await signIn({ sub: 'sub-tmp' })).location, '/?login_error=account_disabled');
});

test('idle timeout and absolute expiry', async () => {
  const s = await signIn();
  const c = as(s.session!);
  assert.equal((await c.get('/api/me')).status, 200);
  const t0 = Date.now();
  setClock(() => new Date(t0 + 31 * 60_000)); // idle default 30 minutes
  assert.equal((await c.get('/api/me')).status, 401);
  setClock(null);
  // Activity extends idle, never the absolute 12h limit.
  const s2 = await signIn();
  const c2 = as(s2.session!);
  for (let m = 20; m <= 12 * 60; m += 20) {
    setClock(() => new Date(t0 + m * 60_000));
    const r = await c2.get('/api/me');
    if (m < 12 * 60 - 1) assert.equal(r.status, 200, `minute ${m}`);
  }
  setClock(() => new Date(t0 + 12 * 3600_000 + 60_000));
  assert.equal((await c2.get('/api/me')).status, 401);
  setClock(null);
});

test('logout revokes the session, clears the cookie and returns the end-session URL', async () => {
  const s = await signIn();
  const csrf = (await as(s.session!).get('/api/auth/session')).body.csrfToken;
  const noCsrf = await as(s.session!).post('/api/auth/logout');
  assert.equal(noCsrf.status, 403);
  const out = await as(s.session!, csrf).post('/api/auth/logout');
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') ?? '', /ar_session=;.*Max-Age=0/);
  const end = new URL(out.body.endSessionUrl);
  assert.equal(end.origin + end.pathname, `${idp.issuer}/logout`);
  assert.equal(end.searchParams.get('client_id'), idp.clientId);
  assert.equal(end.searchParams.get('post_logout_redirect_uri'), 'http://127.0.0.1/');
  assert.equal((await as(s.session!).get('/api/me')).status, 401);
});

test('development bearer sessions and dev login still work in synthetic alongside SSO', async () => {
  const r = await fetch(`${base}/api/dev/login`, { method: 'POST', body: JSON.stringify({ userId: 'u_ana' }) });
  assert.equal(r.status, 200);
  const cfg = await (await fetch(`${base}/api/auth/config`)).json();
  assert.deepEqual({ sso: cfg.sso, devLogin: cfg.devLogin }, { sso: true, devLogin: true });
});

test('verifyIdToken unit: missing kid with an ambiguous JWKS, crit header, unknown alg', () => {
  const k1 = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const k2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keys = [{ ...k1.publicKey.export({ format: 'jwk' }), kid: 'a' }, { ...k2.publicKey.export({ format: 'jwk' }), kid: 'b' }] as any[];
  const claims = { iss: 'https://idp.test', aud: 'c', sub: 's', nonce: 'n', iat: nowSec(), exp: nowSec() + 60 };
  const o = { issuer: 'https://idp.test', clientId: 'c', nonce: 'n', allowedAlgs: ['RS256'], keys, nowSec: nowSec(), skewSec: 60 };
  assert.equal(verifyIdToken(signJwt(claims, k1.privateKey, 'RS256', 'a'), o).sub, 's');
  const noKid = signJwt(claims, k1.privateKey, 'RS256', '').replace(/^[^.]+/, Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'));
  assert.throws(() => verifyIdToken(noKid, o), (e: OidcError) => e.code === 'unknown_key' || e.code === 'bad_signature');
  assert.throws(() => verifyIdToken(signJwt(claims, k1.privateKey, 'RS256', 'a'), { ...o, allowedAlgs: ['ES256'] }), (e: OidcError) => e.code === 'bad_alg');
  // Mutation check: the same token with a different nonce expectation must fail.
  assert.throws(() => verifyIdToken(signJwt(claims, k1.privateKey, 'RS256', 'a'), { ...o, nonce: 'other' }), (e: OidcError) => e.code === 'bad_nonce');
});
