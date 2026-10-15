// Crash mid-dispatch: SIGKILL a worker (and once the API process with its embedded worker)
// while a connector call is in flight, restart, and verify recovery: the expired lease becomes
// 'uncertain', read-back finds sent requests without resubmitting, absent ones are retried
// once, and no approval is ever sent twice.
import { DatabaseSync } from 'node:sqlite';
import { as, call, get, login, pool, post } from '../lib/http.ts';
import { removeDir, startServer, startWorker, tempDir } from '../lib/proc.ts';
import { checkInvariants, openReadOnly } from '../lib/invariants.ts';
import { cohortInventory, sleep, type Scenario } from '../lib/ctx.ts';

const CLIENTS = ['cl_ortho', 'cl_derm', 'cl_multi'];
const DELAY_MS = 400; // simulated connector latency: 200 ms before the send, 200 ms after

interface InFlight { actionId: string; key: string; sentAtKill: boolean; killed: string }

/** A row in 'dispatching' that is not one of the already-crashed ones. */
function inflightRow(dbPath: string, exclude: InFlight[]) {
  const db = openReadOnly(dbPath);
  try {
    const rows = db.prepare(`SELECT action_id, idempotency_key FROM action_outbox WHERE state='dispatching'`).all() as { action_id: string; idempotency_key: string }[];
    return rows.find((r) => !exclude.some((k) => k.actionId === r.action_id));
  } finally { db.close(); }
}

/** Milliseconds since the row was claimed (its action_dispatched audit event), so the kill can be
 *  timed to land inside the connector call however late the poll noticed the claim. */
function sinceClaim(dbPath: string, actionId: string): number {
  const db = openReadOnly(dbPath);
  try {
    const r = db.prepare(`SELECT event_at FROM audit_events WHERE object_id=? AND event_type='action_dispatched' ORDER BY seq DESC LIMIT 1`).get(actionId) as { event_at: string } | undefined;
    return r ? Date.now() - Date.parse(r.event_at) : 0;
  } finally { db.close(); }
}

const killDelay = (dbPath: string, actionId: string) => Math.floor(Math.random() * Math.max(0, DELAY_MS - 60 - sinceClaim(dbPath, actionId)));

function received(dbPath: string, key: string): boolean {
  const db = openReadOnly(dbPath);
  try {
    return !!db.prepare('SELECT 1 FROM sim_payer_requests WHERE idempotency_key=? UNION SELECT 1 FROM work_items WHERE idempotency_key=?').get(key, key);
  } finally { db.close(); }
}

function counts(dbPath: string): Record<string, number> {
  const db = openReadOnly(dbPath);
  try {
    return Object.fromEntries((db.prepare('SELECT state, COUNT(*) n FROM action_outbox GROUP BY state').all() as { state: string; n: number }[]).map((r) => [r.state, r.n]));
  } finally { db.close(); }
}

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(10); }
  return false;
}

