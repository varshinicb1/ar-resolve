// Deployment configuration (ADR 0090). Every setting the production-hardening workstream adds is
// read here and nowhere else. Two entry points:
//   - deploymentEnv(): cheap, used at import time by modules that only need to know whether the
//     deployment is synthetic (dev login, simulators, draft-rule baseline). It never throws for a
//     missing value (default synthetic); it throws for an unknown one.
//   - loadConfig(): the full, validated configuration. Non-synthetic environments fail closed:
//     every problem is collected and startup refuses with the whole list (ConfigError).
//
// AR_ENV is the deployment kind (synthetic | staging | production). AR_ENVIRONMENT is the older
// rollout stage used by the connector and PHI gates (synthetic | shadow | assisted_live,
// framework.ts). They must agree: a synthetic deployment has rollout stage synthetic; a staging or
// production deployment must name shadow or assisted_live explicitly.
import { isAbsolute } from 'node:path';
import { sealingEnabled, phiKeyring } from './services/phi.ts';

export type DeploymentEnv = 'synthetic' | 'staging' | 'production';
type Env = Record<string, string | undefined>;

const ENVS: readonly DeploymentEnv[] = ['synthetic', 'staging', 'production'];
const STAGES = ['synthetic', 'shadow', 'assisted_live'] as const;

