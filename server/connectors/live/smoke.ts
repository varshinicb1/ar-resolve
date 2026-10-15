// Smoke tests for live connectors (ADR 0100): `npm run smoke:live -- <provider> [--mock]`.
//
// Refuses (exit 2) unless the provider's mode is explicitly `sandbox` and its sandbox variables are
// present. Production mode is always refused: smoke tests never touch production endpoints or data.
// Every request uses vendor-documented test data only:
//   stedi    the documented UnitedHealthcare mock eligibility request (Stedi mock requests page and
//            OpenAPI example EligibilityRawX12Check_example1), sent verbatim. Claim status is skipped:
//            Stedi documents no test mode for it.
//   optum    Optum's predefined sandbox values (OP5, OP6, OP7).
//   availity token request, plus a Coverages call when AR_AVAILITY_MOCK_SCENARIO_ID names a demo scenario.
//   twilio   test credentials with Twilio's documented magic numbers (no call is placed or charged).
//   postmark the documented POSTMARK_API_TEST token (validated, never delivered).
//   slack    one fixed synthetic line to the configured test-channel webhook (Slack has no test mode).
// Results (pass/fail per check, short error text, never secrets) are stored in live_smoke_runs.
import type { Db } from '../../db/db.ts';
import { newId, nowIso } from '../../util.ts';
import { parseEdi } from '../x12/index.ts';
import { PROVIDERS, SPECS, isProvider, liveEnv, missingVars, modeOf, readVar, type ProviderId } from './config.ts';
import { STEDI_PATHS } from './stedi.ts';
import { OPTUM_PATHS } from './optum.ts';
import { coverageInquiry } from './availity.ts';
import { testCall } from './twilio.ts';
import { postmarkSend, slackPost } from './notify.ts';
import { clearTokenCache, clientCredentialsToken, errorSummary, httpRequest } from './http.ts';
import { baseUrl } from './config.ts';
import { stediFixture } from './mock-server.ts';

export interface SmokeCheck { name: string; required: boolean; outcome: 'pass' | 'fail' | 'skipped'; detail: string; latencyMs?: number }
export interface SmokeReport { provider: string; mode: string; target: 'vendor_sandbox' | 'local_mock' | 'none'; outcome: 'pass' | 'fail' | 'refused'; reasons: string[]; checks: SmokeCheck[]; runId?: string }

const OPTUM_ELIGIBILITY_SAMPLE = {
  // Predefined sandbox values (OP7) in the shape of the OP6 sample; 00001 = "Single coverage plan".
  controlNumber: '000000001', tradingPartnerServiceId: '00001',
  provider: { organizationName: 'happy doctors group', npi: '0123456789' },
  subscriber: { memberId: '0000000001', firstName: 'johnone', lastName: 'doeone', dateOfBirth: '18800102', gender: 'm' },
  encounter: { dateOfService: '20100101' },
};
const OPTUM_CLAIM_STATUS_SAMPLE = {
  // OP5 sample body with the OP7 test payer 00003 ("Accepted and paid").
  controlNumber: '000000001', tradingPartnerServiceId: '00003',
  providers: [{ organizationName: 'TestProvider', taxId: '0123456789', providerType: 'BillingProvider' }, { organizationName: 'happy doctors group', npi: '1760854442', providerType: 'ServiceProvider' }],
  subscriber: { memberId: '0000000000', firstName: 'johnone', lastName: 'doeone', gender: 'M', dateOfBirth: '18800102', groupNumber: '0000000000' },
  encounter: { beginningDateOfService: '20100101', endDateOfService: '20100102', trackingNumber: 'ABCD' },
};

async function check(name: string, required: boolean, fn: () => Promise<{ ok: boolean; detail: string } | { skip: string }>): Promise<SmokeCheck> {
  const started = Date.now();
  try {
    const r = await fn();
    if ('skip' in r) return { name, required, outcome: 'skipped', detail: r.skip };
    return { name, required, outcome: r.ok ? 'pass' : 'fail', detail: r.detail.slice(0, 300), latencyMs: Date.now() - started };
  } catch (err) {
    return { name, required, outcome: 'fail', detail: (err as Error).message.slice(0, 300), latencyMs: Date.now() - started };
  }
}

