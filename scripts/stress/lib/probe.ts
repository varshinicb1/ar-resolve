// Preloaded into the server or worker process under test (node --import). It never
// changes behaviour: it samples memory and event-loop delay once a second into a JSONL
// file named by AR_STRESS_PROBE, so the harness can report what the process itself saw.
//
// Optional, harness-only fault injection: AR_STRESS_CONNECTOR_DELAY_MS wraps the simulated
// connectors' submit() with a synchronous sleep (half before the send, half after) to
// imitate network latency, so a SIGKILL can land while a dispatch is in flight.
import { appendFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const file = process.env.AR_STRESS_PROBE;
if (file) {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const t = setInterval(() => {
    const m = process.memoryUsage();
    const line = { t: Date.now(), rss: m.rss, heapUsed: m.heapUsed, external: m.external,
      elP50: h.percentile(50) / 1e6, elP99: h.percentile(99) / 1e6, elMax: h.max / 1e6 };
    h.reset();
    try { appendFileSync(file, JSON.stringify(line) + '\n'); } catch { /* harness removed the dir */ }
  }, 1000);
  t.unref();
}

const delay = Number(process.env.AR_STRESS_CONNECTOR_DELAY_MS ?? 0);
if (delay > 0) {
  const { simPayer, internalWorklist } = await import('../../../server/connectors/executors.ts');
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const sleep = (ms: number) => { Atomics.wait(cell, 0, 0, ms); };
  for (const c of [simPayer, internalWorklist]) {
    const orig = c.submit;
    c.submit = function (this: typeof c, ...args: Parameters<typeof orig>) {
      sleep(delay / 2);
      const r = orig.apply(this, args);
      sleep(delay / 2);
      return r;
    };
  }
}
