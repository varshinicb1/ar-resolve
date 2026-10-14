// Local mock OpenID Provider for tests (ADR 0090). Signs real RS256 / ES256 JWTs with test keys
// generated per run, serves discovery + JWKS, and implements the token endpoint including the PKCE
// S256 check and client_secret_basic authentication, so the relying party is exercised end to end.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export interface MockIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  close: () => Promise<void>;
  /** Register what the token endpoint returns for a code. */
  issueCode: (code: string, o: { challenge: string; claims: Record<string, unknown>; signWith?: 'good' | 'rogue'; alg?: 'RS256' | 'ES256' | 'none' | 'HS256'; kid?: string }) => void;
  tokenRequests: { auth: string | null; body: URLSearchParams }[];
  rotate: () => void;
  kid: string;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function signJwt(claims: Record<string, unknown>, key: KeyObject | null, alg: string, kid: string): string {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(claims);
  const input = `${head}.${body}`;
  if (alg === 'none' || !key) return `${input}.`;
  if (alg === 'HS256') return `${input}.${createHash('sha256').update(input).digest('base64url')}`;
  const sig = alg === 'ES256' ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }) : sign('sha256', Buffer.from(input), key);
  return `${input}.${sig.toString('base64url')}`;
}

export async function startMockIdp(o: { clientId?: string; clientSecret?: string; endSession?: boolean } = {}): Promise<MockIdp> {
  const clientId = o.clientId ?? 'ar-resolve-test';
  const clientSecret = o.clientSecret ?? 'test secret/with+chars';
  let rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let kid = 'k1';
  const codes = new Map<string, Parameters<MockIdp['issueCode']>[1]>();
  const tokenRequests: MockIdp['tokenRequests'] = [];
  let issuer = '';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer || 'http://x');
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') return json(200, {
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256', 'ES256'],
      code_challenge_methods_supported: ['S256'], ...(o.endSession !== false ? { end_session_endpoint: `${issuer}/logout` } : {}),
    });
    if (url.pathname === '/jwks') return json(200, { keys: [
      { ...rsa.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
      { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec1', use: 'sig', alg: 'ES256' },
    ] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        const auth = req.headers.authorization ?? null;
        tokenRequests.push({ auth, body });
        const expected = 'Basic ' + Buffer.from(`${encodeURIComponent(clientId).replace(/%20/g, '+')}:${encodeURIComponent(clientSecret).replace(/%20/g, '+')}`).toString('base64');
        if (auth !== expected) return json(401, { error: 'invalid_client' });
        if (body.get('grant_type') !== 'authorization_code') return json(400, { error: 'unsupported_grant_type' });
        const c = codes.get(body.get('code') ?? '');
        if (!c) return json(400, { error: 'invalid_grant' });
        codes.delete(body.get('code')!);
        const verifier = body.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier, 'ascii').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        const alg = c.alg ?? 'RS256';
        const key = alg === 'ES256' ? ec.privateKey : c.signWith === 'rogue' ? rogue.privateKey : rsa.privateKey;
        const id_token = signJwt(c.claims, alg === 'none' ? null : key, alg, c.kid ?? (alg === 'ES256' ? 'ec1' : kid));
        return json(200, { access_token: 'opaque-test-access', token_type: 'Bearer', expires_in: 300, id_token });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer, clientId, clientSecret, tokenRequests,
    get kid() { return kid; },
    issueCode: (code, c) => { codes.set(code, c); },
    rotate: () => { rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }); kid = `k${Date.now()}`; },
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}
