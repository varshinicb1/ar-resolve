// Regression tests for the defects the stress harness found (ADR 0095). Each test names the
// defect it guards; each was seen to fail against the pre-fix code (mutation notes in the ADR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, importCohort, accountByExt, type Client } from './helpers.ts';
import { all, one, openDb, run, stmt } from '../server/db/db.ts';
import { tick } from '../server/services/outbox.ts';
import { simPayer, internalWorklist } from '../server/connectors/executors.ts';
import { audit, FULL_REVERIFY_MS, verifyChain, verifyChainIncremental } from '../server/services/audit.ts';
import { priorityOf, type AccountRow } from '../server/services/workflow.ts';
import { newId, setClock } from '../server/util.ts';
import { syntheticAccounts, synthetic835, toCsv } from '../scripts/synthetic-inventory.ts';

const tempDb = () => { const dir = mkdtempSync(join(tmpdir(), 'ar-stressfix-')); return { dir, path: join(dir, 'ar.db') }; };

function rawPost(base: string, path: string, token: string, opts: { bytes: number; declare: boolean }): Promise<{ status: number; body: any; error?: string }> {
  const url = new URL(path, base);
  return new Promise((resolve) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'x-tenant': 'tn_demo', 'x-client': 'cl_ortho', 'content-type': 'application/json' };
    if (opts.declare) headers['content-length'] = String(opts.bytes);
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(t) }));
    });
    req.on('error', (e) => resolve({ status: 0, body: null, error: (e as NodeJS.ErrnoException).code }));
    const piece = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = () => { while (sent < opts.bytes) { const n = Math.min(piece.length, opts.bytes - sent); sent += n; if (!req.write(piece.subarray(0, n))) { req.once('drain', pump); return; } } req.end(); };
    pump();
  });
}

test('oversized body: a readable 413 (declared and chunked), not a connection reset', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    for (const declare of [true, false]) {
      const r = await rawPost(h.base, '/api/imports/preview', ana.token, { bytes: 3_000_000, declare });
      assert.equal(r.error, undefined, `transport error ${r.error} (declare=${declare})`);
      assert.equal(r.status, 413);
      assert.equal(r.body.error.code, 'too_large');
    }
    assert.equal((await ana.get('/api/accounts')).status, 200, 'server keeps serving after refusing');
  } finally { await h.close(); }
});

test('malformed percent-encoding in a path parameter is a 400, not a 500', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    for (const p of ['/api/accounts/%E0%A4%A', '/api/accounts/%', '/api/calls/%C0%AF']) {
      const r = await ana.get(p);
      assert.equal(r.status, 400, p);
      assert.equal(r.body.error.code, 'invalid_request');
    }
  } finally { await h.close(); }
});

test('queue ranking and paging in SQL match priorityOf; page parameters are clamped', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    await importCohort(ana);
    await ana.post('/api/imports', { sourceName: 'bulk.csv', csv: toCsv(syntheticAccounts(260, { batch: 'RANK', seed: 11 })) });
    // Move accounts into several states so state weights, age and balance all matter.
    for (const ext of ['SYN-1041', 'SYN-1042', 'SYN-1043', 'SYN-1044', 'SYN-1045']) await ana.post(`/api/accounts/${await accountByExt(ana, ext)}/investigate`);
    const rows = all<AccountRow>(h.db, `SELECT * FROM accounts WHERE tenant_id='tn_demo' AND client_id='cl_ortho'`);
    const expected = rows.map((a) => ({ ext: a.external_id, score: priorityOf(a).score }))
      .sort((x, y) => y.score - x.score || x.ext.localeCompare(y.ext)).map((x) => x.ext);
    const seen: string[] = [];
    for (let page = 1; seen.length < rows.length; page++) {
      const r = await ana.get(`/api/accounts?pageSize=100&page=${page}`);
      assert.equal(r.body.total, rows.length);
      for (const it of r.body.items) {
        const row = rows.find((a) => a.account_id === it.accountId)!;
        assert.equal(it.priority.score, priorityOf(row).score);
      }
      seen.push(...r.body.items.map((i: any) => i.externalId));
      if (!r.body.items.length) break;
    }
    assert.deepEqual(seen, expected);
    const clamp = async (qs: string) => (await ana.get(`/api/accounts?${qs}`)).body;
    assert.equal((await clamp('pageSize=-1')).pageSize, 25);
    assert.equal((await clamp('pageSize=100000')).pageSize, 100);
    assert.equal((await clamp('pageSize=abc')).items.length, 25);
    assert.equal((await clamp('page=-3')).page, 1);
    const ready = (await clamp('view=not_started&pageSize=100')).items as any[];
    assert.ok(ready.length > 0 && ready.every((i) => i.state === 'ready'));
  } finally { await h.close(); }
});

