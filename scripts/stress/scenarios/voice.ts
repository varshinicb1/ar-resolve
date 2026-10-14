// Concurrent simulated calls: a storm of start-call requests (with and without idempotency
// keys) across every cohort account while the voice worker and API callers advance and cancel
// calls. The per-payer concurrency (2) and hourly rate (6) limits of the simulated line must hold.
import { ACTIVE_CALL_STATES } from '../../../server/services/voice/policy.ts';
import { SIM_PAYER_LINES } from '../../../server/connectors/sim-voice.ts';
import { as, call, get, login, pool, post, type Res } from '../lib/http.ts';
import { removeDir, startServer, tempDir } from '../lib/proc.ts';
import { checkInvariants, openReadOnly } from '../lib/invariants.ts';
import { latency, statusCounts } from '../lib/stats.ts';
import { cleanStatuses, cohortInventory, sleep, type Scenario } from '../lib/ctx.ts';

const CLIENTS = ['cl_ortho', 'cl_derm', 'cl_multi'];

export const voice: Scenario = {
  name: 'voice',
  title: 'Concurrent simulated calls and call advancement',
  async run(ctx) {
    const dir = tempDir('voice');
    const dbPath = `${dir}/ar.db`;
    const srv = await startServer({ dbPath, dir, worker: true });
    try {
      const ana = await login(srv.base, 'u_ana');
      const rui = await login(srv.base, 'u_rui');
      const accounts: { client: string; id: string }[] = [];
      for (const client of CLIENTS) {
        const c = as(ana, client);
        await post(c, '/api/imports', { sourceName: `${client}.csv`, csv: cohortInventory(client) });
        const ids = (await get(c, '/api/accounts?pageSize=100')).body.items.map((i: any) => i.accountId as string) as string[];
        await pool(ids, 8, (id) => post(c, `/api/accounts/${id}/investigate`));
        accounts.push(...ids.map((id) => ({ client, id })));
      }
      const line = SIM_PAYER_LINES['demo-payer'];
      const ph = ACTIVE_CALL_STATES.map(() => '?').join(',');

      // Sampler: the number of active calls per tenant on the demo payer line, every 5 ms.
      let maxActive = 0;
      let sampling = true;
      const sampler = (async () => {
        const db = openReadOnly(dbPath);
        try {
          const q = db.prepare(`SELECT tenant_id, COUNT(*) n FROM voice_calls WHERE payer_id='demo-payer' AND state IN (${ph}) GROUP BY tenant_id`);
          while (sampling) { for (const r of q.all(...ACTIVE_CALL_STATES) as { n: number }[]) maxActive = Math.max(maxActive, r.n); await sleep(5); }
        } finally { db.close(); }
      })();

      // Storm: per account, two requests sharing an idempotency key plus one without a key.
      const reqs = accounts.flatMap((a, i) => [
        () => post(as(i % 2 ? ana : rui, a.client), `/api/accounts/${a.id}/calls`, { idempotencyKey: `stress-key-${i}-0001` }),
        () => post(as(i % 2 ? rui : ana, a.client), `/api/accounts/${a.id}/calls`, { idempotencyKey: `stress-key-${i}-0001` }),
        () => post(as(ana, a.client), `/api/accounts/${a.id}/calls`, {}),
      ]);
      const starts = await Promise.all(reqs.map((f) => f()));
      const created = new Map<string, { client: string; callId: string }>();
      starts.forEach((r, k) => { if (r.status === 200 && r.body.callId) created.set(r.body.callId, { client: accounts[Math.floor(k / 3)].client, callId: r.body.callId }); });
      const refused = starts.filter((r) => r.status === 422).map((r) => (r.body?.error?.details?.reasonCodes ?? []) as string[]).flat();
      const reasons: Record<string, number> = {};
      for (const c of refused) reasons[c] = (reasons[c] ?? 0) + 1;
      ctx.metric('startStorm', { requests: starts.length, statuses: statusCounts(starts), distinctCallsCreated: created.size, refusalReasons: reasons, latencyMs: latency(starts.map((r) => r.ms)) });
      ctx.check('start-call storm never 5xx', cleanStatuses(statusCounts(starts)), JSON.stringify(statusCounts(starts)));
      const dupPairs = accounts.map((_, i) => [starts[i * 3], starts[i * 3 + 1]]).filter(([x, y]) => x.status === 200 && y.status === 200);
      ctx.check('same idempotency key never creates two calls', dupPairs.every(([x, y]) => x.body.callId === y.body.callId), `${dupPairs.length} keyed pairs both accepted`);

      // Advance every created call from many callers at once, cancel one mid-way.
      const adv: Res[] = [];
      const calls = [...created.values()];
      for (let round = 0; round < (ctx.mode === 'quick' ? 10 : 40); round++) {
        const rs = await Promise.all(calls.flatMap((c) => Array.from({ length: 5 }, () => post(as(ana, c.client), `/api/calls/${c.callId}/advance`, { steps: 3 }))));
        adv.push(...rs);
        if (round === 2 && calls[0]) adv.push(...(await Promise.all([post(as(ana, calls[0].client), `/api/calls/${calls[0].callId}/cancel`, { reason: 'stress cancel' }),
          post(as(ana, calls[0].client), `/api/calls/${calls[0].callId}/advance`, { steps: 5 }), post(as(rui, calls[0].client), `/api/calls/${calls[0].callId}/takeover`, { reason: 'stress takeover' })])));
      }
      ctx.metric('advance', { requests: adv.length, statuses: statusCounts(adv), latencyMs: latency(adv.map((r) => r.ms)) });
      ctx.check('concurrent advance/cancel/takeover never 5xx', cleanStatuses(statusCounts(adv)), JSON.stringify(statusCounts(adv)));

      // A second wave after calls ended: the hourly rate limit still caps new calls.
      const wave2 = await Promise.all(accounts.map((a) => post(as(ana, a.client), `/api/accounts/${a.id}/calls`, {})));
      for (const r of wave2) if (r.status === 200 && r.body.callId) created.set(r.body.callId, { client: '', callId: r.body.callId });
      sampling = false;
      await sampler;
      const db = openReadOnly(dbPath);
      const perHour = db.prepare(`SELECT tenant_id, COUNT(*) n FROM voice_calls WHERE payer_id='demo-payer' GROUP BY tenant_id`).all() as { tenant_id: string; n: number }[];
      const states = db.prepare('SELECT state, COUNT(*) n FROM voice_calls GROUP BY state').all();
      db.close();
      ctx.metric('limits', { maxConcurrentObserved: maxActive, maxConcurrentAllowed: line.maxConcurrent, callsPerTenantThisHour: perHour, maxCallsPerHourAllowed: line.maxCallsPerHour, wave2: statusCounts(wave2), callStates: states });
      ctx.check(`never more than ${line.maxConcurrent} concurrent calls on the payer line`, maxActive <= line.maxConcurrent, `max observed ${maxActive}`);
      ctx.check(`never more than ${line.maxCallsPerHour} calls per hour per tenant on the payer line`, perHour.every((r) => r.n <= line.maxCallsPerHour), JSON.stringify(perHour));
      ctx.check('second wave never 5xx', cleanStatuses(statusCounts(wave2)));
      const inv = checkInvariants(dbPath);
      ctx.check('safety invariants hold', inv.violations.length === 0, inv.violations.slice(0, 5).map((v) => `${v.invariant}: ${v.detail}`).join('; '));
      const h = await call(srv.base, 'GET', '/api/health');
      ctx.check('server healthy and no unhandled errors', h.status === 200 && !(srv.output().match(/\[api\]|\[voice\]/g) ?? []).length, srv.output().split('\n').filter((l) => /\[api\]|\[voice\]/.test(l)).slice(0, 3).join(' | '));
    } finally {
      await srv.stop();
      removeDir(dir);
    }
  },
};
