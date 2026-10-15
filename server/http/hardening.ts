// HTTP hardening (ADR 0090): security headers, CORS allowlist, client IP, rate limiting, request
// ids and Prometheus-format metrics. Used by app.ts; all policy comes from server/config.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from '../config.ts';

// Content Security Policy for the built UI (web/dist): one module script and one stylesheet from
// 'self', no inline script, no eval. React style props are applied through the CSSOM, which
// style-src does not restrict. Blob URLs are used for JSON downloads (Account, Insights).
export function cspFor(cfg: Config): string {
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:", "font-src 'self'",
    "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ...(cfg.synthetic ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function securityHeaders(cfg: Config, res: ServerResponse, requestId: string): void {
  res.setHeader('x-request-id', requestId);
  res.setHeader('content-security-policy', cspFor(cfg));
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (cfg.http.hsts) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
export function requestIdFor(req: IncomingMessage): string {
  const h = req.headers['x-request-id'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && REQUEST_ID.test(v) ? v : randomUUID();
}

/** The client address: the socket peer, or the entry the trusted proxy appended to X-Forwarded-For. */
export function clientIp(req: IncomingMessage, hops: number): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (hops <= 0) return peer;
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length >= hops ? xff[xff.length - hops] : peer;
}

export const CORS_HEADERS = 'authorization, content-type, x-tenant, x-client, x-csrf-token, x-request-id';

/** CORS decision. Returns 'preflight-ok', 'refused' or 'continue' and sets the response headers. */
export function cors(cfg: Config, req: IncomingMessage, res: ServerResponse): 'preflight-ok' | 'refused' | 'continue' {
  const origin = req.headers.origin;
  const enforce = !cfg.synthetic || cfg.allowedOrigins.length > 0;
  if (!origin || !enforce) return 'continue'; // synthetic without an allowlist: today's behaviour
  const sameHost = (() => { try { return new URL(origin).host === req.headers.host && cfg.publicBaseUrl === null; } catch { return false; } })();
  const allowed = cfg.allowedOrigins.includes(origin) || origin === cfg.publicBaseUrl || sameHost;
  res.setHeader('vary', 'Origin');
  if (allowed) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-expose-headers', 'x-request-id, retry-after');
  }
  if (req.method === 'OPTIONS') {
    if (!allowed) return 'refused';
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT');
    res.setHeader('access-control-allow-headers', CORS_HEADERS);
    res.setHeader('access-control-max-age', '600');
    return 'preflight-ok';
  }
  // A cross-origin state change from an origin we do not know is refused outright.
  if (!allowed && req.method !== 'GET' && req.method !== 'HEAD') return 'refused';
  return 'continue';
}

/** Token-bucket limiter, one bucket per key; in-process (one node in the pilot; see ADR 0090). */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  perMinute: number;
  private now: () => number;
  constructor(perMinute: number, now: () => number = Date.now) { this.perMinute = perMinute; this.now = now; }
  /** Returns 0 when allowed, else the seconds until a token is available. */
  take(key: string): number {
    if (this.perMinute <= 0) return 0;
    const t = this.now();
    const rate = this.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + (t - b.at) * rate);
    b.at = t;
    if (this.buckets.size > 50_000) this.prune(t);
    if (b.tokens >= 1) { b.tokens -= 1; this.buckets.set(key, b); return 0; }
    this.buckets.set(key, b);
    return Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
  }
  private prune(t: number) { for (const [k, b] of this.buckets) if (t - b.at > 120_000) this.buckets.delete(k); }
}

/** Bucket key for a credential, never the credential itself. */
export function credentialKey(req: IncomingMessage, cookieName: string): string | null {
  const auth = String(req.headers.authorization ?? '');
  if (auth.startsWith('Bearer ')) return 'tok:' + createHash('sha256').update(auth.slice(7)).digest('hex').slice(0, 24);
  const m = String(req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${cookieName.replace(/[$]/g, '\\$')}=([^;]+)`));
  return m ? 'ses:' + createHash('sha256').update(m[1]).digest('hex').slice(0, 24) : null;
}

// ---------------------------------------------------------------- metrics

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labels = (l: Record<string, string>) => { const e = Object.entries(l); return e.length ? `{${e.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : ''; };

export class Metrics {
  private counters = new Map<string, { help: string; values: Map<string, number> }>();
  private hist = new Map<string, { counts: number[]; sum: number; count: number }>();
  readonly startedAt = Date.now();

  inc(name: string, help: string, l: Record<string, string> = {}, by = 1) {
    if (!this.counters.has(name)) this.counters.set(name, { help, values: new Map() });
    const c = this.counters.get(name)!;
    const k = labels(l);
    c.values.set(k, (c.values.get(k) ?? 0) + by);
  }

  observeRequest(l: { method: string; route: string; status: string }, seconds: number) {
    this.inc('ar_http_requests_total', 'HTTP requests by method, matched route pattern and status', l);
    const k = labels({ method: l.method, route: l.route });
    const h = this.hist.get(k) ?? { counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => { if (seconds <= b) h.counts[i]++; });
    h.sum += seconds;
    h.count++;
    this.hist.set(k, h);
  }

  counter(name: string, l: Record<string, string> = {}): number { return this.counters.get(name)?.values.get(labels(l)) ?? 0; }

  render(gauges: { name: string; help: string; values: { labels?: Record<string, string>; value: number }[] }[] = []): string {
    const out: string[] = [];
    for (const [name, c] of this.counters) {
      out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
      for (const [k, v] of c.values) out.push(`${name}${k} ${v}`);
    }
    out.push('# HELP ar_http_request_duration_seconds HTTP request duration', '# TYPE ar_http_request_duration_seconds histogram');
    for (const [k, h] of this.hist) {
      const inner = k.slice(1, -1);
      BUCKETS.forEach((b, i) => out.push(`ar_http_request_duration_seconds_bucket{${inner},le="${b}"} ${h.counts[i]}`));
      out.push(`ar_http_request_duration_seconds_bucket{${inner},le="+Inf"} ${h.count}`, `ar_http_request_duration_seconds_sum${k} ${h.sum}`, `ar_http_request_duration_seconds_count${k} ${h.count}`);
    }
    const mem = process.memoryUsage();
    gauges = [...gauges,
      { name: 'ar_process_resident_memory_bytes', help: 'Resident set size', values: [{ value: mem.rss }] },
      { name: 'ar_process_heap_used_bytes', help: 'V8 heap used', values: [{ value: mem.heapUsed }] },
      { name: 'ar_process_uptime_seconds', help: 'Seconds since this process started', values: [{ value: Math.round((Date.now() - this.startedAt) / 1000) }] }];
    for (const g of gauges) {
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      for (const v of g.values) out.push(`${g.name}${labels(v.labels ?? {})} ${v.value}`);
    }
    return out.join('\n') + '\n';
  }
}
