// Single sign-on routes (ADR 0090): OpenID Connect authorization code + PKCE, cookie sessions,
// CSRF token, logout. The protocol lives in services/oidc.ts, sessions in services/web-sessions.ts.
//
//   GET  /api/auth/config    what the sign-in page should offer (SSO and/or development identities)
//   GET  /api/auth/login     starts sign-in: stores state/nonce/verifier, sets the ar_oidc cookie, 302 to the IdP
//   GET  /api/auth/callback  completes sign-in: state must match the cookie, code exchanged, ID token
//                            validated, identity mapped through sso_identities, session cookie set, 302 back
//   GET  /api/auth/session   the signed-in user and the CSRF token for cookie-authenticated mutations
//   POST /api/auth/logout    ends the session (CSRF required); returns the IdP end-session URL if any
import type { ModuleApi } from '../app.ts';
import { HttpResponse } from '../app.ts';
import { AppError } from '../../util.ts';
import { OidcClient, OidcError, pkcePair, randomToken } from '../../services/oidc.ts';
import { authEvent, authenticateCookie, clearSessionCookie, cookie, createWebSession, csrfFor, mapIdentity, OIDC_COOKIE, parseCookies, revokeSession,
  safeReturnTo, saveLoginState, sessionFromCookie, takeLoginState, LOGIN_STATE_MINUTES } from '../../services/web-sessions.ts';
import { errorFields } from '../../log.ts';

const clients = new WeakMap<object, OidcClient>();

export function register({ db, route, config: cfg, logger }: ModuleApi): void {
  const oidc = (): OidcClient => {
    if (!cfg.oidc) throw new AppError(404, 'sso_not_configured', 'Single sign-on is not configured in this deployment');
    let c = clients.get(cfg);
    if (!c) { c = new OidcClient(cfg.oidc); clients.set(cfg, c); }
    return c;
  };
  const oidcCookie = (value: string, maxAge: number) => cookie(OIDC_COOKIE, value, { secure: cfg.session.secureCookie, maxAgeSec: maxAge, path: '/api/auth' });
  const loginError = (code: string) => `/?login_error=${encodeURIComponent(code)}`;

  route('GET', '/api/auth/config', () => ({ sso: !!cfg.oidc, devLogin: cfg.devLogin, environment: cfg.env, loginUrl: cfg.oidc ? '/api/auth/login' : null }));

  route('GET', '/api/auth/login', async (ctx) => {
    const client = oidc();
    const state = randomToken(32);
    const nonce = randomToken(32);
    const { verifier, challenge } = pkcePair();
    const returnTo = safeReturnTo(ctx.query.get('returnTo'));
    let location: string;
    try { location = await client.authorizationUrl({ state, nonce, challenge }); } catch (e) {
      logger.error('sso_provider_unavailable', errorFields(e, cfg.synthetic));
      throw new AppError(503, 'sso_unavailable', 'The identity provider could not be reached. Try again shortly.');
    }
    saveLoginState(db, { state, nonce, verifier, returnTo });
    return new HttpResponse(302, { location, 'set-cookie': oidcCookie(state, LOGIN_STATE_MINUTES * 60) });
  });

  route('GET', '/api/auth/callback', async (ctx) => {
    const client = oidc();
    const clear = oidcCookie('', 0);
    const idpError = ctx.query.get('error');
    if (idpError) {
      authEvent(db, { type: 'sso_failed', actor: 'system:oidc', issuer: cfg.oidc!.issuer, details: { reason: 'idp_error', error: idpError.slice(0, 60) } });
      return new HttpResponse(302, { location: loginError('idp_error'), 'set-cookie': clear });
    }
    let txState;
    try { txState = takeLoginState(db, ctx.query.get('state') ?? '', parseCookies(ctx.req)[OIDC_COOKIE]); } catch (e) {
      authEvent(db, { type: 'sso_failed', actor: 'system:oidc', issuer: cfg.oidc!.issuer, details: { reason: (e as AppError).code } });
      return new HttpResponse(302, { location: loginError((e as AppError).code), 'set-cookie': clear });
    }
    const code = ctx.query.get('code') ?? '';
    if (!code) return new HttpResponse(302, { location: loginError('no_code'), 'set-cookie': clear });
    let claims;
    try { claims = await client.exchange(code, txState.verifier, txState.nonce); } catch (e) {
      const reason = e instanceof OidcError ? e.code : 'exchange_failed';
      authEvent(db, { type: 'sso_failed', actor: 'system:oidc', issuer: cfg.oidc!.issuer, details: { reason } });
      logger.warn('sso_failed', { reason, ...errorFields(e, cfg.synthetic && !(e instanceof OidcError)) });
      return new HttpResponse(302, { location: loginError(reason), 'set-cookie': clear });
    }
    let user;
    try { user = mapIdentity(db, claims); } catch (e) {
      return new HttpResponse(302, { location: loginError((e as AppError).code ?? 'refused'), 'set-cookie': clear });
    }
    const s = createWebSession(db, cfg, { userId: user.userId, issuer: claims.iss, subject: claims.sub });
    authEvent(db, { type: 'sso_login', actor: user.userId, userId: user.userId, issuer: claims.iss, subject: claims.sub, details: { linkId: user.linkId } });
    return new HttpResponse(302, { location: txState.returnTo, 'set-cookie': [clear, s.cookie] });
  });

  route('GET', '/api/auth/session', (ctx) => {
    const s = sessionFromCookie(db, cfg, ctx.req);
    if (!s) throw new AppError(401, 'unauthenticated', 'Sign in required');
    return { userId: s.row.user_id, displayName: s.row.display_name, csrfToken: csrfFor(cfg, s.token), expiresAt: s.row.expires_at, idleExpiresAt: s.row.idle_expires_at };
  });

  route('POST', '/api/auth/logout', async (ctx) => {
    const id = authenticateCookie(db, cfg, ctx.req); // enforces CSRF + origin
    const token = parseCookies(ctx.req)[cfg.session.cookieName];
    revokeSession(db, cfg, token, 'logout');
    authEvent(db, { type: 'logout', actor: id.userId, userId: id.userId });
    const endSessionUrl = cfg.oidc ? await oidc().endSessionUrl() : null;
    return new HttpResponse(200, { 'set-cookie': clearSessionCookie(cfg) }, { ok: true, endSessionUrl });
  });
}
