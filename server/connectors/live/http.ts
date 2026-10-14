// HTTP client for live connectors (ADR 0100): fetch with a hard timeout, no redirects followed,
// a response size cap, and retries with exponential backoff ONLY for requests the caller marks
// idempotent reads. Writes are never retried here: payer writes go through approval and the outbox,
// which owns retry and read-back.
//
// Retried statuses: 429 and 503 (the request was not processed), plus network errors raised before
// any response. 5xx other than 503 and 504 timeouts are NOT retried: Stedi documents that payers may
// still be working on a request (up to 120 s) and that cancelling and retrying early can create
// duplicate payer requests (https://www.stedi.com/docs/healthcare/send-eligibility-checks, 2026-10-14).
// Retry-After (seconds) is honoured up to the remaining time budget.

export interface HttpRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** True only for reads that are safe to repeat. */
  idempotentRead: boolean;
  timeoutMs: number;
  maxAttempts?: number;
}

export interface HttpResponse { status: number; headers: Record<string, string>; text: string; json: unknown; attempts: number; latencyMs: number }

export class HttpFailure extends Error {
  readonly kind: 'timeout' | 'network' | 'too_large';
  readonly attempts: number;
  constructor(kind: 'timeout' | 'network' | 'too_large', message: string, attempts: number) { super(message); this.kind = kind; this.attempts = attempts; }
}

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const RETRY_STATUSES = new Set([429, 503]);

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init);
/** Tests may observe outbound requests; production code never calls this. */
export function setFetchForTests(f: FetchLike | null) { fetchImpl = f ?? ((url, init) => fetch(url, init)); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());

export function backoffMs(attempt: number, retryAfter: string | undefined, base = 250): number {
  const ra = retryAfter && /^\d{1,4}$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : null;
  return ra ?? Math.min(8_000, base * 2 ** (attempt - 1));
}

export async function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  const started = Date.now();
  const maxAttempts = req.idempotentRead ? Math.max(1, Math.min(4, req.maxAttempts ?? 3)) : 1;
  let attempt = 0;
  for (;;) {
    attempt++;
    const left = req.timeoutMs - (Date.now() - started);
    if (left <= 0) throw new HttpFailure('timeout', `No answer within ${req.timeoutMs} ms`, attempt - 1);
    let res: Response;
    try {
      res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(left) });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new HttpFailure('timeout', `No answer within ${req.timeoutMs} ms`, attempt);
      if (attempt < maxAttempts) { await sleep(Math.min(backoffMs(attempt, undefined), Math.max(0, req.timeoutMs - (Date.now() - started) - 50))); continue; }
      throw new HttpFailure('network', `Network error: ${(err as Error).message.slice(0, 200)}`, attempt);
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const len = Number(headers['content-length'] ?? 0);
    if (len > MAX_RESPONSE_BYTES) throw new HttpFailure('too_large', `Response of ${len} bytes exceeds ${MAX_RESPONSE_BYTES}`, attempt);
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new HttpFailure('too_large', `Response exceeds ${MAX_RESPONSE_BYTES} bytes`, attempt);
    if (RETRY_STATUSES.has(res.status) && attempt < maxAttempts) {
      const wait = backoffMs(attempt, headers['retry-after']);
      if (Date.now() - started + wait < req.timeoutMs - 50) { await sleep(wait); continue; }
    }
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, headers, text, json, attempts: attempt, latencyMs: Date.now() - started };
  }
}

/** Short, credential-free description of an HTTP error body for connector events. */
export function errorSummary(r: HttpResponse): string {
  const j = r.json as Record<string, unknown> | null;
  const msg = j && typeof j === 'object' ? (j.message ?? j.Message ?? j.error_description ?? j.error ?? (j.errors as unknown[] | undefined)?.[0]) : null;
  const s = typeof msg === 'string' ? msg : msg ? JSON.stringify(msg) : r.text.slice(0, 120);
  return `HTTP ${r.status}${s ? `: ${String(s).slice(0, 200)}` : ''}`;
}

// ---------------------------------------------------------------- OAuth 2.0 client-credentials token cache

interface Cached { token: string; expiresAt: number }
const tokens = new Map<string, Cached>();
export function clearTokenCache() { tokens.clear(); }

/** Fetches (or reuses) a bearer token. The cache key includes the client id, never the secret. */
export async function clientCredentialsToken(o: {
  cacheKey: string; tokenUrl: string; form?: Record<string, string>; json?: Record<string, string>; timeoutMs: number; marginMs?: number;
}): Promise<string> {
  const hit = tokens.get(o.cacheKey);
  const margin = o.marginMs ?? 60_000;
  if (hit && hit.expiresAt - margin > Date.now()) return hit.token;
  const body = o.form ? new URLSearchParams(o.form).toString() : JSON.stringify(o.json ?? {});
  const r = await httpRequest({ method: 'POST', url: o.tokenUrl, headers: { 'content-type': o.form ? 'application/x-www-form-urlencoded' : 'application/json', accept: 'application/json' },
    body, idempotentRead: false, timeoutMs: o.timeoutMs });
  const j = r.json as { access_token?: unknown; expires_in?: unknown } | null;
  if (r.status !== 200 || !j || typeof j.access_token !== 'string' || !j.access_token) throw new Error(`Token request refused: HTTP ${r.status}`);
  const ttl = typeof j.expires_in === 'number' ? j.expires_in : Number(j.expires_in);
  const expiresAt = Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 300_000);
  tokens.set(o.cacheKey, { token: j.access_token, expiresAt });
  return j.access_token;
}