test('an 835 with more than 500 service lines ingests (it previewed and then failed with a 400)', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    const sam = await h.as('u_sam');
    const accounts = syntheticAccounts(600, { batch: 'ERA', seed: 5 }).map((a) => ({ ...a, payerId: 'demo-payer' }));
    assert.equal((await ana.post('/api/imports', { sourceName: 'era-accounts.csv', csv: toCsv(accounts) })).body.summary.accepted, 600);
    const content = synthetic835(accounts);
    const pv = await sam.post('/api/integrations/edi/preview', { filename: 'big.edi', content });
    assert.equal(pv.status, 200);
    assert.equal(pv.body.summary.matched, 600);
    const ing = await sam.post('/api/integrations/edi/ingest', { filename: 'big.edi', content, expectedSha256: pv.body.rawSha256 });
    assert.equal(ing.status, 200, JSON.stringify(ing.body.error));
    assert.equal(ing.body.report.remittance.lines, 600);
  } finally { await h.close(); }
});

const approve = (c: Client, act: any, revision: number) =>
  c.post(`/api/actions/${act.actionId}/review`, { decision: 'approved', rationale: 'Stress regression approval', payloadSha256: act.payloadSha256, accountRevision: revision });

test('outbox: a dispatcher acting on a stale snapshot never overwrites a row another dispatcher sent', async () => {
  const { dir, path } = tempDb();
  const h = await start(path);
  const second = openDb(path); // a second worker process's connection
  const orig = { sim: simPayer.submit, wl: internalWorklist.submit };
  try {
    const ana = await h.as('u_ana');
    const rui = await h.as('u_rui');
    await importCohort(ana);
    for (const ext of ['SYN-1042', 'SYN-1043']) {
      const id = await accountByExt(ana, ext);
      await ana.post(`/api/accounts/${id}/investigate`);
      const v = (await ana.get(`/api/accounts/${id}`)).body;
      assert.equal((await approve(rui, v.actions[0], v.account.revision)).status, 200);
    }
    assert.equal(all(h.db, `SELECT 1 FROM action_outbox WHERE state='pending'`).length, 2);
    // Worker B snapshots both pending rows, then, while its first connector call is in flight,
    // worker A (another connection) ticks and sends the second row end to end.
    let nested = false;
    const during = function (this: unknown, orig: typeof simPayer.submit) {
      return function (this: unknown, ...args: Parameters<typeof simPayer.submit>) {
        if (!nested) { nested = true; tick(h.db); }
        return orig.apply(this, args);
      };
    };
    simPayer.submit = during(orig.sim);
    internalWorklist.submit = during(orig.wl);
    tick(second);
    const rows = all<{ action_id: string; state: string }>(h.db, 'SELECT action_id, state FROM action_outbox');
    for (const r of rows) assert.ok(['accepted', 'confirmed'].includes(r.state), `outbox ${r.action_id} is ${r.state}`);
    assert.equal(all(h.db, `SELECT 1 FROM audit_events WHERE event_type='dispatch_blocked'`).length, 0, 'no false dispatch_blocked');
    assert.equal(all(h.db, `SELECT 1 FROM audit_events WHERE event_type='action_dispatched'`).length, 2, 'each action claimed once');
  } finally {
    simPayer.submit = orig.sim;
    internalWorklist.submit = orig.wl;
    second.close();
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit chain stays intact when two processes append outside a transaction', async () => {
  const { dir, path } = tempDb();
  const db = openDb(path);
  try {
    const auditUrl = new URL('../server/services/audit.ts', import.meta.url).href;
    const dbUrl = new URL('../server/db/db.ts', import.meta.url).href;
    const script = `import { openDb } from '${dbUrl}'; import { audit } from '${auditUrl}';
      const db = openDb(process.argv[1]);
      for (let i = 0; i < 1500; i++) audit(db, { tenantId: 'tn_x', clientId: 'cl_x', actorId: 'p' + process.pid, objectType: 'test', objectId: String(i), eventType: 'stress_append' });`;
    const runOne = () => new Promise<number>((resolve) => {
      const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script, path], { stdio: 'inherit' });
      c.on('exit', (code) => resolve(code ?? -1));
    });
    const codes = await Promise.all([runOne(), runOne()]);
    assert.deepEqual(codes, [0, 0]);
    const chain = verifyChain(db, 'tn_x');
    assert.equal(chain.events, 3000);
    assert.ok(chain.ok, `chain broken at ${chain.brokenAt}`);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot lookups use indexes (audit head, claim match, proposals by account, outbox by state)', () => {
  const db = openDb(':memory:');
  const plan = (sql: string) => all<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${sql}`).map((r) => r.detail).join(' | ');
  const head = plan(`SELECT event_hash FROM audit_events WHERE tenant_id = 't' ORDER BY seq DESC LIMIT 1`);
  assert.match(head, /audit_tenant_seq/);
  assert.doesNotMatch(head, /TEMP B-TREE/);
  assert.match(plan(`SELECT account_id FROM accounts WHERE tenant_id='t' AND client_id='c' AND claim_reference='x'`), /accounts_claim_reference/);
  assert.match(plan(`SELECT account_id FROM accounts WHERE tenant_id='t' AND client_id='c' AND patient_token='x'`), /accounts_patient_token/);
  assert.match(plan(`SELECT kind FROM proposed_actions WHERE tenant_id='t' AND client_id='c' AND account_id='a' ORDER BY created_at DESC LIMIT 1`), /proposed_actions_account/);
  assert.match(plan(`SELECT * FROM action_outbox WHERE state='pending' ORDER BY created_at`), /action_outbox_state/);
  assert.match(plan(`SELECT fact_key FROM observations WHERE tenant_id='t' AND client_id='c' AND account_id='a' ORDER BY observed_at, rowid`), /observations_account/);
  const ledger = plan(`SELECT entry_hash FROM outcome_ledger WHERE tenant_id='t' ORDER BY seq DESC LIMIT 1`);
  assert.match(ledger, /ledger_tenant_seq/);
  assert.doesNotMatch(ledger, /TEMP B-TREE/);
  assert.match(plan(`SELECT paid_cents FROM remittance_lines WHERE tenant_id='t' AND client_id='c' AND account_id='a' AND line_number=1 AND status <> 'reversal' ORDER BY rowid DESC LIMIT 1`), /remittance_lines_account/);
  assert.match(plan(`SELECT actor_id FROM review_decisions WHERE tenant_id='t' AND client_id='c' AND action_id='x' AND decision='approved'`), /review_decisions_action/);
  db.close();
});

test('prepared statements are cached per SQL text and the cache is bounded', () => {
  const db = openDb(':memory:');
  const first = stmt(db, 'SELECT 1 AS n');
  assert.equal(stmt(db, 'SELECT 1 AS n'), first);
  for (let i = 0; i < 1000; i++) stmt(db, `SELECT ${i + 2} AS n`);
  assert.notEqual(stmt(db, 'SELECT 1 AS n'), first, 'oldest entry evicted once the bound is reached');
  assert.equal(one<{ n: number }>(db, 'SELECT 7 AS n')!.n, 7);
  db.close();
});

test('pooled identifiers stay unique and well-formed', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100_000; i++) ids.add(newId('x'));
  assert.equal(ids.size, 100_000);
  for (const id of [...ids].slice(0, 2000)) assert.match(id, /^x_[A-Za-z0-9_-]{12}$/);
});

test('incremental chain check: new tampering is caught at once, old-row edits by the periodic full walk', () => {
  const db = openDb(':memory:');
  const t0 = Date.parse('2026-10-14T10:00:00Z');
  setClock(() => new Date(t0));
  try {
    for (let i = 0; i < 50; i++) audit(db, { tenantId: 'tn_c', clientId: 'cl_c', actorId: 'u', objectType: 'test', objectId: String(i), eventType: 'e' });
    assert.equal(verifyChainIncremental(db, 'tn_c').mode, 'full');
    for (let i = 0; i < 5; i++) audit(db, { tenantId: 'tn_c', clientId: 'cl_c', actorId: 'u', objectType: 'test', objectId: `n${i}`, eventType: 'e' });
    const inc = verifyChainIncremental(db, 'tn_c');
    assert.deepEqual([inc.ok, inc.mode, inc.events], [true, 'incremental', 55]);
    // A forged event appended outside audit(): caught by the incremental step.
    run(db, `INSERT INTO audit_events (tenant_id, client_id, event_id, actor_id, object_type, object_id, account_id, event_type, event_at, details, prev_hash, event_hash)
      VALUES ('tn_c','cl_c','evt_forged','x','test','f',NULL,'e','2026-10-14T10:00:00Z','{}','${'0'.repeat(64)}','${'1'.repeat(64)}')`);
    assert.equal(verifyChainIncremental(db, 'tn_c').ok, false);
    db.exec('DROP TRIGGER audit_no_delete');
    run(db, `DELETE FROM audit_events WHERE event_id='evt_forged'`);
    assert.equal(verifyChainIncremental(db, 'tn_c').ok, true);
    // An out-of-band edit to an old row (triggers bypassed): found by the full walk once it is due.
    db.exec('DROP TRIGGER audit_no_update');
    run(db, `UPDATE audit_events SET details='{"edited":true}' WHERE object_id='3' AND tenant_id='tn_c'`);
    assert.equal(verifyChainIncremental(db, 'tn_c').mode, 'incremental');
    setClock(() => new Date(t0 + FULL_REVERIFY_MS + 1000));
    const due = verifyChainIncremental(db, 'tn_c');
    assert.deepEqual([due.ok, due.mode], [false, 'full']);
    assert.equal(verifyChain(db, 'tn_c').ok, false);
  } finally {
    setClock(null);
    db.close();
  }
});

test('opening the database waits for a lock held by another process instead of failing at startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-lock-'));
  const path = join(dir, 'ar.db');
  try {
    // Another process creates the file (rollback journal) and holds an exclusive lock for 400 ms.
    const script = `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]);
db.exec('CREATE TABLE t (x); BEGIN EXCLUSIVE; INSERT INTO t VALUES (1);');
process.stdout.write('locked\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
db.exec('COMMIT'); db.close();`;
    const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script, path], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((r) => c.once('exit', r));
    await new Promise<void>((res, rej) => { c.stdout!.on('data', (d) => { if (String(d).includes('locked')) res(); }); void exited.then(() => rej(new Error('lock holder exited early'))); });
    const db = openDb(path); // threw 'database is locked' while busy_timeout was set after journal_mode
    assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) n FROM t')!.n, 1);
    db.close();
    await exited;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
