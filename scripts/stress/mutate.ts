// Mutation check for the ADR 0095 regression tests: re-introduce each defect, run the test that
// guards it, and confirm the test fails; then restore the file. Run: node scripts/stress/mutate.ts
// Each file is restored byte for byte after its mutation.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { ROOT } from './lib/proc.ts';

interface Mutation { name: string; file: string; from: string | RegExp; to: string; test: string }

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
];

let failures = 0;
for (const m of M) {
  const path = `${ROOT}${m.file}`;
  const orig = readFileSync(path, 'utf8');
  if (!orig.includes(m.from as string)) { console.log(`SKIP (pattern not found): ${m.name}`); failures++; continue; }
  writeFileSync(path, orig.replace(m.from, m.to));
  try {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', `--test-name-pattern=${m.test}`, 'tests/stress-fixes.test.ts'], { cwd: ROOT, encoding: 'utf8' });
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