async function stediChecks(): Promise<SmokeCheck[]> {
  const hc = baseUrl('stedi', 'healthcare').url!;
  const core = baseUrl('stedi', 'core').url!;
  const key = readVar('AR_STEDI_API_KEY')!;
  return [
    await check('eligibility: documented UHC mock request (raw X12 270 -> 271)', true, async () => {
      const x12 = stediFixture('eligibility-raw-x12.request.uhc-mock.json').value.x12 as string;
      const r = await httpRequest({ method: 'POST', url: hc + STEDI_PATHS.eligibilityRawX12, headers: { authorization: key, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ x12 }), idempotentRead: true, timeoutMs: 60_000 });
      if (r.status !== 200) return { ok: false, detail: errorSummary(r) };
      const out = (r.json as { x12?: unknown })?.x12;
      if (typeof out !== 'string') return { ok: false, detail: 'No x12 in the response' };
      const sets = parseEdi(out).transactions.map((t) => t.setId);
      return { ok: sets.includes('271'), detail: `HTTP 200, answer sets ${sets.join(', ')} (parsed by the strict X12 parser)` };
    }),
    await check('claim status (276/277)', false, async () => ({ skip: 'Stedi documents no test mode for real-time claim status (production keys only, ST3/ST4).' })),
    await check('835 ERA polling: GET /polling/transactions', false, async () => {
      const r = await httpRequest({ method: 'GET', url: `${core}${STEDI_PATHS.pollTransactions}?pageSize=1&startDateTime=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`, headers: { authorization: key, accept: 'application/json' }, idempotentRead: true, timeoutMs: 20_000 });
      const ok = r.status === 200 && Array.isArray((r.json as { items?: unknown })?.items);
      return { ok, detail: ok ? `HTTP 200, ${(r.json as { items: unknown[] }).items.length} item(s) (whether test keys may poll is not stated in the docs; informational)` : errorSummary(r) };
    }),
  ];
}

async function optumChecks(): Promise<SmokeCheck[]> {
  const b = baseUrl('optum', 'api').url!;
  let token = '';
  const out = [await check('OAuth token (client_credentials, JSON body)', true, async () => {
    token = await clientCredentialsToken({ cacheKey: `smoke:optum:${Date.now()}`, tokenUrl: b + OPTUM_PATHS.token, timeoutMs: 15_000,
      json: { client_id: readVar('AR_OPTUM_CLIENT_ID')!, client_secret: readVar('AR_OPTUM_CLIENT_SECRET')!, grant_type: 'client_credentials' } });
    return { ok: !!token, detail: 'Bearer token issued' };
  })];
  const post = (path: string, body: unknown) => httpRequest({ method: 'POST', url: b + path, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), idempotentRead: true, timeoutMs: 30_000 });
  out.push(await check('eligibility v3 with predefined sandbox values (payer 00001)', true, async () => {
    if (!token) return { skip: 'No token' };
    const r = await post(OPTUM_PATHS.eligibility, OPTUM_ELIGIBILITY_SAMPLE);
    const j = r.json as { planStatus?: unknown; benefitsInformation?: unknown } | null;
    return { ok: r.status === 200 && !!j && (Array.isArray(j.planStatus) || Array.isArray(j.benefitsInformation)), detail: r.status === 200 ? 'HTTP 200 with planStatus/benefitsInformation' : errorSummary(r) };
  }));
  out.push(await check('claim status v2 with predefined sandbox values (payer 00003)', true, async () => {
    if (!token) return { skip: 'No token' };
    const r = await post(OPTUM_PATHS.claimStatus, OPTUM_CLAIM_STATUS_SAMPLE);
    const cat = (r.json as { claims?: { claimStatus?: { statusCategoryCode?: string } }[] })?.claims?.[0]?.claimStatus?.statusCategoryCode;
    return { ok: r.status === 200 && typeof cat === 'string', detail: r.status === 200 ? `HTTP 200, status category ${cat ?? 'missing'}` : errorSummary(r) };
  }));
  return out;
}

async function availityChecks(): Promise<SmokeCheck[]> {
  const b = baseUrl('availity', 'api').url!;
  const out = [await check('OAuth token (client_credentials, scope=hipaa)', true, async () => {
    const t = await clientCredentialsToken({ cacheKey: `smoke:availity:${Date.now()}`, tokenUrl: `${b}/token`, timeoutMs: 15_000,
      form: { grant_type: 'client_credentials', client_id: readVar('AR_AVAILITY_CLIENT_ID')!, client_secret: readVar('AR_AVAILITY_CLIENT_SECRET')!, scope: 'hipaa' } });
    return { ok: !!t, detail: 'Bearer token issued (valid 5 minutes per AV1)' };
  })];
  out.push(await check('Coverages call with a demo scenario', false, async () => {
    if (!readVar('AR_AVAILITY_MOCK_SCENARIO_ID')) return { skip: 'Set AR_AVAILITY_MOCK_SCENARIO_ID to a scenario id from the Coverages API reference to run this check.' };
    const r = await coverageInquiry({}, 30_000);
    const mock = (r.normalized as { mock?: boolean } | undefined)?.mock;
    return { ok: r.outcome === 'success', detail: r.outcome === 'success' ? `statusCode ${(r.normalized as { statusCode?: string }).statusCode}; X-Api-Mock-Response ${mock ? 'true' : 'absent'}` : `${r.outcome}: ${r.error}` };
  }));
  return out;
}

