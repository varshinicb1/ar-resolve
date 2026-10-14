// Soak: a sustained mixed workload (reads, investigations, corrections + approvals, small
// imports, EDI previews, call attempts, supervisor views and worker ticks) for several
// minutes, watching server memory and event-loop delay from inside the process.
import { readFileSync } from 'node:fs';
import { as, call, get, login, pool, post, type Res } from '../lib/http.ts';
import { removeDir, ROOT, startServer, tempDir, dbBytes } from '../lib/proc.ts';
import { checkInvariants } from '../lib/invariants.ts';
import { heapSlopeMbPerMin, latency, mb, probeSummary, statusCounts } from '../lib/stats.ts';
import { cleanStatuses, cohortInventory, sleep, type Scenario } from '../lib/ctx.ts';
import { syntheticAccounts, toCsv, chunkCsv } from '../../synthetic-inventory.ts';

export const soak: Scenario = {
  name: 'soak',
  title: 'Sustained mixed workload (memory and event-loop lag)',
  async run(ctx) {
    const dir = tempDir('soak');
    const dbPath = `${dir}/ar.db`;
    const srv = await startServer({ dbPath, dir, worker: true, env: { AR_WORKER_INTERVAL_MS: '250' } });
    try {
      const ana = await login(srv.base, 'u_ana');
      const rui = await login(srv.base, 'u_rui');
      const sam = await login(srv.base, 'u_sam');
      const base = ctx.mode === 'quick' ? 2000 : 10_000;
      for (const part of chunkCsv(syntheticAccounts(base, { batch: 'SOAK', seed: 3 }), 900_000)) await post(ana, '/api/imports', { sourceName: 'soak-base.csv', csv: part }, 600_000);
      for (const client of ['cl_ortho', 'cl_derm', 'cl_multi']) await post(as(ana, client), '/api/imports', { sourceName: `${client}.csv`, csv: cohortInventory(client) });
      const ids: string[] = (await get(ana, '/api/accounts?pageSize=100&view=not_started')).body.items.map((i: any) => i.accountId);
      const cohortIds: string[] = (await get(ana, '/api/accounts?q=SYN-10&pageSize=100')).body.items.map((i: any) => i.accountId);
      await pool(cohortIds, 4, (id) => post(ana, `/api/accounts/${id}/investigate`));
      const era = readFileSync(`${ROOT}fixtures/x12/835-cl_ortho-era.edi`, 'utf8');

      const durationMs = ctx.mode === 'quick' ? 20_000 : 300_000;
      const t0 = Date.now();
      const deadline = t0 + durationMs;
      const res: Record<string, Res[]> = {};
      const rec = (k: string, r: Res) => { (res[k] ??= []).push(r); return r; };
      const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
      let batch = 0;
      let approvals = 0;
      const loop = (n: number, fn: () => Promise<unknown>) => Promise.all(Array.from({ length: n }, async () => { while (Date.now() < deadline) await fn(); }));
      await Promise.all([
        loop(8, async () => {
          const k = Math.random();
          if (k < 0.35) rec('queue', await get(ana, `/api/accounts?page=${1 + Math.floor(Math.random() * 20)}`));
          else if (k < 0.55) rec('search', await get(ana, `/api/accounts?q=SYNS-SOAK-${String(Math.floor(Math.random() * base)).padStart(6, '0').slice(0, 5)}`));
          else if (k < 0.85) rec('detail', await get(ana, `/api/accounts/${pick([...ids, ...cohortIds])}`));
          else rec('reviews', await get(rui, '/api/reviews'));
        }),
        loop(2, async () => { rec('investigate', await post(ana, `/api/accounts/${pick(ids)}/investigate`)); }),
        loop(1, async () => {
          const id = pick(cohortIds);
          const v = rec('detail', await get(ana, `/api/accounts/${id}`));
          const open = v.body?.actions?.find((a: any) => a.state === 'awaiting_review');
          if (open) {
            const r = rec('approve', await post(rui, `/api/actions/${open.actionId}/review`, { decision: 'approved', rationale: 'soak approval', payloadSha256: open.payloadSha256, accountRevision: v.body.account.revision }));
            if (r.status === 200) approvals++;
          } else if (v.status === 200) {
            rec('correct', await post(ana, `/api/accounts/${id}/facts/metBeforeCents/correct`, { value: 100000 + Math.floor(Math.random() * 100000), reason: 'soak correction', expectedRevision: v.body.account.revision }));
          }
        }),
        loop(1, async () => {
          batch++;
          rec('import', await post(ana, '/api/imports', { sourceName: `soak-${batch}.csv`, csv: toCsv(syntheticAccounts(200, { batch: `K${batch}`, seed: 100 + batch })) }));
          await sleep(1500);
        }),
        loop(1, async () => { rec('edi_preview', await post(sam, '/api/integrations/edi/preview', { filename: 'era.edi', content: era })); await sleep(500); }),
        loop(1, async () => { rec('call_start', await post(ana, `/api/accounts/${pick(cohortIds)}/calls`, {})); await sleep(300); }),
        loop(1, async () => { rec('ops_outbox', await get(sam, '/api/ops/outbox')); rec('tick', await post(sam, '/api/ops/worker/tick')); await sleep(1000); }),
      ]);
      await sleep(1200);
      const samples = srv.samples().filter((s) => s.t >= t0);
      const all = Object.values(res).flat();
      const half = samples.slice(Math.floor(samples.length / 2));
      const quarter = samples[Math.floor(samples.length / 4)];
      const end = samples[samples.length - 1];
      ctx.metric('workload', { seconds: Math.round((Date.now() - t0) / 1000), requests: all.length, throughputPerSecond: Math.round(all.length / (durationMs / 1000)),
        statuses: statusCounts(all), approvals, importsCommitted: res.import?.filter((r) => r.status === 200).length ?? 0 });
      ctx.metric('latencyMs', Object.fromEntries(Object.entries(res).map(([k, v]) => [k, latency(v.map((r) => r.ms))])));
      ctx.metric('server', { ...probeSummary(samples), heapSlopeMbPerMinSecondHalf: heapSlopeMbPerMin(half), heapAtQuarterMb: quarter ? mb(quarter.heapUsed) : null,
        dbMbAtEnd: mb(dbBytes(dbPath).db), walMbAtEnd: mb(dbBytes(dbPath).wal) });
      ctx.check('no 5xx or transport errors during the soak', cleanStatuses(statusCounts(all)), JSON.stringify(statusCounts(all)));
      ctx.check('heap does not grow without bound (end minus 25% mark < 150 MB)', !!quarter && !!end && (end.heapUsed - quarter.heapUsed) / 1048576 < 150,
        quarter && end ? `${mb(quarter.heapUsed)} -> ${mb(end.heapUsed)} MB` : 'no samples');
      const inv = checkInvariants(dbPath);
      ctx.metric('invariants', inv.stats);
      ctx.check('safety invariants hold after the soak', inv.violations.length === 0, inv.violations.slice(0, 5).map((v) => `${v.invariant}: ${v.detail}`).join('; '));
      const h = await call(srv.base, 'GET', '/api/health');
      ctx.check('server healthy, no unhandled errors', h.status === 200 && !(srv.output().match(/\[api\]|\[worker\]/g) ?? []).length, `health ${h.status} ${h.error ?? ''} in ${Math.round(h.ms)} ms; alive=${srv.alive()}; ` + (srv.output().split('\n').filter((l) => /\[api\]|\[worker\]/.test(l)).slice(0, 3).join(' | ') || srv.output().slice(-400)));
    } finally {
      await srv.stop();
      removeDir(dir);
    }
  },
};
