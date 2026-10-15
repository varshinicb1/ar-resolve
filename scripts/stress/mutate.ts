// Mutation check for the ADR 0095 regression tests: re-introduce each defect, run the test that
// guards it, and confirm the test fails; then restore the file. Run: node scripts/stress/mutate.ts
// Each file is restored byte for byte after its mutation.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { ROOT } from './lib/proc.ts';

interface Mutation { name: string; file: string; from: string | RegExp; to: string; test: string; suite?: string }

const CS = 'tests/connector-settings.test.ts';
const CSF = 'server/connectors/live/connector-settings.ts';
const M: Mutation[] = [
  { name: 'destroy the socket on an oversized body', file: 'server/http/app.ts', from: '{ reject(refuseBody(req, MAX_BODY)); return; }\n    let size', to: '{ reject(new AppError(413, "too_large", "x")); req.destroy(); return; }\n    let size', test: 'oversized body' },
  { name: 'decodeURIComponent without a guard', file: 'server/http/app.ts', from: 'try { return decodeURIComponent(v); } catch { throw invalid', to: 'try { return decodeURIComponent(v); } finally { void invalid', test: 'malformed percent-encoding' },
  { name: 'age computed as a float in the SQL ranking', file: 'server/services/workflow.ts', from: 'COALESCE(CAST((?1 - (julianday(service_date) - 2440587.5) * 86400000) / 86400000 AS INTEGER), 0)', to: 'COALESCE((?1 - (julianday(service_date) - 2440587.5) * 86400000) / 86400000, 0)', test: 'queue ranking' },
  { name: 'wrong state weight in the SQL ranking', file: 'server/services/workflow.ts', from: "WHEN '${s}' THEN ${w}", to: "WHEN '${s}' THEN ${w === 40 ? 5 : w}", test: 'queue ranking' },
  { name: 'unclamped pageSize', file: 'server/services/workflow.ts', from: 'Number.isFinite(n) && n >= 1 ? Math.min(max, n) : def', to: 'Number.isFinite(n) ? Math.min(max, n) : def', test: 'queue ranking' },
  { name: '500-line cap on ingested 835s', file: 'server/connectors/remit-835.ts', from: 'export const MAX_835_LINES = 50_000;', to: 'export const MAX_835_LINES = 500;', test: 'more than 500 service lines' },
  { name: 'claim on a stale outbox snapshot', file: 'server/services/outbox.ts', from: "if (!stillIn(db, o, 'pending')) return RACED;", to: "if (!stillIn(db, o, 'pending') && false) return RACED;", test: 'stale snapshot' },
  { name: 'audit append outside a transaction', file: 'server/services/audit.ts', from: 'return tx(db, () => appendAudit(db, e));', to: 'return appendAudit(db, e);', test: 'two processes append' },
  { name: 'missing audit_tenant_seq index', file: 'server/db/095_stress_indexes.sql', from: 'CREATE INDEX IF NOT EXISTS audit_tenant_seq ON audit_events (tenant_id, seq);', to: '', test: 'hot lookups use indexes' },
  { name: 'missing observations_account index', file: 'server/db/095_stress_indexes.sql', from: 'CREATE INDEX IF NOT EXISTS observations_account ON observations (tenant_id, client_id, account_id);', to: '', test: 'hot lookups use indexes' },
  { name: 'incremental check skips new rows', file: 'server/services/audit.ts', from: "'SELECT * FROM audit_events WHERE tenant_id = ? AND seq > ? ORDER BY seq', tenantId, cp.seq", to: "'SELECT * FROM audit_events WHERE tenant_id = ? AND seq > ? AND 0 ORDER BY seq', tenantId, cp.seq", test: 'incremental chain check' },
  { name: 'busy_timeout set after journal_mode', file: 'server/db/db.ts', from: "db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');", to: "db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');", test: 'waits for a lock' },
  { name: 'statement cache unbounded', file: 'server/db/db.ts', from: 'if (cache.size >= STATEMENT_CACHE_MAX)', to: 'if (false)', test: 'prepared statements' },
  // ADR 0110 Connect providers: each gate re-opened on its own must fail its test.
  { name: 'stored value beats the environment', file: 'server/connectors/live/config.ts', from: 'if (v === undefined || envProvides(k, base)) continue;', to: 'if (v === undefined) continue;', test: 'environment beats', suite: CS },
  { name: 'secret stored without a sealing key outside synthetic', file: CSF, from: "if (!store?.synthetic) throw new AppError(409, 'sealing_key_missing'", to: "if (false) throw new AppError(409, 'sealing_key_missing'", test: 'outside synthetic', suite: CS },
  { name: 'secret stored unsealed', file: CSF, from: 'const stored = s.secret ? seal(s.value, ring!) : s.value;', to: 'const stored = s.value;', test: 'seals the secret', suite: CS },
  { name: 'production mode allowed in synthetic', file: CSF, from: "if (mode === 'production' && (!store || store.synthetic))", to: "if (false && mode === 'production')", test: 'production mode is refused in synthetic', suite: CS },
  { name: 'test runs in production mode', file: 'server/connectors/live/smoke.ts', from: "if (mode === 'production') return [", to: 'if (false) return [', test: 'refuses production', suite: CS },
  { name: 'test not rate limited', file: CSF, from: 'if (wait > 0) throw', to: 'if (false) throw', test: 'rate limited', suite: CS },
  { name: 'settings without integration_admin', file: CSF, from: "function admin(scope: Scope) { requirePerm(scope, 'integration_admin'); }", to: 'function admin(_scope: Scope) { }', test: 'only integration_admin', suite: CS },
  { name: 'GET returns the secret instead of its last 4', file: CSF, from: "last4: v.secret && source === 'saved' ? row!.last4 || '' : null,", to: "last4: v.secret && source === 'saved' ? storedValues()[v.name] ?? '' : null,", test: 'synthetic without a sealing key', suite: CS },
  { name: 'audit row carries the values', file: CSF, from: 'details: { provider: p, changes: done } });', to: 'details: { provider: p, changes: done, values } });', test: '.', suite: CS },
  { name: 'any client supervisor edits deployment keys', file: 'server/http/routes/connector-settings.ts', from: 'if (!opts.deploymentAdmins.includes(s.userId)) {', to: 'if (false) {', test: 'AR_DEPLOYMENT_ADMINS may touch', suite: CS },
  { name: 'demo gate open without a password', file: 'deploy/cloudflare/gate.ts', from: 'return !!demoPassword && demoPassword.length >= MIN_PASSWORD_LENGTH;', to: 'return true;', test: 'locks the demo', suite: 'tests/cloudflare-gate.test.ts' },
  { name: 'demo gate ignores the cookie', file: 'deploy/cloudflare/gate.ts', from: 'if (got && await same(got, await gateToken(demoPassword))) return { ok: true };', to: 'if (got) return { ok: true };', test: 'anything else is 401', suite: 'tests/cloudflare-gate.test.ts' },
  { name: 'demo gate accepts any password', file: 'deploy/cloudflare/gate.ts', from: 'if (await same(submitted, demoPassword)) return { ok: true };', to: 'return { ok: true };', test: 'anything else is 401', suite: 'tests/cloudflare-gate.test.ts' },
  { name: 'stored key not used by the adapter', file: 'server/connectors/live/config.ts', from: 'const stored = storedSource ? storedSource() : null;', to: 'const stored = null as Env | null;', test: 'used end to end', suite: CS },
];

let failures = 0;
for (const m of M) {
  const path = `${ROOT}${m.file}`;
  const orig = readFileSync(path, 'utf8');
  if (!orig.includes(m.from as string)) { console.log(`SKIP (pattern not found): ${m.name}`); failures++; continue; }
  writeFileSync(path, orig.replace(m.from, m.to));
  try {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', `--test-name-pattern=${m.test}`, m.suite ?? 'tests/stress-fixes.test.ts'], { cwd: ROOT, encoding: 'utf8' });
    const caught = r.status !== 0;
    console.log(`${caught ? 'CAUGHT ' : 'MISSED '} ${m.name}  (test: "${m.test}")`);
    if (!caught) failures++;
  } finally {
    writeFileSync(path, orig);
    if (readFileSync(path, 'utf8') !== orig) throw new Error(`could not restore ${m.file}`);
  }
}
console.log(failures ? `${failures} mutation(s) not caught` : 'every mutation was caught; files restored');
process.exit(failures ? 1 : 0);
