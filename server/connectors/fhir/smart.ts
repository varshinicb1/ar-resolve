// SMART Backend Services (asymmetric client authentication) for a FHIR R4 read client.
// Source: SMART App Launch v2.2.0 "Backend Services" and "Client Authentication: Asymmetric"
// (hl7.org/fhir/smart-app-launch, read 2026-10-12): JWT header alg (RS384 or ES384), kid,
// typ "JWT"; claims iss = sub = client_id, aud = token URL, exp no more than five minutes in
// the future, jti nonce; token request grant_type=client_credentials,
// client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer,
// client_assertion, scope (system/ scopes, e.g. system/Observation.rs); response
// access_token, token_type bearer, expires_in (SHOULD NOT exceed 300), scope.
//
// ADR 0070 additions ported from clinic-receptionist src/smart.ts (same owner): token endpoint
// discovery from <fhir base>/.well-known/smart-configuration (https token_endpoint required),
// redirect: 'manual' and a timeout on every request, and a refresh margin before expiry.
// RS384 (RSASSA-PKCS1-v1_5 with SHA-384) is accepted alongside ES384, the two algorithms the
// SMART page above names.
import { createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { safePublicHttpsUrl } from '../safe-url.ts';

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const MAX_ASSERTION_SECONDS = 300;

export const SUPPORTED_ALGS = ['ES384', 'RS384'] as const;
export type AssertionAlg = (typeof SUPPORTED_ALGS)[number];
export const REQUEST_TIMEOUT_MS = 8000;

export interface BackendAuthConfig { clientId: string; tokenUrl: string; kid: string; privateKey: KeyObject; scopes: string[]; alg?: AssertionAlg }

/** ES384 signatures are r||s (IEEE P1363) in JWS; RS384 uses PKCS#1 v1.5 padding (node's RSA default). */
const sigOpts = (alg: AssertionAlg, key: KeyObject) => (alg === 'ES384' ? { key, dsaEncoding: 'ieee-p1363' as const } : { key });

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function createAssertion(cfg: BackendAuthConfig, nowSec = Math.floor(Date.now() / 1000)): string {
  const alg = cfg.alg ?? 'ES384';
  const header = { alg, kid: cfg.kid, typ: 'JWT' };
  const claims = { iss: cfg.clientId, sub: cfg.clientId, aud: cfg.tokenUrl, exp: nowSec + MAX_ASSERTION_SECONDS, jti: randomBytes(16).toString('hex') };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = sign('sha384', Buffer.from(input), sigOpts(alg, cfg.privateKey));
  return `${input}.${b64u(sig)}`;
}

export function tokenRequestBody(cfg: BackendAuthConfig, assertion: string): string {
  return new URLSearchParams({ scope: cfg.scopes.join(' '), grant_type: 'client_credentials', client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: assertion }).toString();
}

export interface DecodedAssertion { header: Record<string, unknown>; claims: Record<string, unknown> }

// Verification used by the mock authorization server (and usable by any test double).
export function verifyAssertion(jwt: string, publicKey: KeyObject | string, expect: { clientId: string; tokenUrl: string; kid: string; nowSec?: number; seenJti: Set<string> }): DecodedAssertion {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('malformed assertion');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (header.typ !== 'JWT') throw new Error('typ must be JWT');
  if (!(SUPPORTED_ALGS as readonly string[]).includes(header.alg)) throw new Error('unsupported alg');
  if (header.kid !== expect.kid) throw new Error('unknown kid');
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  const keyAlg = key.asymmetricKeyType === 'rsa' ? 'RS384' : key.asymmetricKeyType === 'ec' ? 'ES384' : null;
  if (header.alg !== keyAlg) throw new Error('alg does not match the registered key');
  if (!verify('sha384', Buffer.from(`${parts[0]}.${parts[1]}`), sigOpts(header.alg, key), Buffer.from(parts[2], 'base64url'))) throw new Error('bad signature');
  const now = expect.nowSec ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== expect.clientId || claims.sub !== expect.clientId) throw new Error('iss/sub must equal client_id');
  if (claims.aud !== expect.tokenUrl) throw new Error('aud must be the token URL');
  if (typeof claims.exp !== 'number' || claims.exp <= now || claims.exp > now + MAX_ASSERTION_SECONDS) throw new Error('exp outside the five-minute window');
  if (typeof claims.jti !== 'string' || !claims.jti) throw new Error('jti required');
  if (expect.seenJti.has(`${claims.iss}:${claims.jti}`)) throw new Error('jti replayed');
  expect.seenJti.add(`${claims.iss}:${claims.jti}`);
  return { header, claims };
}

/** Refresh this long before expiry (the origin used one minute; capped below the token life). */
const REFRESH_MARGIN_MS = 60_000;

/**
 * The token endpoint from the server's SMART configuration document. The endpoint must be a
 * public https URL (loopback only for the local mock) and must not redirect.
 */
export async function discoverTokenUrl(fhirBase: string, opts: { allowLoopback?: boolean } = {}): Promise<string> {
  const base = safePublicHttpsUrl(fhirBase, opts);
  if (!base) throw new Error('FHIR base must be a public https:// URL');
  const r = await fetch(`${base}/.well-known/smart-configuration`, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`SMART configuration not found (HTTP ${r.status})`);
  const j = (await r.json().catch(() => ({}))) as { token_endpoint?: unknown };
  const token = typeof j.token_endpoint === 'string' ? safePublicHttpsUrl(j.token_endpoint, opts) : null;
  if (!token) throw new Error('SMART configuration has no acceptable token_endpoint');
  return token;
}

export class BackendTokenSource {
  private token: { value: string; expiresAt: number; scope: string } | null = null;
  private cfg: BackendAuthConfig;
  constructor(cfg: BackendAuthConfig) { this.cfg = cfg; }
  async get(): Promise<string> {
    if (this.token && this.token.expiresAt - REFRESH_MARGIN_MS > Date.now()) return this.token.value;
    const r = await fetch(this.cfg.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: tokenRequestBody(this.cfg, createAssertion(this.cfg)),
      redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = (await r.json().catch(() => ({}))) as { access_token?: string; token_type?: string; expires_in?: number; scope?: string; error?: string };
    if (!r.ok || !body.access_token) throw new Error(`token request failed (${r.status} ${body.error ?? ''})`);
    if (String(body.token_type).toLowerCase() !== 'bearer') throw new Error('token_type must be bearer');
    this.token = { value: body.access_token, expiresAt: Date.now() + Math.min(300, Number(body.expires_in ?? 300)) * 1000, scope: body.scope ?? '' };
    return this.token.value;
  }
  grantedScope() { return this.token?.scope ?? null; }
}
