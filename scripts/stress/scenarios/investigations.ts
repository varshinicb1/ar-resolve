// Concurrent investigations across many accounts, and concurrent investigations and fact
// corrections on the SAME account (revision races).
import { as, call, get, login, pool, post } from '../lib/http.ts';
import { removeDir, startServer, tempDir } from '../lib/proc.ts';
import { checkInvariants, openReadOnly } from '../lib/invariants.ts';
import { latency, statusCounts } from '../lib/stats.ts';
import { cleanStatuses, cohortInventory, type Scenario } from '../lib/ctx.ts';
import { syntheticAccounts, toCsv } from '../../synthetic-inventory.ts';

export const investigations: Scenario = {
  name: 'investigations',
  title: 'Concurrent investigations (many accounts, and one account)',
  async run(ctx) {
    const dir = tempDir('invest');
    const dbPath = `${dir}/ar.db`;
    const srv = await startServer({ dbPath, dir, worker: true });
    try {
      const ana = await login(srv.base, 'u_ana');
      const rui = await login(srv.base, 'u_rui');
      const n = ctx.mode === 'quick' ? 300 : 1000;
      await post(ana, '/api/imports', { sourceName: 'bulk.csv', csv: toCsv(syntheticAccounts(n, { batch: 'INV', seed: 7 })) });
      await post(ana, '/api/imports', { sourceName: 'cohort.csv', csv: cohortInventory('cl_ortho') });

      // Many accounts, 16 concurrent investigators.
      const ids: string[] = [];
      for (let page = 1; ids.length < n; page++) {
        const r = await get(ana, `/api/accounts?view=not_started&pageSize=100&page=${page}`);
        if (!r.body.items?.length) break;
        ids.push(...r.body.items.map((i: any) => i.accountId));
      }
      const many = await pool(ids, 16, (id, i) => post(i % 2 ? ana : rui, `/api/accounts/${id}/investigate`));
      ctx.metric('manyAccounts', { accounts: ids.length, concurrency: 16, statuses: statusCounts(many), latencyMs: latency(many.map((r) => r.ms)) });
      ctx.check('every concurrent investigation succeeds', many.every((r) => r.status === 200), JSON.stringify(statusCounts(many)));

      // One account, 40 concurrent investigations from two people.
      const acct = (await get(ana, '/api/accounts?q=SYN-1042')).body.items[0].accountId as string;
      const same = await pool(Array.from({ length: 40 }, (_, i) => i), 40, (i) => post(i % 2 ? ana : rui, `/api/accounts/${acct}/investigate`));
      ctx.metric('sameAccountInvestigate', { requests: 40, statuses: statusCounts(same), latencyMs: latency(same.map((r) => r.ms)) });
      ctx.check('same-account investigations never fail with 5xx', cleanStatuses(statusCounts(same)));
      const db = openReadOnly(dbPath);
      const open = db.prepare(`SELECT expected_revision, COUNT(*) n FROM proposed_actions WHERE account_id=? AND state='awaiting_review' GROUP BY expected_revision`).all(acct) as { n: number }[];
      db.close();
      ctx.check('at most one open proposal per account revision', open.every((r) => r.n === 1) && open.length <= 1, JSON.stringify(open));

      // 30 concurrent corrections bound to the same revision: exactly one may win.
      const view = await get(ana, `/api/accounts/${acct}`);
      const rev = view.body.account.revision as number;
      const corr = await pool(Array.from({ length: 30 }, (_, i) => i), 30, (i) =>
        post(i % 2 ? ana : rui, `/api/accounts/${acct}/facts/metBeforeCents/correct`, { value: 150000 + i, reason: 'stress race correction', expectedRevision: rev }));
      const won = corr.filter((r) => r.status === 200).length;
      ctx.metric('sameRevisionCorrections', { requests: 30, statuses: statusCounts(corr) });
      ctx.check('exactly one correction wins a same-revision race', won === 1 && corr.every((r) => r.status === 200 || r.body?.error?.code === 'stale_revision'), JSON.stringify(statusCounts(corr)));
      const after = await get(ana, `/api/accounts/${acct}`);
      ctx.check('account revision advanced exactly once', after.body.account.revision === rev + 1, `${rev} -> ${after.body.account.revision}`);

      // Investigations and corrections interleaved on the same account.
      let r2 = after.body.account.revision as number;
      const mixed = await pool(Array.from({ length: 60 }, (_, i) => i), 20, async (i) => {
        if (i % 3) return post(rui, `/api/accounts/${acct}/investigate`);
        const r = await post(ana, `/api/accounts/${acct}/facts/metBeforeCents/correct`, { value: 120000 + i, reason: 'stress interleaved correction', expectedRevision: r2 });
        if (r.status === 200) r2 = r.body.accountRevision;
        return r;
      });
      ctx.metric('interleaved', { requests: 60, statuses: statusCounts(mixed) });
      ctx.check('interleaved investigate/correct never 5xx', cleanStatuses(statusCounts(mixed)));
      const inv = checkInvariants(dbPath);
      ctx.metric('invariants', inv.stats);
      ctx.check('safety invariants hold', inv.violations.length === 0, inv.violations.slice(0, 5).map((v) => `${v.invariant}: ${v.detail}`).join('; '));
      const h = await call(srv.base, 'GET', '/api/health');
      ctx.check('server healthy', h.status === 200 && srv.alive());
      void as;
    } finally {
      await srv.stop();
      removeDir(dir);
    }
  },
};
