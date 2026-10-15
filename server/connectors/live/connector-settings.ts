// Connect providers (ADR 0110): provider keys and modes entered in the app instead of environment files.
//
// Storage: connector_settings (one row per provider + name, deployment-level) and an append-only
// connector_setting_changes history. Only names declared in config.ts SPECS (plus each provider's mode
// variable) are accepted. Secret values are sealed with AES-256-GCM through services/phi.ts before they
// are written; nothing returns, audits or logs a secret value. The API shows at most its last 4
// characters (none for values shorter than 12).
//
// Sealing key (fail closed):
//   - a PHI keyring in the environment (AR_PHI_KEYS + AR_PHI_ACTIVE_KEY_ID, or AR_PHI_KEY) is used when
//     configured, in every deployment kind;
//   - outside AR_ENV=synthetic, without that keyring no secret is stored (409 sealing_key_missing);
//   - in synthetic only, without a keyring, a per-installation key file is created next to the database
//     (or at AR_CONNECTOR_KEY_FILE) with mode 0600, and the page says so.
//
// Precedence: an environment variable (or <NAME>_FILE) always wins. config.ts liveEnv() reads the stored
// values through setStoredSettingsSource; the cache is dropped on every save and otherwise lives at most
// CACHE_MS, so a separate worker process sees a change within that time.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { type Db, all, run, tx } from '../../db/db.ts';
import { AppError, invalid, nowIso } from '../../util.ts';
import { audit } from '../../services/audit.ts';
import { requirePerm, type Scope } from '../../services/auth.ts';
import { type Keyring, PhiKeyError, isSealed, open, phiKeyring, seal } from '../../services/phi.ts';
import { latestAuthorization } from '../framework.ts';
import { clearTokenCache } from './http.ts';
import { type Env, type LiveMode, type ProviderId, PROVIDERS, SPECS, envProvides, isProvider, liveEnv, modeOf, readVar, setStoredSettingsSource, storableNames } from './config.ts';
import { lastSmoke, providerGate, revocation } from './gate.ts';
import { formatReport, runSmoke, type SmokeReport } from './smoke.ts';

/** Display order on the page (the owner's order). */
export const PAGE_ORDER: ProviderId[] = ['stedi', 'availity', 'optum', 'twilio', 'slack', 'postmark'];

/** Plain user-facing labels; the env var name is shown small underneath. */
export const LABELS: Record<string, string> = {
  AR_STEDI_API_KEY: 'API key',
  AR_AVAILITY_CLIENT_ID: 'Client ID', AR_AVAILITY_CLIENT_SECRET: 'Client secret', AR_AVAILITY_MOCK_SCENARIO_ID: 'Demo scenario ID (optional)',
  AR_OPTUM_CLIENT_ID: 'Client ID', AR_OPTUM_CLIENT_SECRET: 'Client secret',
  AR_TWILIO_TEST_ACCOUNT_SID: 'Test Account SID', AR_TWILIO_TEST_AUTH_TOKEN: 'Test Auth Token', AR_TWILIO_ACCOUNT_SID: 'Live Account SID', AR_TWILIO_AUTH_TOKEN: 'Live Auth Token',
  AR_TWILIO_CALLER_ID: 'Caller ID (your Twilio number)', AR_PUBLIC_BASE_URL: 'Public address of this app (used by Twilio callbacks)', AR_TWILIO_RELAY_URL: 'Conversation Relay socket URL',
  AR_SLACK_WEBHOOK_URL: 'Test-channel webhook URL',
  AR_POSTMARK_SERVER_TOKEN: 'Server API token', AR_POSTMARK_FROM: 'Sender address', AR_POSTMARK_SMOKE_TO: 'Test recipient', AR_POSTMARK_MESSAGE_STREAM: 'Message stream (optional)',
};

