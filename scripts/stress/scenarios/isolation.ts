// Scope isolation under load: cross-tenant and cross-client requests interleaved with legitimate
// traffic. Every foreign request must be refused, and no response may contain a foreign identifier.
import { as, call, get, login, post, type Res, type Session } from '../lib/http.ts';
import { removeDir, startServer, tempDir } from '../lib/proc.ts';
import { latency, statusCounts } from '../lib/stats.ts';
import { cohortInventory, type Scenario } from '../lib/ctx.ts';

export const isolation: Scenario = {
  name: 'isolation',
  title: 'Scope isolation under concurrent load',
  async run(ctx) {
    const dir = tempDir('isolation');
    const srv = await startServer({ dbPath: `${dir}/ar.db`, dir, worker: true });
    try {
      const ana = await login(srv.base, 'u_ana');
      const ada = await login(srv.base, 'u_ada'); // auditor, cl_ortho only
      const bea = await login(srv.base, 'u_bea', 'tn_other', 'cl_other');
      const demo: { client: string; id: string; ext: string; action?: string }[] = [];
      for (const client of ['cl_ortho', 'cl_derm']) {
        const c = as(ana, client);
        await post(c, '/api/imports', { sourceName: `${client}.csv`, csv: cohortInventory(client) });
        for (const it of (await get(c, '/api/accounts?pageSize=100')).body.items) {
          const inv = await post(c, `/api/accounts/${it.accountId}/investigate`);
          demo.push({ client, id: it.accountId, ext: it.externalId, action: inv.body?.actionId ?? undefined });
        }
      }
      await post(bea, '/api/imports', { sourceName: 'other.csv', csv: cohortInventory('cl_other') });
      const other = (await get(bea, '/api/accounts?pageSize=100')).body.items.map((i: any) => ({ id: i.accountId as string, ext: i.externalId as string }));
      const derm = demo.filter((d) => d.client === 'cl_derm');
      const ortho = demo.filter((d) => d.client === 'cl_ortho');
      const foreignForBea = demo.flatMap((d) => [d.id, d.ext]);
      const foreignForAna = other.flatMap((o: { id: string; ext: string }) => [o.id, o.ext]);
      const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

      type Probe = { kind: string; legit: boolean; foreign: string[]; run: () => Promise<Res> };
      const probes: Probe[] = [
        { kind: 'legit list', legit: true, foreign: foreignForAna, run: () => get(as(ana, 'cl_ortho'), '/api/accounts?pageSize=50') },
        { kind: 'legit detail', legit: true, foreign: [...foreignForAna, ...derm.map((d) => d.id)], run: () => get(as(ana, 'cl_ortho'), `/api/accounts/${pick(ortho).id}`) },
        { kind: 'legit other-tenant list', legit: true, foreign: foreignForBea, run: () => get(bea, '/api/accounts?pageSize=50') },
        { kind: 'other tenant reads demo account by id', legit: false, foreign: foreignForBea, run: () => get(bea, `/api/accounts/${pick(demo).id}`) },
        { kind: 'other tenant names demo scope', legit: false, foreign: foreignForBea, run: () => get(as(bea, 'cl_ortho', 'tn_demo'), '/api/accounts') },
        { kind: 'other tenant searches demo external id', legit: true, foreign: foreignForBea, run: () => get(bea, `/api/accounts?q=${pick(demo).ext}`) },
        { kind: 'other tenant investigates demo account', legit: false, foreign: foreignForBea, run: () => post(bea, `/api/accounts/${pick(demo).id}/investigate`) },
        { kind: 'other tenant reviews demo action', legit: false, foreign: foreignForBea, run: () => post(bea, `/api/actions/${pick(demo.filter((d) => d.action)).action}/review`, { decision: 'approved', rationale: 'cross tenant attempt', payloadSha256: 'x', accountRevision: 1 }) },
        { kind: 'other tenant audit export', legit: false, foreign: foreignForBea, run: () => get(bea, `/api/accounts/${pick(demo).id}/audit-export`) },
        { kind: 'cross-client detail (ortho scope, derm id)', legit: false, foreign: derm.flatMap((d) => [d.id, d.ext]), run: () => get(as(ana, 'cl_ortho'), `/api/accounts/${pick(derm).id}`) },
        { kind: 'auditor outside grant', legit: false, foreign: derm.flatMap((d) => [d.id, d.ext]), run: () => get(as(ada, 'cl_derm'), '/api/accounts') },
        { kind: 'demo user reads other tenant id', legit: false, foreign: foreignForAna, run: () => get(as(ana, 'cl_ortho'), `/api/accounts/${pick(other as { id: string }[]).id}`) },
        { kind: 'no token', legit: false, foreign: [...foreignForAna, ...foreignForBea], run: () => call(srv.base, 'GET', '/api/accounts', { tenant: 'tn_demo', client: 'cl_ortho' }) },
        { kind: 'forged token', legit: false, foreign: [...foreignForAna, ...foreignForBea], run: () => call(srv.base, 'GET', '/api/accounts', { token: 'forged-token', tenant: 'tn_demo', client: 'cl_ortho' }) },
      ];
      const total = ctx.mode === 'quick' ? 3000 : 15_000;
      const results: { p: Probe; r: Res }[] = [];
      let next = 0;
      await Promise.all(Array.from({ length: 32 }, async () => {
        while (next < total) { next++; const p = probes[next % probes.length]; results.push({ p, r: await p.run() }); }
      }));
      let leaks = 0;
      const leakKinds = new Set<string>();
      for (const { p, r } of results) {
        const text = JSON.stringify(r.body);
        if (p.foreign.some((f) => f && text.includes(f))) { leaks++; leakKinds.add(p.kind); }
      }
      const byKind: Record<string, Record<string, number>> = {};
      for (const p of probes) byKind[p.kind] = statusCounts(results.filter((x) => x.p === p).map((x) => x.r));
      ctx.metric('requests', { total: results.length, concurrency: 32, byKind, latencyMs: latency(results.map((x) => x.r.ms)) });
      ctx.check('no response contains a foreign identifier', leaks === 0, leaks ? `${leaks} leaks in: ${[...leakKinds].join(', ')}` : undefined);
      const badCross = results.filter((x) => !x.p.legit && ![401, 403, 404].includes(x.r.status));
      ctx.check('every foreign request is refused (401/403/404)', badCross.length === 0, badCross.slice(0, 3).map((x) => `${x.p.kind}: ${x.r.status}`).join('; '));
      const badLegit = results.filter((x) => x.p.legit && x.r.status !== 200);
      ctx.check('every legitimate request succeeds under the same load', badLegit.length === 0, badLegit.slice(0, 3).map((x) => `${x.p.kind}: ${x.r.status}`).join('; '));
      const s: Session = bea;
      void s;
    } finally {
      await srv.stop();
      removeDir(dir);
    }
  },
};
