// Starts the REAL server (server/main.ts) or the standalone worker (server/worker.ts) as a
// child process against a temporary SQLite file, exactly as an operator would run them.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PROBE = fileURLToPath(new URL('./probe.ts', import.meta.url));

export interface ProbeSample { t: number; rss: number; heapUsed: number; external: number; elP50: number; elP99: number; elMax: number }

export interface Proc {
  name: string;
  child: ChildProcess;
  pid: number;
  probeFile: string;
  output: () => string;
  /** Graceful stop (SIGTERM), resolves on exit. */
  stop: () => Promise<number | null>;
  /** Crash: SIGKILL, no cleanup runs. */
  kill: () => Promise<number | null>;
  alive: () => boolean;
  samples: () => ProbeSample[];
}

export function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ar-stress-${label}-`));
}

export function removeDir(dir: string) {
  if (process.env.STRESS_KEEP === '1') { console.log(`[stress] kept ${dir}`); return; }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

// Children are killed if the harness itself is interrupted, so no server outlives a run.
const live = new Set<ChildProcess>();
const reap = () => { for (const c of live) c.kill('SIGKILL'); };
process.on('exit', reap);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { reap(); process.exit(130); });

function launch(name: string, script: string, env: Record<string, string>, dir: string): Proc {
  const probeFile = join(dir, `${name}-probe.jsonl`);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PROBE, script], {
    cwd: ROOT, env: { ...process.env, ...env, AR_STRESS_PROBE: probeFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.add(child);
  child.on('exit', () => live.delete(child));
  let out = '';
  const keep = (b: Buffer) => { out += b.toString(); if (out.length > 200_000) out = out.slice(-100_000); };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  let exited = false;
  let code: number | null = null;
  const done = new Promise<number | null>((r) => child.on('exit', (c, sig) => { exited = true; code = c ?? (sig ? -1 : null); r(code); }));
  const signal = (sig: NodeJS.Signals) => { if (!exited) child.kill(sig); return done; };
  return {
    name, child, pid: child.pid!, probeFile, output: () => out,
    stop: () => signal('SIGTERM'), kill: () => signal('SIGKILL'), alive: () => !exited,
    samples: () => existsSync(probeFile) ? readFileSync(probeFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as ProbeSample) : [],
  };
}

// waitHealthy: false returns as soon as the process is spawned. The crash scenario needs it: an
// embedded worker tick with a slow synchronous connector can block the event loop (and so the
// health check) until the whole batch is dispatched, which is the window it wants to kill in.
export interface ServerOpts { dbPath: string; dir: string; worker?: boolean; env?: Record<string, string>; name?: string; waitHealthy?: boolean }

export async function startServer(o: ServerOpts): Promise<Proc & { base: string; port: number }> {
  const port = await freePort();
  const p = launch(o.name ?? 'server', 'server/main.ts', {
    AR_DB: o.dbPath, PORT: String(port), AR_WORKER: o.worker ? 'on' : 'off', AR_SIM_PAYER_ALWAYS_OPEN: '1', ...(o.env ?? {}),
  }, o.dir);
  const base = `http://127.0.0.1:${port}`;
  if (o.waitHealthy === false) return { ...p, base, port };
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (!p.alive()) throw new Error(`server exited during startup:\n${p.output()}`);
    try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { await p.kill(); throw new Error(`server did not start:\n${p.output()}`); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ...p, base, port };
}

export function startWorker(o: { dbPath: string; dir: string; name: string; env?: Record<string, string> }): Proc {
  return launch(o.name, 'server/worker.ts', { AR_DB: o.dbPath, AR_SIM_PAYER_ALWAYS_OPEN: '1', ...(o.env ?? {}) }, o.dir);
}

export function dbBytes(dbPath: string): { db: number; wal: number } {
  const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);
  return { db: size(dbPath), wal: size(`${dbPath}-wal`) };
}
