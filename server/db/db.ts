import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;

// Migrations are applied in filename order. Workstreams own distinct number ranges
// (001 core, 010 knowledge base, 020 rules, 030 integrations, 040 operations, 050 voice).
const MIGRATIONS = readdirSync(fileURLToPath(new URL('.', import.meta.url))).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  // busy_timeout first: the journal_mode pragma needs a lock, and without a busy handler a process
  // starting while another holds the lock (or is recovering the WAL after a crash) fails at once
  // with 'database is locked' (ADR 0095: a restart after a SIGKILL failed this way).
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const name of MIGRATIONS) {
    const done = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name);
    if (done) continue;
    const sql = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
    tx(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(name, new Date().toISOString());
    });
  }
  return db;
}

/** Migration files not yet recorded as applied (readiness check, ADR 0090). */
export function pendingMigrations(db: Db): string[] {
  const done = new Set((db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name));
  return MIGRATIONS.filter((m) => !done.has(m));
}

let depth = 0;

// BEGIN IMMEDIATE takes the write lock up front so check-then-update sequences
// (approval, outbox claim) cannot interleave with another process.
export function tx<T>(db: Db, fn: () => T): T {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

// Prepared-statement cache (ADR 0095): compiling the same SQL on every call was the largest
// single cost in bulk import and queue reads. Bounded, so SQL built with inline values
// cannot grow it without limit; SQLite re-prepares a cached statement after a schema change.
const STATEMENT_CACHE_MAX = 1000;
const statements = new WeakMap<Db, Map<string, StatementSync>>();
export function stmt(db: Db, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    if (cache.size >= STATEMENT_CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(sql, s);
  }
  return s;
}

export function one<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return stmt(db, sql).get(...(params as never[])) as T | undefined;
}

export function all<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return stmt(db, sql).all(...(params as never[])) as T[];
}

export function run(db: Db, sql: string, ...params: unknown[]): number {
  return Number(stmt(db, sql).run(...(params as never[])).changes);
}
