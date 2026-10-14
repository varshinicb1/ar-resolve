// Browser sessions for single sign-on (ADR 0090).
//
//   - The cookie holds a 256-bit random value; the database holds only HMAC-SHA256(secret, value),
//     so a database copy alone cannot be replayed as a cookie.
//   - Absolute expiry (AR_SESSION_TTL_HOURS) and idle expiry (AR_SESSION_IDLE_MINUTES) are enforced
//     on every request; activity extends only the idle deadline, never the absolute one.
//   - CSRF: every cookie-authenticated request with an unsafe method needs the header
//     x-csrf-token = HMAC(secret, "csrf:" + cookie value) (synchronizer token, never stored), and an
//     Origin header, when present, must be an allowed origin. Bearer-token requests (API keys) are
//     not cookie-borne and need neither.
//   - IdP identities map to users only through sso_identities, which operators manage
//     (scripts/admin.ts). Sign-in never creates users or grants.
import { createHmac, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { type Db, all, one, run, tx } from '../db/db.ts';
import { AppError, newId, now, nowIso, canonicalJson } from '../util.ts';
import type { Config } from '../config.ts';
import type { Identity } from './auth.ts';
import { randomToken, safeEqual, type IdClaims } from './oidc.ts';

export const LOGIN_STATE_MINUTES = 10;
export const OIDC_COOKIE = 'ar_oidc';
const TOUCH_EVERY_MS = 60_000;

const hmac = (secret: string, v: string) => createHmac('sha256', secret).update(v).digest('hex');
export const subjectHash = (iss: string, sub: string) => createHash('sha256').update(`${iss}\n${sub}`).digest('hex');

export function authEvent(db: Db, e: { type: string; actor: string; userId?: string | null; issuer?: string | null; subject?: string | null; details?: Record<string, unknown> }) {
  run(db, 'INSERT INTO auth_events VALUES (?,?,?,?,?,?,?,?)', newId('aev'), nowIso(), e.type, e.userId ?? null, e.issuer ?? null,
    e.issuer && e.subject ? subjectHash(e.issuer, e.subject) : null, e.actor, canonicalJson(e.details ?? {}));
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, o: { secure: boolean; maxAgeSec: number; path?: string; sameSite?: 'Lax' | 'Strict' }): string {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? '/'}`, 'HttpOnly', `SameSite=${o.sameSite ?? 'Lax'}`, `Max-Age=${o.maxAgeSec}`, ...(o.secure ? ['Secure'] : [])].join('; ');
}

// ---------------------------------------------------------------- login transactions

export function saveLoginState(db: Db, s: { state: string; nonce: string; verifier: string; returnTo: string }) {
  const t = now().getTime();
  tx(db, () => {
    run(db, 'DELETE FROM oidc_login_states WHERE expires_at < ?', nowIso());
    run(db, 'INSERT INTO oidc_login_states VALUES (?,?,?,?,?,?)', createHash('sha256').update(s.state).digest('hex'), s.nonce, s.verifier, s.returnTo,
      nowIso(), new Date(t + LOGIN_STATE_MINUTES * 60_000).toISOString());
  });
}

/** Consumes a login transaction exactly once. The state must also equal the browser's ar_oidc cookie. */
export function takeLoginState(db: Db, state: string, cookieState: string | undefined): { nonce: string; verifier: string; returnTo: string } {
  if (!state || !cookieState || !safeEqual(state, cookieState)) throw new AppError(400, 'login_state_mismatch', 'This sign-in did not start in this browser');
  const key = createHash('sha256').update(state).digest('hex');
  return tx(db, () => {
    const r = one<{ nonce: string; code_verifier: string; return_to: string; expires_at: string }>(db, 'SELECT * FROM oidc_login_states WHERE state_sha256=?', key);
    if (!r) throw new AppError(400, 'login_state_unknown', 'Unknown or already used sign-in');
    run(db, 'DELETE FROM oidc_login_states WHERE state_sha256=?', key);
    if (r.expires_at < nowIso()) throw new AppError(400, 'login_state_expired', 'The sign-in took too long; start again');
    return { nonce: r.nonce, verifier: r.code_verifier, returnTo: r.return_to };
  });
}

/** Only same-site relative paths; anything else becomes "/". */
export function safeReturnTo(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return /^\/(?![/\\])[\w\-./?#=&%~+:]*$/.test(s) && s.length <= 300 ? s : '/';
}

// ---------------------------------------------------------------- identity mapping

interface LinkRow { link_id: string; issuer: string; subject: string | null; email: string | null; user_id: string; disabled_at: string | null }

/** Maps validated ID token claims to an AR Resolve user through the admin-managed table, or refuses. */
export function mapIdentity(db: Db, claims: IdClaims): { userId: string; linkId: string } {
  // Refusals are recorded after the transaction (a throw inside it would roll the event back).
  const out = tx(db, (): { userId: string; linkId: string } | { refused: string; userId?: string } => {
    const bySub = one<LinkRow>(db, 'SELECT * FROM sso_identities WHERE issuer=? AND subject=?', claims.iss, claims.sub);
    if (bySub) return bySub.disabled_at ? { refused: 'account_disabled', userId: bySub.user_id } : { userId: bySub.user_id, linkId: bySub.link_id };
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (email && claims.email_verified === true) {
      const pre = one<LinkRow>(db, 'SELECT * FROM sso_identities WHERE issuer=? AND subject IS NULL AND lower(email)=? AND disabled_at IS NULL', claims.iss, email);
      if (pre) {
        run(db, 'UPDATE sso_identities SET subject=?, bound_at=? WHERE link_id=?', claims.sub, nowIso(), pre.link_id);
        authEvent(db, { type: 'sso_link_bound', actor: 'system:oidc', userId: pre.user_id, issuer: claims.iss, subject: claims.sub, details: { linkId: pre.link_id } });
        return { userId: pre.user_id, linkId: pre.link_id };
      }
    }
    return { refused: 'not_provisioned' };
  });
  if ('refused' in out) {
    authEvent(db, { type: 'sso_refused', actor: 'system:oidc', userId: out.userId ?? null, issuer: claims.iss, subject: claims.sub, details: { reason: out.refused, emailVerified: claims.email_verified === true } });
    return refuse(out.refused);
  }
  return out;
}
function refuse(code: string): never {
  throw new AppError(403, code, code === 'not_provisioned' ? 'Your sign-in worked, but no AR Resolve access has been set up for this identity. Ask your administrator.' : 'This sign-in has been disabled by an administrator.');
}

// ---------------------------------------------------------------- sessions

export function createWebSession(db: Db, cfg: Config, s: { userId: string; issuer: string; subject: string }): { token: string; csrf: string; cookie: string } {
  const token = randomToken(32);
  const t = now().getTime();
  const expires = new Date(t + cfg.session.ttlHours * 3600_000).toISOString();
  const idle = new Date(Math.min(t + cfg.session.idleMinutes * 60_000, t + cfg.session.ttlHours * 3600_000)).toISOString();
  run(db, 'INSERT INTO web_sessions (session_hmac, user_id, issuer, subject, created_at, last_seen_at, idle_expires_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
    hmac(cfg.session.secret, token), s.userId, s.issuer, s.subject, nowIso(), nowIso(), idle, expires);
  return { token, csrf: csrfFor(cfg, token), cookie: cookie(cfg.session.cookieName, token, { secure: cfg.session.secureCookie, maxAgeSec: cfg.session.ttlHours * 3600 }) };
}

export const csrfFor = (cfg: Config, token: string) => hmac(cfg.session.secret, `csrf:${token}`);
export const clearSessionCookie = (cfg: Config) => cookie(cfg.session.cookieName, '', { secure: cfg.session.secureCookie, maxAgeSec: 0 });

interface SessionRow { session_hmac: string; user_id: string; display_name: string; last_seen_at: string; idle_expires_at: string; expires_at: string; revoked_at: string | null }

/** The session behind the request's cookie, or null. Enforces idle and absolute expiry and extends idle. */
export function sessionFromCookie(db: Db, cfg: Config, req: IncomingMessage): { row: SessionRow; token: string } | null {
  const token = parseCookies(req)[cfg.session.cookieName];
  if (!token) return null;
  const row = one<SessionRow>(db, 'SELECT s.*, u.display_name FROM web_sessions s JOIN users u USING (user_id) WHERE s.session_hmac=?', hmac(cfg.session.secret, token));
  if (!row) return null;
  const at = nowIso();
  if (row.revoked_at || row.expires_at <= at || row.idle_expires_at <= at) return null;
  const t = now().getTime();
  if (t - Date.parse(row.last_seen_at) >= TOUCH_EVERY_MS) {
    const idle = new Date(Math.min(t + cfg.session.idleMinutes * 60_000, Date.parse(row.expires_at))).toISOString();
    run(db, 'UPDATE web_sessions SET last_seen_at=?, idle_expires_at=? WHERE session_hmac=? AND revoked_at IS NULL', at, idle, row.session_hmac);
  }
  return { row, token };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Origin check for cookie-borne unsafe requests: an Origin, when sent, must be ours. */
export function originAllowed(cfg: Config, req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client, or a same-origin GET; the CSRF token still applies
  if (cfg.allowedOrigins.includes(origin) || origin === cfg.publicBaseUrl) return true;
  if (cfg.synthetic && !cfg.allowedOrigins.length) {
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }
  return false;
}

/** Identity for a cookie-authenticated request; enforces CSRF on unsafe methods. Throws 401/403. */
export function authenticateCookie(db: Db, cfg: Config, req: IncomingMessage): Identity {
  const s = sessionFromCookie(db, cfg, req);
  if (!s) throw new AppError(401, 'unauthenticated', 'Sign in required');
  if (!SAFE_METHODS.has(req.method ?? 'GET')) {
    const h = req.headers['x-csrf-token'];
    const sent = Array.isArray(h) ? h[0] : h;
    if (!sent || !safeEqual(sent, csrfFor(cfg, s.token))) throw new AppError(403, 'csrf_failed', 'Missing or invalid CSRF token');
    if (!originAllowed(cfg, req)) throw new AppError(403, 'origin_refused', 'Request origin is not allowed');
  }
  return { userId: s.row.user_id, displayName: s.row.display_name };
}

export function revokeSession(db: Db, cfg: Config, token: string, reason: string): string | null {
  const h = hmac(cfg.session.secret, token);
  const r = one<{ user_id: string }>(db, 'SELECT user_id FROM web_sessions WHERE session_hmac=? AND revoked_at IS NULL', h);
  if (!r) return null;
  run(db, 'UPDATE web_sessions SET revoked_at=?, revoke_reason=? WHERE session_hmac=?', nowIso(), reason, h);
  return r.user_id;
}

/** Revokes every open session of a user (admin action, link disabled, offboarding). */
export function revokeUserSessions(db: Db, userId: string, reason: string): number {
  return run(db, 'UPDATE web_sessions SET revoked_at=?, revoke_reason=? WHERE user_id=? AND revoked_at IS NULL', nowIso(), reason, userId);
}

export function purgeExpiredSessions(db: Db): number {
  const cutoff = new Date(now().getTime() - 7 * 86_400_000).toISOString();
  return run(db, 'DELETE FROM web_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', cutoff, cutoff)
    + run(db, 'DELETE FROM oidc_login_states WHERE expires_at < ?', nowIso());
}

export function listLinks(db: Db) {
  return all(db, 'SELECT link_id, issuer, subject, email, user_id, created_by, created_at, bound_at, disabled_at, disabled_by FROM sso_identities ORDER BY created_at');
}
