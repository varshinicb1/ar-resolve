// Large, malformed and hostile inputs: oversized and chunked bodies, deeply nested JSON,
// malformed JSON and query strings, fuzzed CSV and X12. The server must answer every
// request with a deliberate status (never 5xx, never a reset or a hang) and stay healthy.
import { request } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { call, get, login, pool, post, type Res, type Session } from '../lib/http.ts';
import { removeDir, ROOT, startServer, tempDir } from '../lib/proc.ts';
import { latency, mb, probeSummary, statusCounts } from '../lib/stats.ts';
import { cleanStatuses, cohortInventory, type Scenario } from '../lib/ctx.ts';
import { mutate, nested, nestedObject } from '../lib/fuzz.ts';

/** Streams `bytes` of body without a content-length (chunked), like a client that never says how big it is. */
function chunkedPost(base: string, path: string, s: Session, bytes: number): Promise<Res> {
  const url = new URL(path, base);
  const t0 = performance.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Omit<Res, 'ms'>) => { if (!done) { done = true; resolve({ ...r, ms: performance.now() - t0 }); } };
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'x-tenant': s.tenant, 'x-client': s.client, 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString(); let b: unknown = t; try { b = JSON.parse(t); } catch { /* text */ } finish({ status: res.statusCode ?? 0, body: b, bytes: t.length }); });
    });
    req.setTimeout(60_000, () => req.destroy(new Error('client_timeout')));
    req.on('error', (e) => finish({ status: 0, body: null, error: (e as NodeJS.ErrnoException).code ?? e.message, bytes: 0 }));
    const piece = Buffer.alloc(64 * 1024, 'a');
    let sent = 0;
    const pump = () => {
      while (sent < bytes) {
        sent += piece.length;
        if (!req.write(piece)) { req.once('drain', pump); return; }
      }
      req.end();
    };
    req.write('{"sourceName":"x","csv":"');
    pump();
  });
}

