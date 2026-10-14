// npm run smoke:live -- <provider> [--mock] [--no-record]
// Calls the provider's real SANDBOX with vendor-documented test data and prints a pass/fail report.
// Refuses (exit 2) without sandbox keys or when the provider is in production mode (ADR 0100).
// --mock runs the same checks against the local mock server instead (no keys needed; a rehearsal).
// Results are recorded in live_smoke_runs of the database at AR_DB (default data/ar-resolve.db) so the
// Integrations page can show the last result. Exit codes: 0 pass, 1 fail, 2 refused.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from '../server/db/db.ts';
import { formatReport, runSmoke } from '../server/connectors/live/smoke.ts';
import { SPECS, isProvider } from '../server/connectors/live/config.ts';
import { mockEnv, startLiveMock, type MockOptions } from '../server/connectors/live/mock-server.ts';
import { setFetchForTests } from '../server/connectors/live/http.ts';

const args = process.argv.slice(2);
const provider = args.find((a) => !a.startsWith('--')) ?? '';
const useMock = args.includes('--mock');
const record = !args.includes('--no-record');

let close: (() => Promise<void>) | null = null;
// A provider set to production is refused even for a mock rehearsal: the mock never masks production mode.
const production = isProvider(provider) && (process.env[SPECS[provider].modeVar] ?? '').toLowerCase() === 'production';
if (useMock && !production) {
  const opts: MockOptions = { stediKey: 'mock-test-key', optum: { id: 'mock-id', secret: 'mock-secret' }, availity: { id: 'mock-id', secret: 'mock-secret' }, twilio: { sid: 'ACmocktest0000000000', token: 'mock-token' } };
  const m = await startLiveMock(opts);
  // The mock replaces this provider's variables only; the owner's real variables are not read.
  const env = mockEnv(m, opts);
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  // Slack webhooks must be hooks.slack.com URLs; in a mock rehearsal they are redirected to the mock.
  setFetchForTests((url, init) => fetch(url.startsWith('https://hooks.slack.com/') ? `${m.url}/slack/${url.slice('https://hooks.slack.com/'.length)}` : url, init));
  close = () => m.close();
}

let db = null;
if (record) {
  const path = process.env.AR_DB ?? 'data/ar-resolve.db';
  mkdirSync(dirname(path), { recursive: true });
  db = openDb(path);
}
const report = await runSmoke(provider, { db, target: useMock ? 'local_mock' : 'vendor_sandbox', runBy: process.env.USER ? `smoke:live (${process.env.USER})` : 'smoke:live' });
console.log(formatReport(report));
if (close) await close();
db?.close();
process.exit(report.outcome === 'pass' ? 0 : report.outcome === 'fail' ? 1 : 2);
