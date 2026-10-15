// Live connector configuration (ADR 0100). This is the ONE place the real-integration
// workstream reads environment variables. Secrets are read at call time from the environment or
// from a file named by `<NAME>_FILE` (container secrets), never from the database, prompts or code.
//
// Every provider has an explicit mode variable: off (default), sandbox or production. Nothing runs
// in "off". Sandbox uses the vendor's documented test credentials or test plan with synthetic or
// vendor-documented test data only. Production also needs the connector live gate (authorization,
// covered-service verification, BAA, onboarding, non-synthetic environment) and the PHI gate.
//
// Base URLs below are the documented ones (sources in each provider module, retrieved 2026-10-14).
// Overrides exist so tests can point at local mock servers; a loopback override is accepted only
// when AR_LIVE_ALLOW_LOOPBACK=1, which only the test suite and local mock rehearsals set.
import { readFileSync } from 'node:fs';
import { safePublicHttpsUrl } from '../safe-url.ts';

export type Env = Record<string, string | undefined>;
export type LiveMode = 'off' | 'sandbox' | 'production';
export const PROVIDERS = ['stedi', 'availity', 'optum', 'twilio', 'slack', 'postmark'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface EnvVar { name: string; secret: boolean; required: LiveMode[]; note: string }

export interface ProviderSpec {
  id: ProviderId;
  connectorId: string;            // framework adapter id (authorization, events, circuit)
  label: string;
  modeVar: string;
  vars: EnvVar[];
  /** Documented base URLs per mode; null where the vendor documents none. */
  baseUrls: Record<'sandbox' | 'production', Record<string, string | null>>;
  overrideVars: Record<string, string>; // base URL key -> override env var
}

const both: LiveMode[] = ['sandbox', 'production'];

export const SPECS: Record<ProviderId, ProviderSpec> = {
  stedi: {
    id: 'stedi', connectorId: 'stedi', label: 'Stedi (eligibility 270/271, claim status 276/277, 835 ERA)', modeVar: 'AR_STEDI_MODE',
    vars: [{ name: 'AR_STEDI_API_KEY', secret: true, required: both, note: 'Sandbox: a Test-mode API key. Production: a production API key (paid plan, BAA accepted at upgrade).' }],
    // Stedi uses one host per API family for both key types; the key decides test vs production.
    baseUrls: {
      sandbox: { healthcare: 'https://healthcare.us.stedi.com/2024-04-01', core: 'https://core.us.stedi.com/2023-08-01' },
      production: { healthcare: 'https://healthcare.us.stedi.com/2024-04-01', core: 'https://core.us.stedi.com/2023-08-01' },
    },
    overrideVars: { healthcare: 'AR_STEDI_HEALTHCARE_BASE_URL', core: 'AR_STEDI_CORE_BASE_URL' },
  },
  availity: {
    id: 'availity', connectorId: 'availity', label: 'Availity (Coverages API, OAuth 2.0 client credentials)', modeVar: 'AR_AVAILITY_MODE',
    vars: [
      { name: 'AR_AVAILITY_CLIENT_ID', secret: false, required: both, note: 'From the Availity developer portal application (Demo plan for sandbox).' },
      { name: 'AR_AVAILITY_CLIENT_SECRET', secret: true, required: both, note: 'Application secret.' },
      { name: 'AR_AVAILITY_MOCK_SCENARIO_ID', secret: false, required: [], note: 'Optional, sandbox only: demo scenario id sent as X-Api-Mock-Scenario-ID (ids are in each API reference).' },
    ],
    baseUrls: { sandbox: { api: 'https://api.availity.com/availity/v1' }, production: { api: 'https://api.availity.com/availity/v1' } },
    overrideVars: { api: 'AR_AVAILITY_BASE_URL' },
  },
  optum: {
    id: 'optum', connectorId: 'optum_change_healthcare', label: 'Optum / Change Healthcare Medical Network (eligibility v3, claim status v2)', modeVar: 'AR_OPTUM_MODE',
    vars: [
      { name: 'AR_OPTUM_CLIENT_ID', secret: false, required: both, note: 'Sandbox client_id from the Optum sandbox access request; production after contract.' },
      { name: 'AR_OPTUM_CLIENT_SECRET', secret: true, required: both, note: 'Matching client_secret.' },
    ],
    baseUrls: { sandbox: { api: 'https://sandbox-apigw.optum.com' }, production: { api: 'https://apigw.optum.com' } },
    overrideVars: { api: 'AR_OPTUM_BASE_URL' },
  },
  twilio: {
    id: 'twilio', connectorId: 'twilio_voice', label: 'Twilio Programmable Voice (outbound payer calls)', modeVar: 'AR_TWILIO_MODE',
    vars: [
      { name: 'AR_TWILIO_TEST_ACCOUNT_SID', secret: false, required: ['sandbox'], note: 'Test Account SID (Console: Admin > Account management > API keys & tokens).' },
      { name: 'AR_TWILIO_TEST_AUTH_TOKEN', secret: true, required: ['sandbox'], note: 'Test Auth Token. Test calls are not placed and not charged.' },
      { name: 'AR_TWILIO_ACCOUNT_SID', secret: false, required: ['production'], note: 'Live Account SID. A signed Twilio BAA is needed before PHI; its terms were not verified in ADR 0100.' },
      { name: 'AR_TWILIO_AUTH_TOKEN', secret: true, required: ['production'], note: 'Live Auth Token.' },
      { name: 'AR_TWILIO_CALLER_ID', secret: false, required: ['production'], note: 'Owned Twilio number in E.164.' },
      { name: 'AR_PUBLIC_BASE_URL', secret: false, required: ['production'], note: 'Public https base URL for status callbacks.' },
      { name: 'AR_TWILIO_RELAY_URL', secret: false, required: ['production'], note: 'wss:// Conversation Relay socket (not built yet; see ADR 0100 blocked list).' },
    ],
    baseUrls: { sandbox: { api: 'https://api.twilio.com' }, production: { api: 'https://api.twilio.com' } },
    overrideVars: { api: 'AR_TWILIO_API_BASE_URL' },
  },
  slack: {
    id: 'slack', connectorId: 'slack_notify', label: 'Slack incoming webhooks (staff notifications)', modeVar: 'AR_SLACK_MODE',
    vars: [{ name: 'AR_SLACK_WEBHOOK_URL', secret: true, required: ['sandbox'], note: 'Smoke target only: an incoming-webhook URL for a test channel. Channels configured in the app hold their own URL.' }],
    baseUrls: { sandbox: {}, production: {} },
    overrideVars: {},
  },
  postmark: {
    id: 'postmark', connectorId: 'postmark_email', label: 'Postmark (transactional email to staff)', modeVar: 'AR_POSTMARK_MODE',
    vars: [
      { name: 'AR_POSTMARK_SERVER_TOKEN', secret: true, required: ['production'], note: 'Server API token. Sandbox sends the documented POSTMARK_API_TEST token instead.' },
      { name: 'AR_POSTMARK_FROM', secret: false, required: both, note: 'A confirmed sender signature address.' },
      { name: 'AR_POSTMARK_SMOKE_TO', secret: false, required: ['sandbox'], note: 'Smoke recipient (test mode validates without delivering).' },
      { name: 'AR_POSTMARK_MESSAGE_STREAM', secret: false, required: [], note: 'Optional; Postmark defaults to the outbound transactional stream.' },
    ],
    baseUrls: { sandbox: { api: 'https://api.postmarkapp.com' }, production: { api: 'https://api.postmarkapp.com' } },
    overrideVars: { api: 'AR_POSTMARK_BASE_URL' },
  },
};

export const GLOBAL_VARS: EnvVar[] = [
  { name: 'AR_LIVE_ALLOW_LOOPBACK', secret: false, required: [], note: 'Tests and local mock rehearsals only: accept http://127.0.0.1 base URL overrides.' },
];

// ---- ADR 0110: values saved in the app, beneath the environment.
let storedSource: (() => Env) | null = null;

/** Registered by connector-settings.ts: returns the stored (already opened) values by name. */
export function setStoredSettingsSource(fn: (() => Env) | null): void { storedSource = fn; }

/** True when the environment sets this name (directly, or through `<NAME>_FILE`). Such a name is locked. */
export function envProvides(name: string, env: Env = process.env): boolean {
  return (env[name] ?? '').trim() !== '' || (env[`${name}_FILE`] ?? '') !== '';
}

/** The environment with stored values filled in for names it does not set. Environment always wins. */
export function liveEnv(base: Env = process.env): Env {
  const stored = storedSource ? storedSource() : null;
  if (!stored) return base;
  let out: Env | null = null;
  for (const [k, v] of Object.entries(stored)) {
    if (v === undefined || envProvides(k, base)) continue;
    out ??= { ...base };
    out[k] = v;
  }
  return out ?? base;
}

/** The names that may be stored for a provider: its declared variables plus its mode variable. */
export function storableNames(p: ProviderId): string[] {
  return [SPECS[p].modeVar, ...SPECS[p].vars.map((v) => v.name)];
}

export function isProvider(p: string): p is ProviderId {
  return (PROVIDERS as readonly string[]).includes(p);
}

export function modeOf(p: ProviderId, env: Env = liveEnv()): LiveMode {
  const v = (env[SPECS[p].modeVar] ?? '').trim().toLowerCase();
  return v === 'sandbox' || v === 'production' ? v : 'off';
}

/** Reads a variable from the environment, or from the file named by `<NAME>_FILE`. Never logged. */
export function readVar(name: string, env: Env = liveEnv()): string | null {
  const direct = env[name];
  if (direct !== undefined && direct.trim() !== '') return direct.trim();
  const file = env[`${name}_FILE`];
  if (file) {
    try { const v = readFileSync(file, 'utf8').trim(); return v || null; } catch { return null; }
  }
  return null;
}

/** Which variables are present or missing for the provider's current mode. Values are never returned. */
export function envStatus(p: ProviderId, env: Env = liveEnv()) {
  const mode = modeOf(p, env);
  return SPECS[p].vars.map((v) => ({
    name: v.name, secret: v.secret, note: v.note,
    required: mode !== 'off' && v.required.includes(mode),
    requiredIn: v.required,
    present: readVar(v.name, env) !== null,
    source: env[v.name] ? 'env' : env[`${v.name}_FILE`] ? 'file' : null,
  }));
}

export function missingVars(p: ProviderId, env: Env = liveEnv()): string[] {
  return envStatus(p, env).filter((v) => v.required && !v.present).map((v) => v.name);
}

/** Resolved base URL: documented default, or a vetted override. Returns an error string instead of a bad URL. */
export function baseUrl(p: ProviderId, key: string, env: Env = liveEnv()): { url: string | null; error: string | null; overridden: boolean } {
  const mode = modeOf(p, env);
  const spec = SPECS[p];
  const ov = spec.overrideVars[key] ? env[spec.overrideVars[key]] : undefined;
  if (ov) {
    const safe = safePublicHttpsUrl(ov, { allowLoopback: env.AR_LIVE_ALLOW_LOOPBACK === '1' });
    return safe ? { url: safe, error: null, overridden: true } : { url: null, error: `${spec.overrideVars[key]} must be a public https URL`, overridden: true };
  }
  const url = mode === 'off' ? spec.baseUrls.sandbox[key] ?? null : spec.baseUrls[mode][key] ?? null;
  return url ? { url, error: null, overridden: false } : { url: null, error: `No documented ${key} base URL for ${p}`, overridden: false };
}

/** Deployment-level reasons a provider cannot run (mode, credentials, base URLs). Scope reasons live in gate.ts. */
export function deploymentReasons(p: ProviderId, env: Env = liveEnv()): string[] {
  const mode = modeOf(p, env);
  if (mode === 'off') return [`${SPECS[p].modeVar} is off (set sandbox or production to enable ${p}).`];
  const reasons: string[] = [];
  const missing = missingVars(p, env);
  if (missing.length) reasons.push(`Missing environment variables for ${mode}: ${missing.join(', ')}.`);
  for (const key of Object.keys(SPECS[p].baseUrls[mode])) {
    const b = baseUrl(p, key, env);
    if (b.error) reasons.push(b.error);
  }
  return reasons;
}

/** Every env var this workstream reads, for .env.example and the setup guide. */
export function allVarNames(): string[] {
  const out = new Set<string>();
  for (const s of Object.values(SPECS)) { out.add(s.modeVar); for (const v of s.vars) out.add(v.name); for (const o of Object.values(s.overrideVars)) out.add(o); }
  for (const v of GLOBAL_VARS) out.add(v.name);
  return [...out];
}