export const hostile: Scenario = {
  name: 'hostile',
  title: 'Large, malformed and fuzzed inputs',
  async run(ctx) {
    const dir = tempDir('hostile');
    const srv = await startServer({ dbPath: `${dir}/ar.db`, dir, worker: true });
    const t0 = Date.now();
    try {
      const ana = await login(srv.base, 'u_ana');
      const sam = await login(srv.base, 'u_sam');
      const rui = await login(srv.base, 'u_rui');
      await post(ana, '/api/imports', { sourceName: 'cohort.csv', csv: cohortInventory('cl_ortho') });
      const acct = (await get(ana, '/api/accounts?q=SYN-1042')).body.items[0].accountId as string;
      const inv = await post(ana, `/api/accounts/${acct}/investigate`);
      const actionId = inv.body.actionId as string | null;
      const all: { label: string; r: Res }[] = [];
      const rec = (label: string, r: Res) => { all.push({ label, r }); return r; };

      // 1. Oversized bodies, declared and chunked.
      for (const size of [1_500_000, 10_000_000, 100_000_000]) {
        const raw = Buffer.alloc(size, 0x61);
        const r = rec(`oversized declared ${mb(size)} MB`, await call(srv.base, 'POST', '/api/imports/preview', { token: ana.token, tenant: ana.tenant, client: ana.client, raw, timeoutMs: 60_000 }));
        ctx.metric(`oversized.declared.${mb(size)}MB`, { status: r.status, error: r.error ?? null, ms: Math.round(r.ms) });
      }
      for (const size of [5_000_000, 50_000_000]) {
        const r = rec(`oversized chunked ${mb(size)} MB`, await chunkedPost(srv.base, '/api/imports/preview', ana, size));
        ctx.metric(`oversized.chunked.${mb(size)}MB`, { status: r.status, error: r.error ?? null, ms: Math.round(r.ms) });
      }
      const oversized = all.filter((x) => x.label.startsWith('oversized'));
      ctx.check('oversized bodies get a clean 413 (no reset)', oversized.every((x) => x.r.status === 413), oversized.map((x) => `${x.label}: ${x.r.status || x.r.error}`).join('; '));

      // 2. Deeply nested JSON (all under the 1 MB limit) to routes that hash, store or walk the body.
      const targets: [string, Session, string][] = [
        ['correct fact', ana, `/api/accounts/${acct}/facts/metBeforeCents/correct`],
        ['correct extended fact', ana, `/api/accounts/${acct}/facts/planDesign/correct`],
        ['import preview', ana, '/api/imports/preview'],
        ['kb explain', ana, '/api/kb/explain'],
        ['review', rui, `/api/actions/${actionId ?? 'act_missing'}/review`],
        ['edi preview', sam, '/api/integrations/edi/preview'],
        ['remittance', sam, '/api/remittance'],
        ['start call', ana, `/api/accounts/${acct}/calls`],
        ['policy', sam, '/api/calls/policy'],
        ['commitment', ana, `/api/accounts/${acct}/commitments`],
        ['writeback', ana, `/api/accounts/${acct}/writebacks`],
        ['rule draft', sam, '/api/rule-studio/packs/DED01/drafts'],
      ];
      for (const depth of [1000, 100_000, 400_000]) {
        for (const [label, s, path] of targets) {
          for (const [shape, body] of [['array', nested(depth)], ['object', nestedObject(Math.min(depth, 150_000))]] as const) {
            rec(`nested ${shape} ${depth} -> ${label}`, await call(srv.base, 'POST', path, { token: s.token, tenant: s.tenant, client: s.client, raw: body, timeoutMs: 30_000 }));
          }
        }
      }
      const nest = all.filter((x) => x.label.startsWith('nested'));
      ctx.metric('nestedJson', { requests: nest.length, statuses: statusCounts(nest.map((x) => x.r)), slowestMs: Math.round(Math.max(...nest.map((x) => x.r.ms))) });
      ctx.check('deeply nested JSON never causes a 5xx', cleanStatuses(statusCounts(nest.map((x) => x.r))),
        nest.filter((x) => x.r.status >= 500 || !x.r.status).map((x) => x.label).slice(0, 8).join('; '));

      // 3. Malformed JSON, odd bodies, hostile query strings and path parameters.
      const bad: [string, string][] = [['truncated', '{"csv":'], ['bare brace', '{'], ['missing value', '{"a":}'], ['null', 'null'], ['array', '[]'], ['string', '"x"'],
        ['huge exponent', '{"csv":1e999999}'], ['proto', '{"__proto__":{"admin":true},"csv":"x"}'], ['bom', '﻿{"csv":"x"}'], ['nul bytes', '{"csv":"\u0000\u0000"}'],
        ['lone surrogate', '{"csv":"\\ud800"}'], ['number body', '12345678901234567890123']];
      for (const [label, raw] of bad) {
        rec(`malformed ${label}`, await call(srv.base, 'POST', '/api/imports/preview', { token: ana.token, tenant: ana.tenant, client: ana.client, raw }));
        rec(`malformed ${label} -> correct`, await call(srv.base, 'POST', `/api/accounts/${acct}/facts/metBeforeCents/correct`, { token: ana.token, tenant: ana.tenant, client: ana.client, raw }));
      }
      rec('invalid utf8', await call(srv.base, 'POST', '/api/imports/preview', { token: ana.token, tenant: ana.tenant, client: ana.client, raw: Buffer.from([0x7b, 0x22, 0x63, 0x73, 0x76, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0xc3, 0x28, 0x22, 0x7d]) }));
      const queries = ['/api/accounts?pageSize=-1', '/api/accounts?pageSize=abc', '/api/accounts?page=-5', '/api/accounts?page=1e308', '/api/accounts?pageSize=100000000',
        '/api/accounts?view=../../etc', `/api/accounts?q=${'%25'.repeat(3000)}`, `/api/accounts?q=${'A'.repeat(20000)}`, '/api/accounts/%E0%A4%A', '/api/accounts/%',
        `/api/accounts/${'x'.repeat(5000)}`, '/api/accounts/%00', '/api/kb/search?q=%ZZ', '/api/calls/%C0%AF', '/api/rule-studio/packs/%E0%A4%A/versions/1'];
      for (const qs of queries) rec(`query ${qs.slice(0, 50)}`, await get(ana, qs, 30_000));
      const neg = await get(ana, '/api/accounts?pageSize=-1');
      ctx.check('negative pageSize is clamped (no unbounded page)', neg.status === 200 && neg.body.items.length <= 100 && neg.body.pageSize >= 1, `pageSize ${neg.body?.pageSize}`);
      const mal = all.filter((x) => x.label.startsWith('malformed') || x.label.startsWith('query') || x.label === 'invalid utf8');
      ctx.metric('malformed', { requests: mal.length, statuses: statusCounts(mal.map((x) => x.r)) });
      ctx.check('malformed bodies, queries and paths never cause a 5xx', cleanStatuses(statusCounts(mal.map((x) => x.r))),
        mal.filter((x) => x.r.status >= 500 || !x.r.status).map((x) => `${x.label}: ${x.r.status || x.r.error}`).slice(0, 8).join('; '));

      // 4. Fuzzed CSV imports (preview), plus pathological shapes.
      const csv = cohortInventory('cl_ortho');
      const n = ctx.mode === 'quick' ? 150 : 1000;
      const csvRes = await pool(Array.from({ length: n }, (_, i) => i), 8, async (i) => {
        const body = mutate(csv, 1000 + i);
        return rec(`csv fuzz ${i}`, await post(ana, '/api/imports/preview', { sourceName: `fuzz-${i}.csv`, csv: body.slice(0, 900_000) }, 30_000));
      });
      const header = csv.split('\n')[0];
      const shapes: [string, string][] = [
        ['one 890 KB line', header + '\n' + 'SYN-1,'.repeat(148_000)],
        ['200k blank lines', header + '\n'.repeat(200_000)],
        ['50k columns', header + ',x'.repeat(50_000) + '\n' + 'a,'.repeat(50_000)],
        ['quoted commas', header + '\n"SYN-9,1",demo-payer,PRV,PT-1,2026-01-01,"SYN-C,9",professional,1,deductible\n'],
        ['80k tiny rows', header + '\n' + Array.from({ length: 80_000 }, () => 'x').join('\n')],
      ];
      for (const [label, body] of shapes) {
        const r = rec(`csv shape ${label}`, await post(ana, '/api/imports/preview', { sourceName: 'shape.csv', csv: body }, 60_000));
        ctx.metric(`csvShape.${label}`, { bytes: body.length, status: r.status, ms: Math.round(r.ms) });
      }
      const csvAll = all.filter((x) => x.label.startsWith('csv'));
      ctx.metric('csvFuzz', { requests: csvAll.length, statuses: statusCounts(csvAll.map((x) => x.r)), latencyMs: latency(csvRes.map((r) => r.ms)) });
      ctx.check('fuzzed and pathological CSV never causes a 5xx', cleanStatuses(statusCounts(csvAll.map((x) => x.r))),
        csvAll.filter((x) => x.r.status >= 500 || !x.r.status).map((x) => x.label).slice(0, 8).join('; '));

      // 5. Fuzzed X12 (every checked-in fixture), preview and, when valid, ingest.
      const fixtures = readdirSync(`${ROOT}fixtures/x12`).filter((f) => f.endsWith('.edi')).map((f) => readFileSync(`${ROOT}fixtures/x12/${f}`, 'utf8'));
      const per = ctx.mode === 'quick' ? 40 : 250;
      const ediCases = fixtures.flatMap((text, fi) => Array.from({ length: per }, (_, i) => ({ text, seed: fi * 10_000 + i })));
      let ingested = 0;
      const ediRes = await pool(ediCases, 8, async ({ text, seed }) => {
        const content = mutate(text, seed).slice(0, 890_000);
        const pv = rec(`x12 fuzz ${seed}`, await post(sam, '/api/integrations/edi/preview', { filename: `fuzz-${seed}.edi`, content }, 30_000));
        if (pv.status === 200 && pv.body?.valid && ingested < 60) {
          ingested++;
          rec(`x12 fuzz ingest ${seed}`, await post(sam, '/api/integrations/edi/ingest', { filename: `fuzz-${seed}.edi`, content, expectedSha256: pv.body.rawSha256 }, 30_000));
        }
        return pv;
      });
      const x12All = all.filter((x) => x.label.startsWith('x12'));
      ctx.metric('x12Fuzz', { previews: ediRes.length, validAfterMutation: ediRes.filter((r) => r.body?.valid).length, ingests: ingested,
        statuses: statusCounts(x12All.map((x) => x.r)), latencyMs: latency(ediRes.map((r) => r.ms)) });
      ctx.check('fuzzed X12 never causes a 5xx', cleanStatuses(statusCounts(x12All.map((x) => x.r))),
        x12All.filter((x) => x.r.status >= 500 || !x.r.status).map((x) => `${x.label}: ${JSON.stringify(x.r.body).slice(0, 80)}`).slice(0, 5).join('; '));

      // 6. Still healthy, and nothing hung.
      const health = await call(srv.base, 'GET', '/api/health', { timeoutMs: 5000 });
      ctx.check('server alive and answering health in < 1 s after the barrage', srv.alive() && health.status === 200 && health.ms < 1000, `${Math.round(health.ms)} ms`);
      const slowest = all.reduce((m, x) => (x.r.ms > m.r.ms ? x : m), all[0]);
      ctx.metric('totals', { requests: all.length, statuses: statusCounts(all.map((x) => x.r)), slowest: { label: slowest.label, ms: Math.round(slowest.r.ms) },
        serverStackTraces: (srv.output().match(/\[api\]/g) ?? []).length, server: probeSummary(srv.samples(), t0) });
      ctx.check('no unhandled server errors logged', !(srv.output().match(/\[api\]/g) ?? []).length, srv.output().split('\n').filter((l) => l.includes('[api]') || l.includes('Error')).slice(0, 3).join(' | '));
    } finally {
      await srv.stop();
      removeDir(dir);
    }
  },
};
