// Approval races and outbox concurrency: many reviewers approving the same action at once,
// double-submits, stale revisions and hashes, approve-while-the-account-changes, then
// dispatch from several worker processes plus API-triggered ticks at the same time.
// Exactly one decision and at most one send per action must result.
import { as, call, get, login, pool, post, type Res, type Session } from '../lib/http.ts';
import { removeDir, startServer, startWorker, tempDir, type Proc } from '../lib/proc.ts';
import { checkInvariants } from '../lib/invariants.ts';
import { latency, statusCounts } from '../lib/stats.ts';
import { cleanStatuses, cohortInventory, sleep, type Scenario } from '../lib/ctx.ts';

const CLIENTS = ['cl_ortho', 'cl_derm', 'cl_multi'];

interface Pending { client: string; actionId: string; accountId: string; sha: string; rev: number }

async function pendingReviews(s: Session, client: string): Promise<Pending[]> {
  const c = as(s, client);
  const list = await get(c, '/api/reviews');
  const out: Pending[] = [];
  for (const r of list.body) {
    const v = await get(c, `/api/accounts/${r.accountId}`);
    const a = v.body.actions.find((x: any) => x.actionId === r.actionId);
    if (a) out.push({ client, actionId: r.actionId, accountId: r.accountId, sha: a.payloadSha256, rev: v.body.account.revision });
  }
  return out;
}

