// OpenID Connect relying party: authorization-code flow with PKCE (ADR 0090).
//
// Protocol sources (retrieved 2026-10-14):
//   - OpenID Connect Core 1.0, https://openid.net/specs/openid-connect-core-1_0.html
//       3.1.2.1 authentication request (scope must contain openid; response_type=code; client_id;
//       redirect_uri exactly as registered; state recommended; nonce with sufficient entropy);
//       3.1.3.3 token response (token_type Bearer, id_token present);
//       3.1.3.7 ID Token validation (iss exact match, aud contains client_id, azp, alg, signature
//       with the issuer's keys, exp, iat, nonce).
//   - OpenID Connect Discovery 1.0, https://openid.net/specs/openid-connect-discovery-1_0.html
//       issuer + "/.well-known/openid-configuration"; the returned issuer MUST be identical to the
//       issuer used; token_endpoint_auth_methods_supported defaults to client_secret_basic.
//   - RFC 7636 (PKCE), https://www.rfc-editor.org/rfc/rfc7636
//       4.1 verifier 43-128 unreserved characters; 4.2 S256 = BASE64URL(SHA256(ASCII(verifier)));
//       4.3 code_challenge + code_challenge_method; 4.5 code_verifier in the token request.
//   - OpenID Connect RP-Initiated Logout 1.0, https://openid.net/specs/openid-connect-rpinitiated-1_0.html
//       end_session_endpoint; client_id and post_logout_redirect_uri (pre-registered) are allowed
//       without id_token_hint.
//   - Microsoft identity platform, https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
//       and .../v2-protocols-oidc: authorize/token endpoints per tenant, code_challenge_method
//       "SHOULD be S256", code_verifier in the token request, client_secret in the body or HTTP
//       Basic, end_session_endpoint with post_logout_redirect_uri.
//
// Deliberate restrictions (documented in ADR 0090): single issuer per deployment (no multi-tenant
// "common" Entra issuer); ID tokens with more than one audience are refused; only asymmetric
// signature algorithms from AR_OIDC_ALLOWED_ALGS; "none" and HMAC algorithms are never accepted.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, constants, type KeyObject } from 'node:crypto';
import type { OidcConfig } from '../config.ts';

export class OidcError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'OidcError'; }
}

export interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  code_challenge_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

interface Jwk { kty: string; kid?: string; use?: string; alg?: string; [k: string]: unknown }

const b64url = (b: Buffer) => b.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48)); // 64 chars of [A-Za-z0-9-_], within RFC 7636 4.1
  return { verifier, challenge: b64url(createHash('sha256').update(verifier, 'ascii').digest()) };
}

export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type FetchFn = typeof fetch;

async function getJson(f: FetchFn, url: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try { r = await f(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: 'error' }); } catch (e) { throw new OidcError('provider_unreachable', `Could not reach ${new URL(url).host}: ${(e as Error).message}`); }
  const text = await r.text();
  let body: any;
  try { body = JSON.parse(text); } catch { throw new OidcError('provider_bad_response', `Non-JSON response from ${new URL(url).host} (${r.status})`); }
  if (!r.ok) throw new OidcError('provider_error', `Provider returned ${r.status}${body?.error ? `: ${String(body.error).slice(0, 80)}` : ''}`);
  return body;
}