export class ConfigError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`Refusing to start: ${problems.length} configuration problem(s):\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

/** AR_ENV, defaulting to synthetic. Throws on an unknown value (a typo must never mean "synthetic"). */
export function deploymentEnv(env: Env = process.env): DeploymentEnv {
  const v = (env.AR_ENV ?? '').trim();
  if (!v) return 'synthetic';
  if (!(ENVS as readonly string[]).includes(v)) throw new ConfigError([`AR_ENV must be one of ${ENVS.join(', ')} (got "${v}")`]);
  return v as DeploymentEnv;
}

export const isSyntheticDeployment = (env: Env = process.env): boolean => deploymentEnv(env) === 'synthetic';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  tokenAuth: 'client_secret_basic' | 'client_secret_post';
  allowedAlgs: string[];
  postLogoutRedirectUri: string | null;
  /** Clock skew tolerated on exp / iat / nbf, seconds. */
  clockSkewSec: number;
}

export interface Config {
  env: DeploymentEnv;
  synthetic: boolean;
  rolloutStage: (typeof STAGES)[number];
  port: number;
  dbPath: string;
  publicBaseUrl: string | null;
  embeddedWorker: boolean;
  devLogin: boolean;
  session: { secret: string; ttlHours: number; idleMinutes: number; secureCookie: boolean; cookieName: string };
  oidc: OidcConfig | null;
  allowedOrigins: string[];
  trustProxyHops: number;
  http: { bodyLimitBytes: number; requestTimeoutMs: number; handlerTimeoutMs: number; hsts: boolean };
  rateLimit: { ipPerMinute: number; keyPerMinute: number };
  metricsToken: string | null;
  backup: { dir: string | null; intervalMinutes: number; keep: number; encrypt: boolean };
  shutdownGraceMs: number;
  workerIntervals: { outboxMs: number; notifyMs: number; governanceMs: number };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// A development-only secret for the synthetic environment; never accepted elsewhere.
const SYNTHETIC_SESSION_SECRET = 'synthetic-only-session-secret-not-for-production-use';

function int(env: Env, key: string, dflt: number, min: number, max: number, problems: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) { problems.push(`${key} must be an integer ${min}-${max} (got "${raw}")`); return dflt; }
  return n;
}

function url(v: string | undefined): URL | null {
  if (!v) return null;
  try { return new URL(v); } catch { return null; }
}

/** Full configuration. Throws ConfigError listing every problem. */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const kind = deploymentEnv(env);
  const synthetic = kind === 'synthetic';
  const strict = !synthetic;

  const stageRaw = (env.AR_ENVIRONMENT ?? '').trim();
  let rolloutStage: Config['rolloutStage'] = 'synthetic';
  if (stageRaw && !(STAGES as readonly string[]).includes(stageRaw)) problems.push(`AR_ENVIRONMENT must be one of ${STAGES.join(', ')} (got "${stageRaw}")`);
  else if (stageRaw) rolloutStage = stageRaw as Config['rolloutStage'];
  if (synthetic && rolloutStage !== 'synthetic') problems.push(`AR_ENV=synthetic but AR_ENVIRONMENT=${rolloutStage}; a synthetic deployment cannot run a live rollout stage`);
  if (strict && rolloutStage === 'synthetic') problems.push(`AR_ENV=${kind} requires AR_ENVIRONMENT=shadow or assisted_live (the rollout stage the connector and PHI gates use)`);

  const port = int(env, 'PORT', 8080, 1, 65535, problems);
  const dbPath = (env.AR_DB ?? '').trim() || (strict ? '' : 'data/ar-resolve.db');
  if (strict && !dbPath) problems.push('AR_DB is required (absolute path on a persistent volume)');
  else if (strict && !isAbsolute(dbPath)) problems.push('AR_DB must be an absolute path');

  const base = url(env.AR_PUBLIC_BASE_URL);
  if (env.AR_PUBLIC_BASE_URL && !base) problems.push('AR_PUBLIC_BASE_URL is not a valid URL');
  if (strict && !base) problems.push('AR_PUBLIC_BASE_URL is required (the https origin users reach)');
  if (strict && base && base.protocol !== 'https:') problems.push('AR_PUBLIC_BASE_URL must use https');
  const publicBaseUrl = base ? base.origin : null;

  // Sessions
  const secret = env.AR_SESSION_SECRET ?? '';
  if (strict && secret.length < 32) problems.push('AR_SESSION_SECRET is required (at least 32 characters of random data)');
  if (strict && secret === SYNTHETIC_SESSION_SECRET) problems.push('AR_SESSION_SECRET is the synthetic placeholder');
  const ttlHours = int(env, 'AR_SESSION_TTL_HOURS', strict ? 10 : 12, 1, 24, problems);
  const idleMinutes = int(env, 'AR_SESSION_IDLE_MINUTES', 30, 5, 240, problems);
  const secureCookie = strict || base?.protocol === 'https:';

  // OIDC
  let oidc: OidcConfig | null = null;
  const issuer = (env.AR_OIDC_ISSUER ?? '').trim();
  if (issuer || strict) {
    const missing = ['AR_OIDC_ISSUER', 'AR_OIDC_CLIENT_ID', 'AR_OIDC_CLIENT_SECRET'].filter((k) => !(env[k] ?? '').trim());
    if (missing.length) problems.push(`OIDC single sign-on needs ${missing.join(', ')}`);
    const iss = url(issuer);
    if (issuer && !iss) problems.push('AR_OIDC_ISSUER is not a valid URL');
    if (strict && iss && iss.protocol !== 'https:') problems.push('AR_OIDC_ISSUER must use https');
    const redirect = (env.AR_OIDC_REDIRECT_URI ?? '').trim() || (publicBaseUrl ? `${publicBaseUrl}/api/auth/callback` : '');
    if (!redirect) problems.push('AR_OIDC_REDIRECT_URI (or AR_PUBLIC_BASE_URL) is required for OIDC');
    else if (strict && url(redirect)?.protocol !== 'https:') problems.push('AR_OIDC_REDIRECT_URI must use https');
    const tokenAuth = (env.AR_OIDC_TOKEN_AUTH ?? 'client_secret_basic').trim();
    if (tokenAuth !== 'client_secret_basic' && tokenAuth !== 'client_secret_post') problems.push('AR_OIDC_TOKEN_AUTH must be client_secret_basic or client_secret_post');
    const algs = (env.AR_OIDC_ALLOWED_ALGS ?? 'RS256').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = algs.filter((a) => !['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384'].includes(a));
    if (bad.length || !algs.length) problems.push(`AR_OIDC_ALLOWED_ALGS supports RS256, RS384, RS512, PS256, ES256, ES384 (got ${bad.join(', ') || 'nothing'})`);
    const scopes = (env.AR_OIDC_SCOPES ?? 'openid email profile').trim();
    if (!scopes.split(/\s+/).includes('openid')) problems.push('AR_OIDC_SCOPES must include openid');
    oidc = { issuer, clientId: (env.AR_OIDC_CLIENT_ID ?? '').trim(), clientSecret: env.AR_OIDC_CLIENT_SECRET ?? '',
      redirectUri: redirect, scopes, tokenAuth: tokenAuth as OidcConfig['tokenAuth'], allowedAlgs: algs,
      postLogoutRedirectUri: (env.AR_OIDC_POST_LOGOUT_REDIRECT_URI ?? '').trim() || null, clockSkewSec: int(env, 'AR_OIDC_CLOCK_SKEW_SEC', 60, 0, 300, problems) };
  }

  // PHI key material: required outside synthetic (sealing at rest, backup encryption).
  if (strict) {
    try { phiKeyring(env); } catch (e) { problems.push(`PHI keyring invalid: ${(e as Error).message}`); }
    if (!sealingEnabled(env)) problems.push('AR_PHI_KEYS (+ AR_PHI_ACTIVE_KEY_ID) or AR_PHI_KEY is required');
  }

  // Origins
  const allowedOrigins: string[] = [];
  for (const o of (env.AR_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const u = url(o);
    if (!u || u.origin !== o.replace(/\/$/, '')) { problems.push(`AR_ALLOWED_ORIGINS entry "${o}" must be a bare origin like https://ar.example.com`); continue; }
    if (strict && u.protocol !== 'https:') problems.push(`AR_ALLOWED_ORIGINS entry ${o} must use https`);
    allowedOrigins.push(u.origin);
  }
  if (strict && !allowedOrigins.length) problems.push('AR_ALLOWED_ORIGINS is required (comma-separated https origins allowed to call the API from a browser)');
  if (publicBaseUrl && !allowedOrigins.includes(publicBaseUrl) && allowedOrigins.length) allowedOrigins.push(publicBaseUrl);

  const metricsToken = (env.AR_METRICS_TOKEN ?? '').trim() || null;
  if (strict && (!metricsToken || metricsToken.length < 24)) problems.push('AR_METRICS_TOKEN is required (at least 24 characters); /metrics is never open outside synthetic');

  const backupDir = (env.AR_BACKUP_DIR ?? '').trim() || null;
  if (strict && !backupDir) problems.push('AR_BACKUP_DIR is required (absolute path, ideally a separate volume)');
  else if (strict && backupDir && !isAbsolute(backupDir)) problems.push('AR_BACKUP_DIR must be an absolute path');
  const encryptRaw = (env.AR_BACKUP_ENCRYPT ?? (strict ? 'on' : 'off')).trim();
  if (encryptRaw !== 'on' && encryptRaw !== 'off') problems.push('AR_BACKUP_ENCRYPT must be on or off');
  if (strict && encryptRaw === 'off') problems.push('AR_BACKUP_ENCRYPT=off is not allowed outside synthetic');

  const logLevel = (env.AR_LOG_LEVEL ?? 'info').trim() as Config['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) problems.push('AR_LOG_LEVEL must be debug, info, warn or error');

  if (strict && env.AR_DEV_LOGIN) problems.push('AR_DEV_LOGIN is not allowed outside synthetic');

  const cfg: Config = {
    env: kind, synthetic, rolloutStage, port, dbPath, publicBaseUrl,
    embeddedWorker: env.AR_WORKER !== 'off',
    devLogin: synthetic,
    session: { secret: secret || SYNTHETIC_SESSION_SECRET, ttlHours, idleMinutes, secureCookie, cookieName: secureCookie ? '__Host-ar_session' : 'ar_session' },
    oidc,
    allowedOrigins,
    trustProxyHops: int(env, 'AR_TRUST_PROXY_HOPS', 0, 0, 5, problems),
    http: {
      bodyLimitBytes: int(env, 'AR_BODY_LIMIT_BYTES', 1_000_000, 1024, 20_000_000, problems),
      requestTimeoutMs: int(env, 'AR_REQUEST_TIMEOUT_MS', 30_000, 1000, 600_000, problems),
      handlerTimeoutMs: int(env, 'AR_HANDLER_TIMEOUT_MS', 25_000, 100, 600_000, problems),
      hsts: kind === 'production',
    },
    rateLimit: {
      ipPerMinute: int(env, 'AR_RATE_LIMIT_IP_PER_MIN', strict ? 300 : 0, 0, 1_000_000, problems),
      keyPerMinute: int(env, 'AR_RATE_LIMIT_KEY_PER_MIN', strict ? 600 : 0, 0, 1_000_000, problems),
    },
    metricsToken,
    backup: { dir: backupDir, intervalMinutes: int(env, 'AR_BACKUP_INTERVAL_MINUTES', strict ? 60 : 0, 0, 10_080, problems), keep: int(env, 'AR_BACKUP_KEEP', 48, 1, 10_000, problems), encrypt: encryptRaw === 'on' },
    shutdownGraceMs: int(env, 'AR_SHUTDOWN_GRACE_MS', 15_000, 0, 120_000, problems),
    // Pre-existing worker settings, now read here too (same names and defaults as before).
    workerIntervals: {
      outboxMs: int(env, 'AR_WORKER_INTERVAL_MS', 1500, 100, 3_600_000, problems),
      notifyMs: int(env, 'AR_NOTIFY_INTERVAL_MS', 5000, 100, 3_600_000, problems),
      governanceMs: int(env, 'AR_GOVERNANCE_INTERVAL_MS', 5000, 100, 3_600_000, problems),
    },
    logLevel,
  };
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}

