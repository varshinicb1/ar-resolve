// Minimal HTTP client over node:http with keep-alive, per-request timing and no
// exceptions: a transport failure comes back as status 0 with the error code.
import { Agent, request } from 'node:http';
import { performance } from 'node:perf_hooks';

export interface Res { status: number; body: any; ms: number; error?: string; bytes: number }

// Idle sockets are dropped after 4 s, before the server's 5 s keep-alive timeout closes them, so the
// harness does not write into a socket the server is closing (which surfaces as ECONNRESET).
const agent = new Agent({ keepAlive: true, maxSockets: 256, timeout: 4000 });

export interface ReqOpts { token?: string; tenant?: string; client?: string; body?: unknown; raw?: string | Buffer; headers?: Record<string, string>; timeoutMs?: number }

// A GET on a reused keep-alive socket can hit the server's idle close (keepAliveTimeout) at the same
// instant and see ECONNRESET before any byte was sent; Node's documented remedy is to retry once.
// Only GETs are retried, so a write is never sent twice by the harness.
export async function call(base: string, method: string, path: string, o: ReqOpts = {}): Promise<Res> {
  let r = await callOnce(base, method, path, o);
  // Retry a GET on a reused socket that reset before any response, after yielding so the agent can
  // process pending close events (a synchronous step in the harness can delay them past the timeout).
  for (let i = 0; i < 3 && method === 'GET' && r.status === 0 && r.error === 'ECONNRESET' && r.reused; i++) {
    await new Promise((res) => setImmediate(res));
    r = await callOnce(base, method, path, o);
  }
  return r;
}

function callOnce(base: string, method: string, path: string, o: ReqOpts): Promise<Res & { reused?: boolean }> {
  const url = new URL(path, base);
  const payload = o.raw !== undefined ? o.raw : o.body !== undefined ? JSON.stringify(o.body) : undefined;
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.tenant) headers['x-tenant'] = o.tenant;
  if (o.client) headers['x-client'] = o.client;
  if (payload !== undefined) {
    headers['content-type'] ??= 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  const t0 = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: Omit<Res, 'ms'> & { reused?: boolean }) => { if (settled) return; settled = true; resolve({ ...r, ms: performance.now() - t0 }); };
    const req = request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        finish({ status: res.statusCode ?? 0, body, bytes: text.length });
      });
      res.on('error', (e) => finish({ status: 0, body: null, error: (e as NodeJS.ErrnoException).code ?? e.message, bytes: 0 }));
    });
    req.setTimeout(o.timeoutMs ?? 120_000, () => { req.destroy(new Error('client_timeout')); });
    req.on('error', (e) => finish({ status: 0, body: null, error: (e as NodeJS.ErrnoException).code ?? e.message, bytes: 0, reused: req.reusedSocket }));
    if (payload !== undefined) req.end(payload); else req.end();
  });
}

export interface Session { userId: string; token: string; tenant: string; client: string; base: string }

export async function login(base: string, userId: string, tenant = 'tn_demo', client = 'cl_ortho'): Promise<Session> {
  const r = await call(base, 'POST', '/api/dev/login', { body: { userId } });
  if (r.status !== 200) throw new Error(`login ${userId}: ${r.status} ${JSON.stringify(r.body)}`);
  return { userId, token: r.body.token, tenant, client, base };
}

export const as = (s: Session, client = s.client, tenant = s.tenant): Session => ({ ...s, client, tenant });

export function get(s: Session, path: string, timeoutMs?: number) {
  return call(s.base, 'GET', path, { token: s.token, tenant: s.tenant, client: s.client, timeoutMs });
}

export function post(s: Session, path: string, body: unknown = {}, timeoutMs?: number) {
  return call(s.base, 'POST', path, { token: s.token, tenant: s.tenant, client: s.client, body, timeoutMs });
}

/** Runs fn over items with at most `concurrency` in flight. */
export async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Runs fn repeatedly from `concurrency` loops until the deadline. */
export async function loopUntil(deadline: number, concurrency: number, fn: (worker: number, iter: number) => Promise<void>) {
  await Promise.all(Array.from({ length: concurrency }, async (_, w) => {
    for (let i = 0; Date.now() < deadline; i++) await fn(w, i);
  }));
}