/** The provider client: discovery and JWKS are cached; an unknown kid refreshes the JWKS at most once a minute. */
export class OidcClient {
  cfg: OidcConfig;
  private f: FetchFn;
  private meta: { at: number; value: ProviderMetadata } | null = null;
  private jwks: { at: number; keys: Jwk[] } | null = null;
  private lastForced = 0;
  private now: () => number;
  constructor(cfg: OidcConfig, opts: { fetch?: FetchFn; now?: () => number } = {}) {
    this.cfg = cfg;
    this.f = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async metadata(): Promise<ProviderMetadata> {
    if (this.meta && this.now() - this.meta.at < 3600_000) return this.meta.value;
    const url = this.cfg.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
    const m = await getJson(this.f, url);
    if (m.issuer !== this.cfg.issuer) throw new OidcError('issuer_mismatch', 'Discovery issuer does not exactly match AR_OIDC_ISSUER');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (typeof m[k] !== 'string') throw new OidcError('provider_bad_response', `Discovery document lacks ${k}`);
    if (Array.isArray(m.code_challenge_methods_supported) && !m.code_challenge_methods_supported.includes('S256')) throw new OidcError('pkce_unsupported', 'Provider does not advertise PKCE S256');
    this.meta = { at: this.now(), value: m };
    return m;
  }

  private async keys(force: boolean): Promise<Jwk[]> {
    if (this.jwks && !force && this.now() - this.jwks.at < 3600_000) return this.jwks.keys;
    if (this.jwks && force) {
      // A token naming an unknown kid may refresh the JWKS, at most once a minute (bounds the work
      // an attacker can cause by presenting made-up key ids).
      if (this.now() - this.lastForced < 60_000) return this.jwks.keys;
      this.lastForced = this.now();
    }
    const m = await this.metadata();
    const body = await getJson(this.f, m.jwks_uri);
    if (!Array.isArray(body?.keys)) throw new OidcError('provider_bad_response', 'JWKS has no keys');
    this.jwks = { at: this.now(), keys: body.keys };
    return body.keys;
  }

  async authorizationUrl(p: { state: string; nonce: string; challenge: string }): Promise<string> {
    const m = await this.metadata();
    const u = new URL(m.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', this.cfg.redirectUri);
    u.searchParams.set('scope', this.cfg.scopes);
    u.searchParams.set('state', p.state);
    u.searchParams.set('nonce', p.nonce);
    u.searchParams.set('code_challenge', p.challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  /** Exchanges the code and returns the validated ID token claims. The access token is discarded. */
  async exchange(code: string, verifier: string, nonce: string): Promise<IdClaims> {
    const m = await this.metadata();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri, code_verifier: verifier });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.cfg.tokenAuth === 'client_secret_basic') {
      // RFC 6749 2.3.1: client id and secret are form-urlencoded before Basic encoding.
      const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
      headers.authorization = 'Basic ' + Buffer.from(`${enc(this.cfg.clientId)}:${enc(this.cfg.clientSecret)}`).toString('base64');
    } else {
      form.set('client_id', this.cfg.clientId);
      form.set('client_secret', this.cfg.clientSecret);
    }
    const tok = await getJson(this.f, m.token_endpoint, { method: 'POST', headers, body: form.toString() });
    if (typeof tok.id_token !== 'string') throw new OidcError('no_id_token', 'Token response has no id_token');
    if (String(tok.token_type ?? '').toLowerCase() !== 'bearer') throw new OidcError('bad_token_type', 'Token response token_type is not Bearer');
    return this.verifyIdToken(tok.id_token, nonce);
  }

  async verifyIdToken(jwt: string, nonce: string): Promise<IdClaims> {
    const { header } = decodeJwt(jwt);
    let keys = await this.keys(false);
    if (header.kid && !keys.some((k) => k.kid === header.kid)) keys = await this.keys(true); // provider key rotation
    return verifyIdToken(jwt, { issuer: this.cfg.issuer, clientId: this.cfg.clientId, nonce, allowedAlgs: this.cfg.allowedAlgs, keys, nowSec: Math.floor(this.now() / 1000), skewSec: this.cfg.clockSkewSec });
  }

  async endSessionUrl(): Promise<string | null> {
    let m: ProviderMetadata;
    try { m = await this.metadata(); } catch { return null; }
    if (!m.end_session_endpoint) return null;
    const u = new URL(m.end_session_endpoint);
    u.searchParams.set('client_id', this.cfg.clientId);
    if (this.cfg.postLogoutRedirectUri) u.searchParams.set('post_logout_redirect_uri', this.cfg.postLogoutRedirectUri);
    return u.toString();
  }
}

export interface IdClaims { iss: string; sub: string; aud: string | string[]; exp: number; iat: number; nonce?: string; email?: string; email_verified?: boolean; name?: string; [k: string]: unknown }

export function decodeJwt(jwt: string): { header: { alg?: string; kid?: string; typ?: string; crit?: unknown }; payload: any; signingInput: string; signature: Buffer } {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new OidcError('bad_id_token', 'ID token is not a compact JWS');
  try {
    return { header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')), payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
      signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') };
  } catch { throw new OidcError('bad_id_token', 'ID token is not valid base64url JSON'); }
}

const HASH: Record<string, string> = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512', PS256: 'sha256', ES256: 'sha256', ES384: 'sha384' };

/** OIDC Core 3.1.3.7 validation, steps 2-3, 5, 7-11 (no encryption, no acr/auth_time requests). */
export function verifyIdToken(jwt: string, o: { issuer: string; clientId: string; nonce: string; allowedAlgs: string[]; keys: Jwk[]; nowSec: number; skewSec: number }): IdClaims {
  const { header, payload, signingInput, signature } = decodeJwt(jwt);
  const alg = String(header.alg ?? '');
  if (!alg || alg === 'none' || !o.allowedAlgs.includes(alg) || !HASH[alg]) throw new OidcError('bad_alg', `ID token algorithm ${alg || '(none)'} is not allowed`);
  if (header.crit !== undefined) throw new OidcError('bad_id_token', 'ID token uses unsupported critical header parameters');
  const kty = alg.startsWith('ES') ? 'EC' : 'RSA';
  const candidates = o.keys.filter((k) => k.kty === kty && (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === alg) && (header.kid ? k.kid === header.kid : true));
  if (candidates.length !== 1) throw new OidcError('unknown_key', header.kid ? 'ID token key id is not in the provider JWKS' : 'ID token has no key id and the JWKS is ambiguous');
  let key: KeyObject;
  try { key = createPublicKey({ key: candidates[0] as any, format: 'jwk' }); } catch { throw new OidcError('unknown_key', 'Provider JWK could not be imported'); }
  const data = Buffer.from(signingInput);
  const ok = alg.startsWith('PS')
    ? cryptoVerify(HASH[alg], data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, signature)
    : alg.startsWith('ES') ? cryptoVerify(HASH[alg], data, { key, dsaEncoding: 'ieee-p1363' }, signature)
    : cryptoVerify(HASH[alg], data, key, signature);
  if (!ok) throw new OidcError('bad_signature', 'ID token signature is invalid');

  const c = payload as IdClaims;
  if (c.iss !== o.issuer) throw new OidcError('bad_issuer', 'ID token issuer does not match');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(o.clientId)) throw new OidcError('bad_audience', 'ID token audience does not contain this client');
  if (aud.length !== 1) throw new OidcError('bad_audience', 'ID tokens with several audiences are refused');
  if (c.azp !== undefined && c.azp !== o.clientId) throw new OidcError('bad_audience', 'ID token azp is not this client');
  if (typeof c.exp !== 'number' || o.nowSec >= c.exp + o.skewSec) throw new OidcError('expired', 'ID token has expired');
  if (typeof c.iat !== 'number' || c.iat > o.nowSec + o.skewSec || c.iat < o.nowSec - 600 - o.skewSec) throw new OidcError('bad_iat', 'ID token issue time is outside the accepted window');
  if (c.nbf !== undefined && (typeof c.nbf !== 'number' || c.nbf > o.nowSec + o.skewSec)) throw new OidcError('not_yet_valid', 'ID token is not yet valid');
  if (typeof c.nonce !== 'string' || !safeEqual(c.nonce, o.nonce)) throw new OidcError('bad_nonce', 'ID token nonce does not match this sign-in');
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw new OidcError('bad_subject', 'ID token has no usable subject');
  return c;
}