export const approvals: Scenario = {
  name: 'approvals',
  title: 'Approval races and multi-process outbox dispatch',
  async run(ctx) {
    const dir = tempDir('approvals');
    const dbPath = `${dir}/ar.db`;
    const srv = await startServer({ dbPath, dir, worker: false });
    const workers: Proc[] = [];
    try {
      const ana = await login(srv.base, 'u_ana');
      const sam = await login(srv.base, 'u_sam');
      const reviewers = [await login(srv.base, 'u_rui'), await login(srv.base, 'u_rui'), await login(srv.base, 'u_rui'),
        await login(srv.base, 'u_lee'), await login(srv.base, 'u_lee'), await login(srv.base, 'u_lee')];
      for (const client of CLIENTS) {
        const c = as(ana, client);
        await post(c, '/api/imports', { sourceName: `${client}.csv`, csv: cohortInventory(client) });
        const ids = (await get(c, '/api/accounts?pageSize=100')).body.items.map((i: any) => i.accountId);
        await pool(ids, 8, (id: string) => post(c, `/api/accounts/${id}/investigate`));
      }

      // 1. Three standalone worker processes poll the outbox every 20 ms with 40 ms of simulated
      //    connector latency, while the API process also ticks: four dispatchers on one database.
      for (const name of ['workerA', 'workerB', 'workerC']) workers.push(startWorker({ dbPath, dir, name, env: { AR_WORKER_INTERVAL_MS: '20', AR_STRESS_CONNECTOR_DELAY_MS: '40' } }));
      await sleep(2000);

      // 2. Approval storms on every proposal at once: per action, 17 concurrent decisions of mixed
      //    validity, while 40 API ticks run alongside.
      const targets = (await Promise.all(CLIENTS.map((c) => pendingReviews(ana, c)))).flat();
      ctx.check('cohort produced proposals to race on', targets.length >= 5, `${targets.length} proposals`);
      let exactlyOne = 0;
      const storm: Res[] = [];
      const tickRuns = pool(Array.from({ length: 40 }, (_, i) => i), 4, async () => { const r = await post(as(sam), '/api/ops/worker/tick'); await sleep(10); return r; });
      await Promise.all(targets.map(async (t) => {
        const body = { decision: 'approved', rationale: 'stress race approval', payloadSha256: t.sha, accountRevision: t.rev };
        const reqs: (() => Promise<Res>)[] = [
          ...reviewers.map((r) => () => post(as(r, t.client), `/api/actions/${t.actionId}/review`, body)),
          ...Array.from({ length: 4 }, () => () => post(as(reviewers[0], t.client), `/api/actions/${t.actionId}/review`, body)), // double-submit
          ...Array.from({ length: 2 }, () => () => post(as(reviewers[1], t.client), `/api/actions/${t.actionId}/review`, { ...body, accountRevision: t.rev - 1 })), // stale
          ...Array.from({ length: 2 }, () => () => post(as(reviewers[2], t.client), `/api/actions/${t.actionId}/review`, { ...body, payloadSha256: 'f'.repeat(64) })), // wrong hash
          ...Array.from({ length: 2 }, () => () => post(as(reviewers[4], t.client), `/api/actions/${t.actionId}/review`, { ...body, decision: 'rejected', rationale: 'stress race rejection' })),
          () => post(as(ana, t.client), `/api/actions/${t.actionId}/review`, body), // specialist: not a reviewer
        ];
        const rs = await Promise.all(reqs.map((f) => f()));
        storm.push(...rs);
        if (rs.filter((r) => r.status === 200).length === 1) exactlyOne++;
      }));
      const ticks = await tickRuns;
      ctx.metric('approvalStorm', { actions: targets.length, requestsPerAction: 17, statuses: statusCounts(storm), latencyMs: latency(storm.map((r) => r.ms)) });
      ctx.check('exactly one decision wins per action', exactlyOne === targets.length, `${exactlyOne}/${targets.length}`);
      ctx.check('losing decisions get 4xx, never 5xx', cleanStatuses(statusCounts(storm)));
      ctx.metric('apiTicksDuringWorkerStorm', { statuses: statusCounts(ticks), latencyMs: latency(ticks.map((r) => r.ms)) });
      ctx.check('API ticks overlapping worker processes never 5xx', cleanStatuses(statusCounts(ticks)), JSON.stringify(statusCounts(ticks)));
      const pre = checkInvariants(dbPath);
      ctx.check('one decision row per action in the database', !pre.violations.some((v) => v.invariant === 'one_decision_per_action'));
      await sleep(2000);

      // 3. Signed payer confirmations replayed concurrently: one applies, the rest are duplicates.
      const outbox = (await get(as(sam), '/api/ops/outbox')).body.outbox as any[];
      const sim = outbox.filter((o) => o.connector === 'sim_payer' && o.external_reference);
      let dupOk = 0;
      for (const o of sim) {
        const eventId = `whk_stress_${o.action_id}`;
        const rs = await Promise.all(Array.from({ length: 6 }, () => post(as(sam, CLIENTS.find((c) => o.idempotency_key.includes(`:${c}:`)) ?? 'cl_ortho'), `/api/ops/sim-confirm/${o.action_id}`, { eventId })));
        const applied = rs.filter((r) => r.status === 200 && r.body.first?.duplicate === false).length;
        if (applied === 1 && rs.every((r) => r.status === 200)) dupOk++;
      }
      ctx.metric('webhookReplays', { actions: sim.length, perAction: 6, exactlyOneApplied: dupOk });
      ctx.check('replayed payer confirmations apply exactly once', dupOk === sim.length, `${dupOk}/${sim.length}`);

      // 4. Approve while the account changes, with a tick in the same instant (SYN-1042).
      const ortho = as(ana, 'cl_ortho');
      const acct = (await get(ortho, '/api/accounts?q=SYN-1042')).body.items[0].accountId as string;
      const rounds = ctx.mode === 'quick' ? 8 : 30;
      const outcomes: Record<string, number> = {};
      const raceRes: Res[] = [];
      for (let i = 0; i < rounds; i++) {
        let v = await get(ortho, `/api/accounts/${acct}`);
        let open = v.body.actions.find((x: any) => x.state === 'awaiting_review');
        if (!open) {
          await post(ortho, `/api/accounts/${acct}/facts/metBeforeCents/correct`, { value: 200000 + (i % 2), reason: 'stress new evidence', expectedRevision: v.body.account.revision });
          v = await get(ortho, `/api/accounts/${acct}`);
          open = v.body.actions.find((x: any) => x.state === 'awaiting_review');
          if (!open) { outcomes.no_proposal = (outcomes.no_proposal ?? 0) + 1; continue; }
        }
        const rev = v.body.account.revision;
        const [ap, co, tk] = await Promise.all([
          post(as(reviewers[i % 6], 'cl_ortho'), `/api/actions/${open.actionId}/review`, { decision: 'approved', rationale: 'stress approve during change', payloadSha256: open.payloadSha256, accountRevision: rev }),
          post(ortho, `/api/accounts/${acct}/facts/metBeforeCents/correct`, { value: 200000 + ((i + 1) % 2), reason: 'stress concurrent change', expectedRevision: rev }),
          post(as(sam, 'cl_ortho'), '/api/ops/worker/tick'),
        ]);
        raceRes.push(ap, co, tk);
        const key = `approve:${ap.status}${ap.body?.error ? `/${ap.body.error.code}` : ''} correct:${co.status}${co.body?.error ? `/${co.body.error.code}` : ''}`;
        outcomes[key] = (outcomes[key] ?? 0) + 1;
        await sleep(30);
      }
      ctx.metric('approveWhileChanging', { rounds, outcomes, statuses: statusCounts(raceRes) });
      ctx.check('approve-while-changing never 5xx', cleanStatuses(statusCounts(raceRes)), JSON.stringify(statusCounts(raceRes)));

      // Quiesce: stop the workers, let leases expire if any, final tick, then check invariants.
      await sleep(500);
      for (const w of workers) await w.stop();
      const errs = workers.map((w) => w.output()).join('\n').split('\n').filter((l) => /\bError\b|database is locked|SQLITE_BUSY/.test(l));
      ctx.metric('workerProcessErrors', { lines: errs.length, sample: errs.slice(0, 3) });
      ctx.check('worker processes logged no errors (no SQLITE_BUSY)', errs.length === 0, errs.slice(0, 2).join(' | '));
      await post(as(sam), '/api/ops/worker/tick');
      const inv = checkInvariants(dbPath, { quiesced: true });
      ctx.metric('invariants', inv.stats);
      ctx.check('safety invariants hold (one decision, no blind resend, bound sends, states agree, audit chain)', inv.violations.length === 0,
        inv.violations.slice(0, 6).map((v) => `${v.invariant}: ${v.detail}`).join('; '));
      const h = await call(srv.base, 'GET', '/api/health');
      ctx.check('server healthy', h.status === 200 && srv.alive());
      const apiErrors = (srv.output().match(/\[api\]/g) ?? []).length;
      ctx.check('no unhandled server errors logged', apiErrors === 0, srv.output().split('\n').filter((l) => l.includes('[api]') || /Error/.test(l)).slice(0, 3).join(' | '));
    } finally {
      for (const w of workers) await w.kill();
      await srv.stop();
      removeDir(dir);
    }
  },
};