/** Names of settings that are secrets: never logged, never echoed by any route. */
export const SECRET_SETTINGS = ['AR_SESSION_SECRET', 'AR_OIDC_CLIENT_SECRET', 'AR_METRICS_TOKEN', 'AR_PHI_KEY', 'AR_PHI_KEYS'] as const;

/** A non-secret summary for the startup log and /readyz. */
export function describeConfig(c: Config) {
  return {
    env: c.env, rolloutStage: c.rolloutStage, port: c.port, dbPath: c.dbPath, publicBaseUrl: c.publicBaseUrl, embeddedWorker: c.embeddedWorker, devLogin: c.devLogin,
    oidc: c.oidc ? { issuer: c.oidc.issuer, clientId: c.oidc.clientId, redirectUri: c.oidc.redirectUri, tokenAuth: c.oidc.tokenAuth, allowedAlgs: c.oidc.allowedAlgs } : null,
    allowedOrigins: c.allowedOrigins, trustProxyHops: c.trustProxyHops, http: c.http, rateLimit: c.rateLimit, metricsAuth: c.metricsToken ? 'bearer' : 'open (synthetic only)',
    backup: { dir: c.backup.dir, intervalMinutes: c.backup.intervalMinutes, keep: c.backup.keep, encrypt: c.backup.encrypt },
    session: { ttlHours: c.session.ttlHours, idleMinutes: c.session.idleMinutes, secureCookie: c.session.secureCookie },
  };
}