/** "Where to get this": the official signup or key pages listed in docs/INTEGRATIONS_SETUP.md (retrieved 2026-10-14). */
export const SIGNUP: Record<ProviderId, { url: string; text: string }> = {
  stedi: { url: 'https://portal.stedi.com/app/settings/api-keys', text: 'Stedi portal: API keys (create a Test key)' },
  availity: { url: 'https://developer.availity.com/', text: 'Availity developer portal (Demo plan)' },
  optum: { url: 'https://marketplace.optum.com/apiservices/api-sandbox-access', text: 'Optum API sandbox access request' },
  twilio: { url: 'https://www.twilio.com/docs/iam/test-credentials', text: 'Twilio test credentials (Console: API keys & tokens)' },
  slack: { url: 'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks', text: 'Slack incoming webhooks' },
  postmark: { url: 'https://postmarkapp.com/developer/user-guide/send-email-with-api', text: 'Postmark: send email with the API' },
};

const OIDC_VARS: [string, string, boolean][] = [
  ['AR_OIDC_ISSUER', 'Issuer URL', true], ['AR_OIDC_CLIENT_ID', 'Client ID', true], ['AR_OIDC_CLIENT_SECRET', 'Client secret', true],
  ['AR_OIDC_REDIRECT_URI', 'Redirect URI (defaults to the public address)', false], ['AR_OIDC_SCOPES', 'Scopes', false], ['AR_OIDC_TOKEN_AUTH', 'Token authentication method', false],
  ['AR_OIDC_ALLOWED_ALGS', 'Allowed signing algorithms', false], ['AR_OIDC_POST_LOGOUT_REDIRECT_URI', 'Post-logout redirect', false], ['AR_OIDC_CLOCK_SKEW_SEC', 'Clock skew (seconds)', false],
];

const LOCAL_KEY_ID = 'local';
const MAX_VALUE = 4096;
const CACHE_MS = 5_000;
export const TEST_INTERVAL_MS = 10_000;

// ---- configuration of this process's store
interface StoreConfig { db: Db; synthetic: boolean; keyFile: string }
let store: StoreConfig | null = null;
let cache: { at: number; values: Env; unreadable: Set<string> } | null = null;
const lastTest = new Map<ProviderId, number>();

/** Where the synthetic-only per-installation key lives: AR_CONNECTOR_KEY_FILE, else next to the database. */
export function keyFilePath(dbPath: string, env: Env = process.env): string {
  const explicit = (env.AR_CONNECTOR_KEY_FILE ?? '').trim();
  if (explicit) return resolve(explicit);
  const base = dbPath && dbPath !== ':memory:' ? dirname(dbPath) : 'data';
  return resolve(base, 'connector-settings.key');
}

/**
 * Registers the stored values for this process (API server, worker, smoke:live). The last registration
 * wins; config.ts liveEnv() then sees stored values for names the environment leaves unset.
 */
export function useConnectorSettings(db: Db, o: { synthetic: boolean; dbPath: string }) {
  store = { db, synthetic: o.synthetic, keyFile: keyFilePath(o.dbPath) };
  cache = null;
  setStoredSettingsSource(storedValues);
}

export function invalidateConnectorSettings() { cache = null; }