async function twilioChecks(): Promise<SmokeCheck[]> {
  return [
    await check('test call accepted (From +15005550006 to +14108675310)', true, async () => {
      const r = await testCall('+14108675310', 15_000);
      return { ok: r.outcome === 'success', detail: r.outcome === 'success' ? `call resource returned (sid ${String((r.normalized as { sid?: string }).sid).slice(0, 6)}...), not placed` : `${r.outcome}: ${r.error}` };
    }),
    await check('documented error: To +15005550001 -> 21217', true, async () => {
      const r = await testCall('+15005550001', 15_000);
      const code = (r.normalized as { code?: number } | undefined)?.code;
      return { ok: r.outcome === 'rejected' && code === 21217, detail: `${r.outcome}, code ${code ?? 'none'}` };
    }),
  ];
}

async function postmarkChecks(): Promise<SmokeCheck[]> {
  return [await check('send with POSTMARK_API_TEST (validated, not delivered)', true, async () => {
    const r = await postmarkSend({ to: [readVar('AR_POSTMARK_SMOKE_TO')!], subject: 'AR Resolve smoke test', text: 'AR Resolve smoke test. Synthetic; contains no patient data.' });
    return { ok: r.ok, detail: r.ok ? `ErrorCode 0, MessageID returned` : r.error ?? 'failed' };
  })];
}

async function slackChecks(): Promise<SmokeCheck[]> {
  return [await check('post one synthetic line to the test-channel webhook', true, async () => {
    const r = await slackPost(readVar('AR_SLACK_WEBHOOK_URL')!, 'AR Resolve smoke test (synthetic; no patient or account data).');
    return { ok: r.ok, detail: r.ok ? `HTTP ${r.status}` : r.error ?? 'failed' };
  })];
}

const RUNNERS: Record<ProviderId, () => Promise<SmokeCheck[]>> = { stedi: stediChecks, optum: optumChecks, availity: availityChecks, twilio: twilioChecks, postmark: postmarkChecks, slack: slackChecks };

/** Pure refusal logic, exported for tests: production and missing keys always refuse. */
export function smokeRefusals(p: string, env: Record<string, string | undefined> = liveEnv()): string[] {
  if (!isProvider(p)) return [`Unknown provider "${p}". Use one of: ${PROVIDERS.join(', ')}.`];
  const mode = modeOf(p, env);
  if (mode === 'production') return [`${SPECS[p].modeVar}=production: smoke tests run against vendor sandboxes only and never in production mode.`];
  if (mode === 'off') return [`${SPECS[p].modeVar} is not set to sandbox.`];
  const missing = missingVars(p, env);
  return missing.length ? [`Missing sandbox variables: ${missing.join(', ')}.`] : [];
}

export async function runSmoke(p: string, o: { db?: Db | null; target?: 'vendor_sandbox' | 'local_mock'; runBy?: string } = {}): Promise<SmokeReport> {
  const started = nowIso();
  const reasons = smokeRefusals(p);
  const mode = isProvider(p) ? modeOf(p) : 'off';
  let report: SmokeReport;
  if (reasons.length) report = { provider: p, mode, target: 'none', outcome: 'refused', reasons, checks: [] };
  else {
    clearTokenCache();
    const checks = await RUNNERS[p as ProviderId]();
    const failed = checks.filter((c) => c.required && c.outcome !== 'pass');
    report = { provider: p, mode, target: o.target ?? 'vendor_sandbox', outcome: failed.length ? 'fail' : 'pass', reasons: [], checks };
  }
  if (o.db && isProvider(p)) {
    report.runId = newId('smk');
    o.db.prepare('INSERT INTO live_smoke_runs VALUES (?,?,?,?,?,?,?,?,?)').run(report.runId, p, report.mode, report.target, report.outcome,
      JSON.stringify({ reasons: report.reasons, checks: report.checks }), started, nowIso(), o.runBy ?? 'smoke:live');
  }
  return report;
}

export function formatReport(r: SmokeReport): string {
  const lines = [`smoke:live ${r.provider} (mode ${r.mode}, target ${r.target}): ${r.outcome.toUpperCase()}`];
  for (const x of r.reasons) lines.push(`  refused: ${x}`);
  for (const c of r.checks) lines.push(`  [${c.outcome === 'pass' ? 'PASS' : c.outcome === 'skipped' ? 'SKIP' : 'FAIL'}]${c.required ? '' : ' (informational)'} ${c.name}: ${c.detail}${c.latencyMs !== undefined ? ` (${c.latencyMs} ms)` : ''}`);
  return lines.join('\n');
}
