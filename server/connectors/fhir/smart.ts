// SMART Backend Services (asymmetric client authentication) for a FHIR R4 read client.
// Source: SMART App Launch v2.2.0 "Backend Services" and "Client Authentication: Asymmetric"
// (hl7.org/fhir/smart-app-launch, read 2026-10-12): JWT header alg (RS384 or ES384), kid,
// typ "JWT"; claims iss = sub = client_id, aud = token URL, exp no more than five minutes in
// the future, jti nonce; token request grant_type=client_credentials,
// client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer,
// client_assertion, scope (system/ scopes, e.g. system/Observation.rs); response
// access_token, token_type bearer, expires_in (SHOULD NOT exceed 300), scope.
import { createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const MAX_ASSERTION_SECONDS = 300;

export interface BackendAuthConfig { clientId: string; tokenUrl: string; kid: string; privateKey: KeyObject; scopes: string[] }

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function createAssertion(cfg: BackendAuthConfig, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = { alg: 'ES384', kid: cfg.kid, typ: 'JWT' };
  const claims = { iss: cfg.clientId, sub: cfg.clientId, aud: cfg.tokenUrl, exp: nowSec + MAX_ASSERTION_SECONDS, jti: randomBytes(16).toString('hex') };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = sign('sha384', Buffer.from(input), { key: cfg.privateKey, dsaEncoding: 'ieee-p1363' });
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
  if (header.alg !== 'ES384') throw new Error('unsupported alg');
  if (header.kid !== expect.kid) throw new Error('unknown kid');
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  if (!verify('sha384', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'))) throw new Error('bad signature');
  const now = expect.nowSec ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== expect.clientId || claims.sub !== expect.clientId) throw new Error('iss/sub must equal client_id');
  if (claims.aud !== expect.tokenUrl) throw new Error('aud must be the token URL');
  if (typeof claims.exp !== 'number' || claims.exp <= now || claims.exp > now + MAX_ASSERTION_SECONDS) throw new Error('exp outside the five-minute window');
  if (typeof claims.jti !== 'string' || !claims.jti) throw new Error('jti required');
  if (expect.seenJti.has(`${claims.iss}:${claims.jti}`)) throw new Error('jti replayed');
  expect.seenJti.add(`${claims.iss}:${claims.jti}`);
  return { header, claims };
}

export class BackendTokenSource {
  private token: { value: string; expiresAt: number; scope: string } | null = null;
  private cfg: BackendAuthConfig;
  constructor(cfg: BackendAuthConfig) { this.cfg = cfg; }
  async get(): Promise<string> {
    if (this.token && this.token.expiresAt - 30_000 > Date.now()) return this.token.value;
    const r = await fetch(this.cfg.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: tokenRequestBody(this.cfg, createAssertion(this.cfg)) });
    const body = (await r.json().catch(() => ({}))) as { access_token?: string; token_type?: string; expires_in?: number; scope?: string; error?: string };
    if (!r.ok || !body.access_token) throw new Error(`token request failed (${r.status} ${body.error ?? ''})`);
    if (String(body.token_type).toLowerCase() !== 'bearer') throw new Error('token_type must be bearer');
    this.token = { value: body.access_token, expiresAt: Date.now() + Math.min(300, Number(body.expires_in ?? 300)) * 1000, scope: body.scope ?? '' };
    return this.token.value;
  }
  grantedScope() { return this.token?.scope ?? null; }
}