function localKey(create: boolean): Buffer | null {
  if (!store) return null;
  const f = store.keyFile;
  if (!existsSync(f)) {
    if (!create) return null;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(f, 0o600); // umask cannot widen it, but be explicit
  }
  const mode = statSync(f).mode & 0o777;
  if (mode & 0o077) throw new AppError(409, 'sealing_key_insecure', `The local sealing key file ${f} is readable by other users (mode ${mode.toString(8)}); run chmod 600 on it.`);
  const key = Buffer.from(readFileSync(f, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new AppError(409, 'sealing_key_invalid', `The local sealing key file ${f} does not hold a 32-byte base64 key.`);
  return key;
}

function envKeyring(env: Env = process.env): Keyring | null {
  try { const r = phiKeyring(env); return r.activeId ? r : null; } catch (e) { if (e instanceof PhiKeyError) return null; throw e; }
}

/** How secrets are sealed in this deployment (shown on the page). Never returns key material. */
export function sealingStatus(env: Env = process.env) {
  const ring = envKeyring(env);
  if (ring) return { mode: 'environment' as const, keyId: ring.activeId, message: `Secrets are sealed with the PHI keyring from the environment (key ${ring.activeId}).` };
  if (!store?.synthetic) return { mode: 'missing' as const, keyId: null, message: 'No sealing key is configured. Set AR_PHI_KEYS and AR_PHI_ACTIVE_KEY_ID (or AR_PHI_KEY) to store secrets here; until then, set secrets as environment variables.' };
  const exists = existsSync(store.keyFile);
  return { mode: 'local_file' as const, keyId: LOCAL_KEY_ID, message: `Synthetic environment: secrets are sealed with a per-installation key file ${exists ? 'at' : 'that will be created at'} ${store.keyFile} (permissions 0600). Set AR_PHI_KEYS for a real deployment.` };
}

/** The keyring new secrets are sealed with. Fails closed outside synthetic. */
function sealingKeyring(): Keyring {
  const ring = envKeyring();
  if (ring) return ring;
  if (!store?.synthetic) throw new AppError(409, 'sealing_key_missing', 'Refusing to store a secret: no sealing key is configured. Set AR_PHI_KEYS and AR_PHI_ACTIVE_KEY_ID (or AR_PHI_KEY) in the environment, or set this secret as an environment variable instead.');
  const key = localKey(true)!;
  return { activeId: LOCAL_KEY_ID, keys: new Map([[LOCAL_KEY_ID, key]]) };
}

/** Every key that can open a stored value: the environment keyring plus the local file key, if present. */
function openingKeyring(): Keyring {
  const keys = new Map<string, Buffer>();
  try { for (const [k, v] of phiKeyring().keys) keys.set(k, v); } catch { /* invalid env keyring: such values stay unreadable */ }
  try { const l = localKey(false); if (l && !keys.has(LOCAL_KEY_ID)) keys.set(LOCAL_KEY_ID, l); } catch { /* insecure or invalid file: unreadable */ }
  return { activeId: null, keys };
}

interface Row { provider: string; name: string; value: string; secret: number; last4: string | null; updated_by: string; updated_at: string; display_name: string | null }

function rows(db: Db): Row[] {
  return all<Row>(db, 'SELECT s.*, u.display_name FROM connector_settings s LEFT JOIN users u ON u.user_id = s.updated_by ORDER BY provider, name');
}

/** Stored values, opened, keyed by env var name. Cached; never logged. */
function storedValues(): Env {
  if (!store) return {};
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.values;
  const values: Env = {};
  const unreadable = new Set<string>();
  let ring: Keyring | null = null;
  for (const r of rows(store.db)) {
    if (!r.secret) { values[r.name] = r.value; continue; }
    try { ring ??= openingKeyring(); values[r.name] = open(r.value, ring); } catch { unreadable.add(r.name); }
  }
  cache = { at: Date.now(), values, unreadable };
  return values;
}

function unreadableNames(): Set<string> { storedValues(); return cache?.unreadable ?? new Set(); }

const last4Of = (v: string) => (v.length >= 12 ? v.slice(-4) : '');

function admin(scope: Scope) { requirePerm(scope, 'integration_admin'); }

function provider(p: string): ProviderId {
  if (!isProvider(p)) throw invalid(`Unknown provider. Use one of: ${PROVIDERS.join(', ')}`);
  return p;
}

function varSpec(p: ProviderId, name: string) { return SPECS[p].vars.find((v) => v.name === name) ?? null; }

function cleanValue(name: string, raw: unknown): string {
  if (typeof raw !== 'string') throw invalid(`${name} must be a string`);
  const v = raw.trim();
  // Never echo the value in an error: it may be a secret pasted into the wrong box.
  if (v.length > MAX_VALUE) throw invalid(`${name} is longer than ${MAX_VALUE} characters`);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw invalid(`${name} contains a line break or control character`);
  return v;
}

function record(db: Db, scope: Scope, p: ProviderId, name: string, action: 'set' | 'cleared', secret: boolean, fingerprint: string | null) {
  run(db, 'INSERT INTO connector_setting_changes (provider, name, action, secret, fingerprint, changed_by, changed_at, actor_tenant_id, actor_client_id) VALUES (?,?,?,?,?,?,?,?,?)',
    p, name, action, secret ? 1 : 0, fingerprint, scope.userId, nowIso(), scope.tenantId, scope.clientId);
}

function changed() { invalidateConnectorSettings(); clearTokenCache(); }

/** PUT values: partial update. Empty string leaves a value unchanged; `clear` lists names to remove. */
export function saveValues(db: Db, scope: Scope, p0: string, body: { values?: unknown; clear?: unknown }) {
  admin(scope);
  const p = provider(p0);
  const values = (body.values ?? {}) as Record<string, unknown>;
  if (typeof values !== 'object' || Array.isArray(values)) throw invalid('values must be an object of {name: value}');
  const clear = body.clear ?? [];
  if (!Array.isArray(clear) || clear.some((c) => typeof c !== 'string')) throw invalid('clear must be a list of names');
  const sets: { name: string; value: string; secret: boolean }[] = [];
  for (const [name, raw] of Object.entries(values)) {
    const spec = varSpec(p, name);
    if (!spec) throw invalid(`${name} is not a setting of ${p}. Allowed: ${SPECS[p].vars.map((v) => v.name).join(', ')}`);
    const v = cleanValue(name, raw);
    if (v === '') continue;
    if (clear.includes(name)) throw invalid(`${name} is both set and cleared`);
    if (envProvides(name)) throw new AppError(409, 'locked_by_environment', `${name} is set in the environment, which always wins; change it there.`);
    sets.push({ name, value: v, secret: spec.secret });
  }
  for (const name of clear as string[]) {
    if (!varSpec(p, name)) throw invalid(`${name} is not a setting of ${p}`);
  }
  if (!sets.length && !clear.length) throw invalid('Nothing to change: enter a value or choose Clear');
  const ring = sets.some((s) => s.secret) ? sealingKeyring() : null;
  const out = tx(db, () => {
    const done: { name: string; action: 'set' | 'cleared' }[] = [];
    for (const s of sets) {
      const stored = s.secret ? seal(s.value, ring!) : s.value;
      if (s.secret && !isSealed(stored)) throw new AppError(500, 'sealing_failed', 'Sealing failed; nothing was stored');
      const last4 = s.secret ? last4Of(s.value) : null;
      run(db, `INSERT INTO connector_settings (provider, name, value, secret, last4, updated_by, updated_at) VALUES (?,?,?,?,?,?,?)
               ON CONFLICT (provider, name) DO UPDATE SET value=excluded.value, secret=excluded.secret, last4=excluded.last4, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
        p, s.name, stored, s.secret ? 1 : 0, last4, scope.userId, nowIso());
      record(db, scope, p, s.name, 'set', s.secret, s.secret ? (last4 ? `…${last4}` : null) : s.value.slice(0, 200));
      done.push({ name: s.name, action: 'set' });
    }
    for (const name of clear as string[]) {
      const n = run(db, 'DELETE FROM connector_settings WHERE provider=? AND name=?', p, name);
      if (n) { record(db, scope, p, name, 'cleared', !!varSpec(p, name)?.secret, null); done.push({ name, action: 'cleared' }); }
    }
    // Audited without values: names and actions only.
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'connector_settings', objectId: p, eventType: 'connector_settings_changed', details: { provider: p, changes: done } });
    return done;
  });
  changed();
  return { provider: p, changes: out };
}

/** PUT mode: off | sandbox | production. Production is refused in a synthetic deployment. */
export function saveMode(db: Db, scope: Scope, p0: string, body: { mode?: unknown }) {
  admin(scope);
  const p = provider(p0);
  const mode = String(body.mode ?? '');
  if (mode !== 'off' && mode !== 'sandbox' && mode !== 'production') throw invalid('mode must be off, sandbox or production');
  const modeVar = SPECS[p].modeVar;
  if (envProvides(modeVar)) throw new AppError(409, 'locked_by_environment', `${modeVar} is set in the environment, which always wins; change it there.`);
  if (mode === 'production' && (!store || store.synthetic)) throw new AppError(409, 'production_needs_non_synthetic', 'Production mode is not available in the synthetic environment (AR_ENV=synthetic). The production gate (authorization, BAA, PHI gate, live switch) applies on top in a real deployment.');
  const previous = modeOf(p);
  tx(db, () => {
    run(db, `INSERT INTO connector_settings (provider, name, value, secret, last4, updated_by, updated_at) VALUES (?,?,?,0,NULL,?,?)
             ON CONFLICT (provider, name) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`, p, modeVar, mode, scope.userId, nowIso());
    record(db, scope, p, modeVar, 'set', false, mode);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'connector_settings', objectId: p, eventType: 'connector_mode_changed', details: { provider: p, from: previous, to: mode } });
  });
  changed();
  return { provider: p, mode: modeOf(p) };
}

const LOOPBACK = /^http:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/i;

/** Removes every stored secret value from a text, in case a vendor echoes one back. */
function scrub(text: string): string {
  if (!store) return text;
  const values = storedValues();
  let out = text;
  for (const r of rows(store.db)) {
    const v = r.secret ? values[r.name] : undefined;
    if (v && v.length >= 4) out = out.split(v).join('[redacted]');
  }
  return out;
}

/** POST test: the provider's smoke check against its sandbox, in-process. One run per provider per 10 s. */
export async function testProvider(db: Db, scope: Scope, p0: string) {
  admin(scope);
  const p = provider(p0);
  const prev = lastTest.get(p);
  const wait = prev === undefined ? 0 : TEST_INTERVAL_MS - (Date.now() - prev);
  if (wait > 0) throw new AppError(429, 'rate_limited', `A ${p} test ran less than ${TEST_INTERVAL_MS / 1000} seconds ago; try again in ${Math.ceil(wait / 1000)} s.`);
  lastTest.set(p, Date.now());
  changed();
  const env = liveEnv();
  // A run against a loopback override (local mock rehearsal) is recorded as local_mock, not as the vendor sandbox.
  const mocked = Object.values(SPECS[p].overrideVars).some((v) => LOOPBACK.test(env[v] ?? ''));
  const started = nowIso();
  const raw: SmokeReport = await runSmoke(p, { db: null, target: mocked ? 'local_mock' : 'vendor_sandbox' });
  const report: SmokeReport = { ...raw, reasons: raw.reasons.map(scrub), checks: raw.checks.map((c) => ({ ...c, detail: scrub(c.detail) })) };
  report.runId = `smk_${randomBytes(9).toString('hex')}`;
  run(db, 'INSERT INTO live_smoke_runs VALUES (?,?,?,?,?,?,?,?,?)', report.runId, p, report.mode, report.target, report.outcome,
    JSON.stringify({ reasons: report.reasons, checks: report.checks }), started, nowIso(), `app:${scope.userId}`);
  audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'connector_settings', objectId: p, eventType: 'connector_test_run', details: { provider: p, runId: report.runId, outcome: report.outcome, target: report.target } });
  return { ...report, lines: formatReport(report).split('\n') };
}

// ---- GET: everything the page shows. Never a secret value.

function plainStatus(mode: LiveMode, missing: string[], gateOpen: boolean, reasons: string[], hasAuth: boolean, revoked: boolean): string[] {
  if (mode === 'off') return ['Off'];
  const out: string[] = [];
  if (missing.length) out.push(`Missing: ${missing.join(', ')}`);
  if (reasons.some((r) => /must be a public https URL|No documented/.test(r))) out.push('A base address override is not allowed (it must be a public https address)');
  if (!hasAuth) out.push('Needs a customer authorization for this client');
  else if (revoked) out.push('The authorization for this client was revoked; record a new one');
  if (mode === 'production') {
    if (reasons.some((r) => /BAA/.test(r))) out.push('Production needs a signed BAA');
    if (reasons.some((r) => /[Cc]overed-service/.test(r))) out.push('Production needs covered-service verification');
    if (reasons.some((r) => /AR_PHI_MODE/.test(r))) out.push('Production needs the PHI gate switched on');
    if (reasons.some((r) => /switched to live/.test(r))) out.push('Production needs the connector switched to live for this client');
    if (reasons.some((r) => /[Oo]nboarding/.test(r))) out.push('Production needs complete onboarding');
    if (reasons.some((r) => /environment|synthetic/i.test(r) && !/variables/.test(r))) out.push('Production needs a non-synthetic deployment');
  }
  if (gateOpen) return [mode === 'sandbox' ? 'Ready for sandbox' : 'Ready for production'];
  if (!out.length) out.push(...reasons.slice(0, 3));
  return out;
}

export function connectSettings(db: Db, scope: Scope) {
  admin(scope);
  const env = liveEnv();
  const byName = new Map(rows(db).map((r) => [`${r.provider}/${r.name}`, r]));
  const unreadable = unreadableNames();
  const providers = PAGE_ORDER.map((p) => {
    const spec = SPECS[p];
    const mode = modeOf(p, env);
    const modeRow = byName.get(`${p}/${spec.modeVar}`);
    const modeSource = envProvides(spec.modeVar) ? 'environment' : modeRow ? 'saved' : 'default';
    const vars = spec.vars.map((v) => {
      const row = byName.get(`${p}/${v.name}`);
      const source = envProvides(v.name) ? 'environment' : row ? 'saved' : 'missing';
      return {
        name: v.name, label: LABELS[v.name] ?? v.name, note: v.note, secret: v.secret, requiredIn: v.required, required: mode !== 'off' && v.required.includes(mode),
        source, present: readVar(v.name, env) !== null,
        // Secrets: last 4 only, and only for a value saved here. Non-secret values are shown.
        last4: v.secret && source === 'saved' ? row!.last4 || '' : null,
        value: !v.secret ? (source === 'environment' ? readVar(v.name, process.env) : source === 'saved' ? row!.value : null) : null,
        setBy: source === 'saved' ? { userId: row!.updated_by, name: row!.display_name ?? row!.updated_by, at: row!.updated_at } : null,
        unreadable: source === 'saved' && unreadable.has(v.name),
      };
    });
    const missing = vars.filter((v) => v.required && !v.present).map((v) => v.label);
    const gate = providerGate(db, scope, p, env);
    const auth = latestAuthorization(db, scope, spec.connectorId);
    const rev = auth ? revocation(db, scope, spec.connectorId, auth.authorization_id) : null;
    return {
      provider: p, label: spec.label, connectorId: spec.connectorId, modeVar: spec.modeVar, mode, modeSource,
      modeSetBy: modeRow && modeSource === 'saved' ? { name: modeRow.display_name ?? modeRow.updated_by, at: modeRow.updated_at } : null,
      productionAllowed: !!store && !store.synthetic,
      productionNote: !store || store.synthetic ? 'Production is not available in the synthetic environment.' : 'Production also needs the live gate: authorization with covered-service verification, BAA, PHI gate, and the connector switched to live for the client.',
      vars,
      gate: { open: gate.open, status: plainStatus(mode, missing, gate.open, gate.reasons, !!auth, !!rev), reasons: gate.reasons },
      authorization: auth ? { authorizationId: auth.authorization_id, ref: auth.authorization_ref, coveredServiceVerified: !!auth.covered_service_verified, baaRef: auth.baa_ref, recordedAt: auth.recorded_at, revoked: rev ? { at: rev.revoked_at, by: rev.revoked_by } : null } : null,
      lastTest: lastSmoke(db, p),
      signup: SIGNUP[p],
      overrides: Object.fromEntries(Object.entries(spec.overrideVars).map(([k, name]) => [k, envProvides(name) ? 'environment' : null])),
    };
  });
  return {
    environment: store?.synthetic === false ? 'non-synthetic' : 'synthetic',
    sealing: sealingStatus(),
    providers,
    oidc: { note: 'Company sign-in is read once at startup, so these are set in the environment, not here.', settings: OIDC_VARS.map(([name, label, required]) => ({ name, label, required, present: (process.env[name] ?? '').trim() !== '' })) },
    testIntervalSeconds: TEST_INTERVAL_MS / 1000,
  };
}

/** Change history for a provider (names, actions, fingerprints; never values of secrets). */
export function settingHistory(db: Db, scope: Scope, p0: string) {
  admin(scope);
  const p = provider(p0);
  return all<{ seq: number; name: string; action: string; secret: number; fingerprint: string | null; changed_by: string; changed_at: string }>(db,
    'SELECT seq, name, action, secret, fingerprint, changed_by, changed_at FROM connector_setting_changes WHERE provider=? ORDER BY seq DESC LIMIT 50', p)
    .map((r) => ({ ...r, secret: !!r.secret }));
}

/** For tests: forget the per-provider test clock. */
export function resetTestRateLimit() { lastTest.clear(); }