export const crash: Scenario = {
  name: 'crash',
  title: 'Crash mid-dispatch and restart',
  async run(ctx) {
    const dir = tempDir('crash');
    const dbPath = `${dir}/ar.db`;
    let srv = await startServer({ dbPath, dir, worker: false });
    const kills: InFlight[] = [];
    try {
      const ana = await login(srv.base, 'u_ana');
      const rui = await login(srv.base, 'u_rui');
      let approved = 0;
      const toApprove: { client: string; accountId: string; actionId: string }[] = [];
      for (const client of CLIENTS) {
        const c = as(ana, client);
        await post(c, '/api/imports', { sourceName: `${client}.csv`, csv: cohortInventory(client) });
        const ids = (await get(c, '/api/accounts?pageSize=100')).body.items.map((i: any) => i.accountId);
        await pool(ids, 8, (id: string) => post(c, `/api/accounts/${id}/investigate`));
        for (const r of (await get(c, '/api/reviews')).body) toApprove.push({ client, accountId: r.accountId, actionId: r.actionId });
      }
      const approve = async (r: (typeof toApprove)[number]) => {
        const v = await get(as(ana, r.client), `/api/accounts/${r.accountId}`);
        const a = v.body.actions.find((x: any) => x.actionId === r.actionId);
        const d = await post(as(rui, r.client), `/api/actions/${r.actionId}/review`, { decision: 'approved', rationale: 'stress crash test approval', payloadSha256: a.payloadSha256, accountRevision: v.body.account.revision });
        if (d.status === 200) approved++;
      };
      // Hold a few approvals back for the API-server kill so that phase always has fresh rows,
      // however many rows the killed workers managed to finish before their kills.
      const heldBack = toApprove.splice(-3);
      for (const r of toApprove) await approve(r);

      // Kill standalone workers mid-dispatch, at a random point inside the connector call.
      const workerKills = ctx.mode === 'quick' ? 4 : 8;
      const timings: Record<string, unknown>[] = [];
      for (let i = 0; i < workerKills; i++) {
        const w = startWorker({ dbPath, dir, name: `crashworker${i}`, env: { AR_WORKER_INTERVAL_MS: '50', AR_STRESS_CONNECTOR_DELAY_MS: String(DELAY_MS) } });
        let row: ReturnType<typeof inflightRow>;
        const t0 = Date.now();
        const seen = await waitFor(() => !!(row = inflightRow(dbPath, kills)), 15_000);
        if (!seen) { await w.kill(); break; }
        const waited = Date.now() - t0, age = sinceClaim(dbPath, row!.action_id);
        await sleep(killDelay(dbPath, row!.action_id));
        await w.kill();
        timings.push({ worker: w.name, msToSeeClaim: waited, claimAgeWhenSeenMs: age, outboxAfterKill: counts(dbPath) });
        kills.push({ actionId: row!.action_id, key: row!.idempotency_key, sentAtKill: received(dbPath, row!.idempotency_key), killed: w.name });
      }

      ctx.metric('workerKillTimings', timings);
      for (const r of heldBack) await approve(r);
      ctx.metric('approvedPending', approved);

      // Kill the API process itself (embedded worker on) mid-dispatch, then restart it.
      await srv.stop();
      srv = await startServer({ dbPath, dir, worker: true, name: 'server-embedded', waitHealthy: false, env: { AR_WORKER_INTERVAL_MS: '50', AR_STRESS_CONNECTOR_DELAY_MS: String(DELAY_MS) } });
      let row: ReturnType<typeof inflightRow>;
      if (await waitFor(() => !!(row = inflightRow(dbPath, kills)), 15_000)) {
        await sleep(killDelay(dbPath, row!.action_id));
        await srv.kill();
        kills.push({ actionId: row!.action_id, key: row!.idempotency_key, sentAtKill: received(dbPath, row!.idempotency_key), killed: 'api-server' });
      } else { ctx.note(`API server showed no in-flight dispatch within 15 s; alive=${srv.alive()}; output tail: ${srv.output().slice(-600)}`); await srv.kill(); }
      ctx.metric('kills', { count: kills.length, sentBeforeKill: kills.filter((k) => k.sentAtKill).length, notYetSent: kills.filter((k) => !k.sentAtKill).length, stateAfterKills: counts(dbPath) });
      ctx.check('every kill landed while a dispatch was in flight', kills.length === workerKills + 1, `${kills.length} of ${workerKills + 1}`);

      // Lease expiry. Full mode waits for the real 30 s lease; quick mode moves lease_until into
      // the past directly in the database (the only write the harness makes outside the API).
      if (ctx.mode === 'full') { ctx.note('Waited 31 s of real time for the 30 s dispatch leases to expire.'); await sleep(31_000); }
      else {
        const db = new DatabaseSync(dbPath);
        db.exec('PRAGMA busy_timeout = 10000');
        db.prepare(`UPDATE action_outbox SET lease_until='2000-01-01T00:00:00.000Z' WHERE state='dispatching'`).run();
        db.close();
        ctx.note('Quick mode: dispatch leases were expired by a direct database update instead of waiting 30 s.');
      }

      // Restart: the API server (embedded worker, no injected latency) recovers everything.
      srv = await startServer({ dbPath, dir, worker: true, name: 'server-restarted', env: { AR_WORKER_INTERVAL_MS: '100' } });
      const settled = await waitFor(() => { const c = counts(dbPath); return !c.pending && !c.dispatching && !c.uncertain; }, 60_000);
      ctx.metric('stateAfterRecovery', counts(dbPath));
      ctx.check('all rows settle after restart (no pending, dispatching or uncertain)', settled, JSON.stringify(counts(dbPath)));

      const db = openReadOnly(dbPath);
      const story = kills.map((k) => {
        const ev = db.prepare(`SELECT event_type, details FROM audit_events WHERE object_id=? ORDER BY seq`).all(k.actionId) as { event_type: string; details: string }[];
        const outcome = db.prepare('SELECT state FROM action_outbox WHERE action_id=?').get(k.actionId) as { state: string };
        const reconciled = ev.filter((e) => e.event_type === 'uncertain_reconciled').map((e) => JSON.parse(e.details));
        return { ...k, finalState: outcome.state, dispatches: ev.filter((e) => e.event_type === 'action_dispatched').length, reconciled };
      });
      db.close();
      ctx.metric('perKill', story.map((s) => ({ killed: s.killed, sentAtKill: s.sentAtKill, finalState: s.finalState, dispatches: s.dispatches, reconcile: s.reconciled.map((r) => r.outcome) })));
      ctx.check('sent-before-crash requests are found by read-back, never resubmitted', story.filter((s) => s.sentAtKill).every((s) => s.dispatches === 1 && s.reconciled.some((r) => r.outcome === 'found_at_connector' && r.resubmitted === false)));
      ctx.check('unsent requests are proven absent and sent exactly once more', story.filter((s) => !s.sentAtKill).every((s) => s.dispatches === 2 && s.reconciled.some((r) => r.outcome === 'absent_at_connector')));
      ctx.check('every crashed dispatch ends accepted or confirmed', story.every((s) => s.finalState === 'accepted' || s.finalState === 'confirmed'), story.map((s) => s.finalState).join(','));
      const inv = checkInvariants(dbPath, { quiesced: true });
      ctx.metric('invariants', inv.stats);
      ctx.check('safety invariants hold after crashes', inv.violations.length === 0, inv.violations.slice(0, 5).map((v) => `${v.invariant}: ${v.detail}`).join('; '));
      const h = await call(srv.base, 'GET', '/api/health');
      ctx.check('restarted server healthy', h.status === 200);
    } finally {
      await srv.stop();
      removeDir(dir);
    }
  },
};
