// Measurement helpers. Every number the harness reports comes from here, computed
// from samples it actually took; nothing is extrapolated.
import type { ProbeSample } from './proc.ts';
import type { Res } from './http.ts';

export function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export interface Latency { n: number; p50: number; p95: number; p99: number; max: number; mean: number }

export function latency(ms: number[]): Latency {
  const s = [...ms].sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(pct(s, 50)), p95: r(pct(s, 95)), p99: r(pct(s, 99)), max: r(s[s.length - 1] ?? NaN), mean: r(s.reduce((a, b) => a + b, 0) / (s.length || 1)) };
}

export function statusCounts(rs: Res[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rs) { const k = r.status ? String(r.status) : `err:${r.error}`; out[k] = (out[k] ?? 0) + 1; }
  return out;
}

export const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;

export function probeSummary(samples: ProbeSample[], from = 0, to = Infinity) {
  const s = samples.filter((x) => x.t >= from && x.t <= to);
  if (!s.length) return null;
  const rss = s.map((x) => x.rss);
  return {
    samples: s.length,
    rssStartMb: mb(rss[0]), rssEndMb: mb(rss[rss.length - 1]), rssPeakMb: mb(Math.max(...rss)),
    heapEndMb: mb(s[s.length - 1].heapUsed),
    eventLoopP99MaxMs: Math.round(Math.max(...s.map((x) => x.elP99)) * 10) / 10,
    eventLoopMaxMs: Math.round(Math.max(...s.map((x) => x.elMax)) * 10) / 10,
  };
}

/** Least-squares slope of heapUsed over time, in MB per minute. */
export function heapSlopeMbPerMin(samples: ProbeSample[]): number {
  if (samples.length < 3) return NaN;
  const t0 = samples[0].t;
  const xs = samples.map((s) => (s.t - t0) / 60000);
  const ys = samples.map((s) => s.heapUsed / 1048576);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0; let den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return Math.round((num / den) * 100) / 100;
}
