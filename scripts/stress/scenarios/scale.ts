// Bulk import at 1k / 10k / 50k synthetic accounts, then queue/list/search/detail latency
// with concurrent readers, a large 835 against the imported claims, and the supervisor page.
import { performance } from 'node:perf_hooks';
import { as, call, get, login, pool, post, type Res } from '../lib/http.ts';
import { dbBytes, removeDir, startServer, tempDir } from '../lib/proc.ts';
import { latency, mb, probeSummary, statusCounts } from '../lib/stats.ts';
import { cleanStatuses, type Ctx, type Scenario } from '../lib/ctx.ts';
import { chunkCsv, syntheticAccounts, synthetic835, toCsv } from '../../synthetic-inventory.ts';

const CHUNK_BYTES = 900_000; // under the 1 MB JSON body limit, with room for the JSON envelope

async function one(ctx: Ctx, size: number) {
  const dir = tempDir(`scale${size}`);
  const dbPath = `${dir}/ar.db`;
  const srv = await startServer({ dbPath, dir, worker: true, name: `server${size}` });
  const tag = `${size >= 1000 ? size / 1000 + 'k' : size}`;
  try {
    const ana = await login(srv.base, 'u_ana');
    const sam = await login(srv.base, 'u_sam');
    const accounts = syntheticAccounts(size, { batch: `B${tag}`.toUpperCase().slice(0, 6), seed: size });
    const whole = toCsv(accounts);

    // Single-request upload of the whole file: above the body limit it must be refused cleanly.
    const single = await post(ana, '/api/imports/preview', { sourceName: 'whole.csv', csv: whole }, 120_000);
    ctx.metric(`${tag}.wholeFileUpload`, { bytes: whole.length, status: single.status, error: single.error ?? null, ms: Math.round(single.ms) });
    if (whole.length > 1_000_000) ctx.check(`${tag}: oversized single upload refused with a clean 413`, single.status === 413, `status ${single.status} ${single.error ?? ''}`);

    const parts = chunkCsv(accounts, CHUNK_BYTES);
    const tImport = performance.now();
    const t0 = Date.now();
    const chunkMs: number[] = [];
    let accepted = 0;
    const statuses: Res[] = [];
    for (const [i, csv] of parts.entries()) {
      const r = await post(ana, '/api/imports', { sourceName: `inventory-${tag}-part${i + 1}.csv`, csv }, 600_000);
      statuses.push(r);
      chunkMs.push(r.ms);
      accepted += r.body?.summary?.accepted ?? 0;
    }
    const importMs = performance.now() - tImport;
    await new Promise((r) => setTimeout(r, 1500)); // let the probe write the post-import sample
    const probe = probeSummary(srv.samples(), t0);
    const bytes = dbBytes(dbPath);
    ctx.metric(`${tag}.import`, {
      accounts: size, parts: parts.length, accepted, statuses: statusCounts(statuses), totalSeconds: Math.round(importMs / 100) / 10,
      rowsPerSecond: Math.round(size / (importMs / 1000)), slowestPartMs: Math.round(Math.max(...chunkMs)), server: probe,
      dbMb: mb(bytes.db), walMb: mb(bytes.wal),
    });
    ctx.check(`${tag}: every account imported`, accepted === size, `${accepted}/${size}`);

    // Re-import of the first part: idempotent (all duplicates, nothing written twice).
    const again = await post(ana, '/api/imports', { sourceName: 'again.csv', csv: parts[0] }, 600_000);
    ctx.check(`${tag}: re-import is idempotent`, again.status === 200 && again.body.summary.accepted === 0 && again.body.summary.duplicates > 0,
      `accepted ${again.body?.summary?.accepted}, duplicates ${again.body?.summary?.duplicates}`);

    // Concurrent readers: queue pages, views, searches and account detail.
    const ids: string[] = [];
    const page = await get(ana, '/api/accounts?pageSize=100', 600_000);
    for (const it of page.body?.items ?? []) ids.push(it.accountId);
    const readers = ctx.mode === 'quick' ? 8 : 16;
    const budget = ctx.mode === 'quick' ? 15_000 : 45_000;
    const maxReq = ctx.mode === 'quick' ? 400 : 2000;
    const kinds: Record<string, number[]> = { queue_first_page: [], queue_deep_page: [], queue_view_filter: [], search_exact: [], search_partial: [], account_detail: [] };
    const all: Res[] = [];
    const deadline = Date.now() + budget;
    let issued = 0;
    const rnd = (n: number) => Math.floor(Math.random() * n);
    await Promise.all(Array.from({ length: readers }, async () => {
      while (Date.now() < deadline && issued < maxReq) {
        issued++;
        const k = Object.keys(kinds)[rnd(6)];
        const a = accounts[rnd(accounts.length)];
        const path = k === 'queue_first_page' ? '/api/accounts?view=all'
          : k === 'queue_deep_page' ? `/api/accounts?view=all&page=${1 + rnd(Math.max(1, Math.floor(size / 25)))}`
          : k === 'queue_view_filter' ? '/api/accounts?view=not_started&pageSize=50'
          : k === 'search_exact' ? `/api/accounts?q=${a.externalId}`
          : k === 'search_partial' ? `/api/accounts?q=${a.externalId.slice(0, -2)}`
          : `/api/accounts/${ids[rnd(ids.length)]}`;
        const r = await get(ana, path, 600_000);
        kinds[k].push(r.ms);
        all.push(r);
      }
    }));
    const lat = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, latency(v)]));
    ctx.metric(`${tag}.readLatencyMs`, { readers, requests: all.length, statuses: statusCounts(all), ...lat });
    ctx.check(`${tag}: concurrent reads never fail`, cleanStatuses(statusCounts(all)) && all.every((r) => r.status === 200), JSON.stringify(statusCounts(all)));
    const exact = await get(ana, `/api/accounts?q=${accounts[size - 1].externalId}`);
    ctx.check(`${tag}: search finds the last imported account`, exact.body?.items?.[0]?.externalId === accounts[size - 1].externalId);

    // Supervisor operations page (includes the audit chain verification).
    const ops: number[] = [];
    for (let i = 0; i < 3; i++) ops.push((await get(as(sam), '/api/ops/outbox', 600_000)).ms);
    ctx.metric(`${tag}.opsOutboxMs`, latency(ops));

    // A large 835 against the imported claims (as many CLPs as fit under the EDI size limit).
    let n = Math.min(size, 6000);
    let edi = synthetic835(accounts.slice(0, n));
    while (edi.length > 900_000) { n = Math.floor(n * 0.85); edi = synthetic835(accounts.slice(0, n)); }
    const pv = await post(sam, '/api/integrations/edi/preview', { filename: `era-${tag}.edi`, content: edi }, 600_000);
    const ing = pv.status === 200 ? await post(sam, '/api/integrations/edi/ingest', { filename: `era-${tag}.edi`, content: edi, expectedSha256: pv.body.rawSha256 }, 600_000) : null;
    ctx.metric(`${tag}.edi835`, { claims: n, bytes: edi.length, previewStatus: pv.status, previewMs: Math.round(pv.ms), matched: pv.body?.summary?.matched ?? null,
      ingestStatus: ing?.status ?? null, ingestMs: ing ? Math.round(ing.ms) : null, ingestError: ing && ing.status !== 200 ? ing.body?.error?.code ?? ing.error : null });
    ctx.check(`${tag}: ${n}-claim 835 previews and ingests`, pv.status === 200 && ing?.status === 200, `preview ${pv.status}, ingest ${ing?.status}`);
    const health = await call(srv.base, 'GET', '/api/health', { timeoutMs: 5000 });
    ctx.check(`${tag}: server healthy at the end`, health.status === 200 && srv.alive());
  } finally {
    await srv.stop();
    removeDir(dir);
  }
}

export const scale: Scenario = {
  name: 'scale',
  title: 'Bulk import and read latency at 1k / 10k / 50k accounts',
  async run(ctx) {
    for (const size of ctx.mode === 'quick' ? [1000, 5000] : [1000, 10_000, 50_000]) await one(ctx, size);
  },
};
