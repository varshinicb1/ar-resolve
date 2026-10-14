# ADR 0090: Production hardening (environments, SSO, HTTP hardening, operability, backups, packaging, CI)

Status: accepted for a single-node pilot. Date: 2026-10-14. Migration range 090-094
(`server/db/090_production.sql`). Branch `production-hardening`.

## Context

Until now AR Resolve could run only as a synthetic demo:

- development sign-in without a password;
- seeded demo users;
- simulators as default connectors;
- draft rules running as the baseline;
- no backups, no health endpoints, no packaging.

The owner wants a deployable service that a medical billing company can pilot. This ADR makes the
deployment mechanics production-grade. It does **not** make the product fit for PHI on its own: BAAs,
hosting, policies and a penetration test are still open (docs/SECURITY.md).

## Decisions

### 1. Environments: `AR_ENV` = synthetic | staging | production (`server/config.ts`)

- **One place for configuration.** Every new setting is read in `server/config.ts`:
  - `loadConfig()` validates everything and throws `ConfigError` listing **all** problems;
  - `main.ts` and `worker.ts` exit with code 78.
  - `deploymentEnv()` is the cheap import-time check used by modules. An unknown value throws: a typo never means synthetic.
- **Non-synthetic requires:**
  - `AR_ENVIRONMENT` (shadow | assisted_live);
  - an absolute `AR_DB`;
  - an https `AR_PUBLIC_BASE_URL`;
  - `AR_SESSION_SECRET` (32 or more characters);
  - a valid PHI keyring;
  - `AR_ALLOWED_ORIGINS` (https);
  - OIDC issuer (https), client id and secret;
  - `AR_METRICS_TOKEN`;
  - `AR_BACKUP_DIR` with encryption on.
- **Non-synthetic disables:**
  - dev login and `/api/dev/*`;
  - development bearer tokens;
  - simulator routes (`calls/simulate`, `ops/faults`, `ops/sim-confirm`, `webhooks/sim-payer`);
  - simulator executors (`sim_payer`, `sim_pm` fall through to the refusing live boundary);
  - simulated connectors (default config disabled, and `precheck` refuses `mode=simulated`);
  - voice simulator scripts;
  - the draft-rule baseline (`PHASE0_ENVIRONMENT` now equals `AR_ENV`, so `draftsMayRun()` is false);
  - the demo seed. Only reference data is seeded: rule definitions and calendars.
- **Rollout stage.** `AR_ENV` and the older rollout stage `AR_ENVIRONMENT` (connector and PHI gates) must agree. Synthetic means `AR_ENVIRONMENT` is unset or `synthetic`.
- **Cost.** One more variable to set. Existing deployments that set `AR_ENVIRONMENT=shadow` without `AR_ENV` now refuse to start. That is intended: they were running synthetic shortcuts.
- **Reversal.** Collapse to `AR_ENVIRONMENT` alone if the two notions turn out to be one.

### 2. Single sign-on: OpenID Connect authorization code + PKCE

Files: `server/services/oidc.ts`, `server/services/web-sessions.ts`, `server/http/routes/auth.ts`.

**Sources** (retrieved 2026-10-14):

- OIDC Core 1.0 §3.1.2.1, §3.1.3.3, §3.1.3.7;
- OIDC Discovery 1.0 §4;
- RFC 7636 §4.1-4.5;
- OIDC RP-Initiated Logout 1.0;
- Microsoft identity platform: auth code flow and OIDC pages. These confirm PKCE S256 as recommended, `code_verifier` in the token request, client secret in the body or HTTP Basic, and `end_session_endpoint` with `post_logout_redirect_uri`.

The code comments carry the URLs.

**Flow.**

- `GET /api/auth/login`:
  - stores state (hashed), nonce and verifier in `oidc_login_states` (10 minutes);
  - sets an HttpOnly `ar_oidc` cookie holding the state, which binds the sign-in to this browser;
  - redirects to the IdP with `response_type=code`, `scope` including openid, `nonce`, `code_challenge` and `code_challenge_method=S256`.
- `GET /api/auth/callback`:
  - the state must equal the cookie, and is consumed once;
  - the code is exchanged with `client_secret_basic` (default) or `client_secret_post`;
  - the ID token is validated: signature against the JWKS, `iss` exact, `aud` (single), `azp`, `exp`, `iat` window, `nbf`, `nonce`, `sub`;
  - the JWKS is cached for one hour. An unknown `kid` forces one refresh, at most once a minute.
- **Mapping.** Identity is mapped through `sso_identities` (issuer + subject, or a pre-registered email bound on the first sign-in that has `email_verified=true`). Unmapped identities are refused (`not_provisioned`) and recorded in `auth_events`. **No auto-provisioning**: users, grants and links are created by an operator with `scripts/admin.ts` (`server/services/admin.ts`). Grant changes are also hash-chain audited.
- **Sessions** (`web_sessions`):
  - a random 256-bit cookie (`__Host-ar_session` outside synthetic: Secure, HttpOnly, SameSite=Lax, Path=/);
  - only the HMAC-SHA256 under `AR_SESSION_SECRET` is stored;
  - absolute TTL plus an idle timeout, both enforced server-side; activity extends only the idle deadline.
- **CSRF.** Cookie-authenticated unsafe methods need `x-csrf-token` = HMAC(secret, "csrf:" + cookie), fetched from `GET /api/auth/session`. An Origin header must be allowed.
- **Logout.** `POST /api/auth/logout` (CSRF) revokes the session and returns the IdP `end_session_endpoint` URL with `client_id` and `post_logout_redirect_uri`.
- **Machine clients.** Named API keys (`ark_`, ADR 0080) work unchanged.
- **Restrictions.**
  - One issuer per deployment, so Entra multi-tenant `common` is not supported.
  - Multi-audience ID tokens are refused.
  - Asymmetric algorithms only (`AR_OIDC_ALLOWED_ALGS`, default RS256).
  - MFA is enforced by the IdP policy. AR Resolve does not check `amr`/`acr`.
- **Tests.** `tests/oidc-mock.ts` is a local OpenID Provider. It signs real RS256/ES256 JWTs, serves discovery and JWKS, checks PKCE and client authentication at its token endpoint, and rotates keys.

### 3. HTTP hardening (`server/http/hardening.ts`, `app.ts`)

- **Security headers.**
  - CSP for the built UI: `script-src 'self'`, no unsafe-inline/eval, `frame-ancestors 'none'`, `object-src 'none'`, `upgrade-insecure-requests` outside synthetic. React style props go through the CSSOM, which `style-src` does not restrict.
  - HSTS in production only.
  - `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP, CORP, Permissions-Policy.
  - An `x-request-id` on every response (echoed when the client sent a sane one).
- **CORS.** Allowlist with credentials. Preflight answered only for allowed origins. Mutations from unknown origins are refused (403 `origin_refused`). Synthetic without an allowlist keeps today's behaviour.
- **Rate limiting.** Token buckets per client IP (`AR_TRUST_PROXY_HOPS` picks the right X-Forwarded-For entry) and per credential (hash of the bearer token or session cookie). 429 with Retry-After. Off by default in synthetic. `/healthz`, `/readyz` and `/metrics` are exempt.
- **Limits.**
  - Body limit, checked against content-length and while streaming (413).
  - Node `requestTimeout` and `headersTimeout`.
  - A handler timeout (503 `timeout`; the message says the work may still complete).
- **Errors.** One envelope `{error: {code, message, details, requestId}}`. 500s are generic. Stacks are logged only in synthetic.
- **Cost.** In-process rate limits are per replica (fine for one node). Each request opens a closure for the timeout race.

### 4. Operability

- **Logs** (`server/log.ts`).
  - JSON lines with request id, method, route **pattern**, status, duration and principal. Never the raw path, query string or body.
  - Redaction by field name at any depth, plus value scrubbing: bearer tokens, `ark_` keys, JWTs, emails, phone numbers, SSN- and date-shaped strings.
  - The library default level is warn, so tests and scripts stay quiet. `main.ts` and `worker.ts` install the configured level.
- **Probes** (`server/http/ops-endpoints.ts`).
  - `/healthz` is liveness.
  - `/readyz` checks: not draining; `BEGIN IMMEDIATE`/`ROLLBACK` succeeds; no pending migrations (`pendingMigrations()` in `db.ts`); and, outside synthetic, an active PHI key and the session secret. The response reveals no values.
- **Metrics.** `/metrics` in Prometheus text format, behind `AR_METRICS_TOKEN` (open only in synthetic without a token):
  - request counter and histogram by route pattern;
  - rate-limited count;
  - outbox items by state;
  - actions awaiting review;
  - pending notifications;
  - active sessions;
  - time of the last successful backup;
  - process memory and uptime.
- **Graceful shutdown** (`server/runtime.ts`). On SIGTERM or SIGINT:
  1. readiness turns 503;
  2. the server stops accepting connections and closes idle ones;
  3. in-flight requests drain up to `AR_SHUTDOWN_GRACE_MS`;
  4. worker loops stop after the current item (`createLoop().stop()` awaits it);
  5. the database is closed and the process exits with 0.

  A second signal exits immediately. The worker runs as a separate process (`server/worker.ts`) with the same shutdown.

### 5. Data safety (`server/ops/backup.ts`)

- **Backup.** `node:sqlite` `backup()` takes an online backup. It was added in Node v22.16.0 (docs `doc/api/sqlite.md` on the v22.x branch, retrieved 2026-10-14). The backup then goes through these steps:
  1. it is detached to the rollback journal;
  2. it must pass `PRAGMA integrity_check`;
  3. it is sealed to `.arbk`: AES-256-GCM, a key derived with HKDF-SHA256 (random salt, info "ar-resolve backup v1") from the **active PHI key**, and the header (including the key id) bound as additional data;
  4. a JSON manifest with digests is written;
  5. the run is recorded in `backup_runs`;
  6. old backups are pruned to `AR_BACKUP_KEEP`.
- **Schedule.** The worker runs backups every `AR_BACKUP_INTERVAL_MINUTES`.
- **Restore** (`scripts/restore.ts`). It verifies the manifest digest, decrypts with the named key, checks integrity and the presence of migrations, and moves the old database aside (never deletes it).
- **Key rotation story.** The PHI key mechanism from ADR 0080 is reused. A retired PHI key goes to offline escrow and must not be destroyed until the backups sealed under it expire (docs/OPERATIONS.md §5).
- **Decision: derive from the PHI key rather than add a separate backup key.** It means one keyring, one rotation procedure and one escrow process.
  - **Cost:** a backup is restorable only while its key id is available, and the PHI key's blast radius covers backups.
  - **Reversal:** add `AR_BACKUP_KEYS` with the same keyring format if the customer's key policy wants separation.
- **Pragmas.** WAL and `busy_timeout = 5000` were already set in `openDb` and are unchanged. `synchronous` stays at the SQLite default (FULL) for durability.

### 6. Packaging

- **`Dockerfile`.**
  - Multi-stage. The UI is built in the build stage. The runtime stage has no node_modules: the server uses only Node built-ins and Node's type stripping.
  - Runs as `node` (uid 1000). Application files are root-owned. `/data` and `/backups` are volumes.
  - `AR_ENV=production` by default, so an unconfigured container refuses to start.
  - HEALTHCHECK on `/healthz`; `STOPSIGNAL SIGTERM`.
  - An optional BuildKit secret `extra_ca` lets the image build behind a TLS-inspecting proxy without copying the CA into the image.
- **`docker-compose.yml`.**
  - The app runs with `AR_WORKER=off`; the worker runs separately and starts after the app is healthy.
  - Persistent data and backup volumes.
  - `read_only: true`, tmpfs `/tmp`, `cap_drop: ALL`, `no-new-privileges`.
  - The port is bound to localhost, for a TLS reverse proxy.

### 7. CI (`.github/workflows/ci.yml`)

- **Check job.** Runs on push and pull_request, Node 22, no secrets, read-only token: typecheck, tests, build, the fixture evaluation, kb:verify, demo, and "production config fails closed" (exit 78).
- **Docker job.** Builds the image, checks that it refuses to start unconfigured, then checks that a synthetic container becomes ready on a read-only root filesystem and stops with exit 0.
- **Action versions.** `actions/checkout@v7` and `actions/setup-node@v7`, as shown in the setup-node README (retrieved 2026-10-14).

## Verification

**Test suites.**

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/production.test.ts` | 13 | Config fail-closed; production app surface; seed; headers; CORS; rate limits; body limit; timeout; error envelope; logs; redaction; probes; metrics; in-process shutdown; real API and worker processes; `AR_ENV=production` subprocess |
| `tests/sso.test.ts` | 11 | |
| `tests/backup.test.ts` | 4 | |

The full suite now has 167 tests, all passing. typecheck, build, the fixture evaluation (40/40, 141/141, 17/17, 35/35), demo and kb:verify are green.

**Mutation tests.** Each of these 19 gates was removed in turn, and its suite failed every time:

- CSRF, Origin;
- signature, nonce, issuer, expiry;
- state cookie, idle timeout, email_verified;
- session secret required, PHI key required;
- dev routes outside synthetic, dev bearer outside synthetic;
- simulator executor gate;
- log redaction;
- metrics token;
- CORS foreign POST;
- restore migration check, manifest digest.

**Docker.** The image was built locally. The build needed `--secret id=extra_ca` because of this environment's TLS proxy. Checks run:

- an unconfigured container exits with 78;
- a fully configured production container is ready, with dev login 404, HSTS and CSP present;
- the root filesystem is read-only and `/data` is writable;
- the worker container took an encrypted scheduled backup;
- `docker compose up` brought both services up;
- `scripts/admin.ts` provisioned a tenant, client, user, grant and SSO link;
- `scripts/backup.ts` produced a backup, and `scripts/restore.ts --force` into the stopped stack restored it;
- `docker stop` exits with 0 after `shutdown_complete`.

## What remains blocked or not done

- **Blocked on the owner or customer:**
  - BAAs and a covered host;
  - KMS or secrets manager and key escrow;
  - IdP registration and MFA policy;
  - penetration test;
  - SOC 2 decision;
  - off-site backup target and restore drills;
  - alerting.
- **Not verified:**
  - CSP in a real browser (none was available);
  - against a real Okta, Entra ID or Google tenant (no credentials; only the protocol from the specs and Microsoft's docs, and the local mock).
- **Not built:**
  - SCIM or a provisioning API;
  - checking the IdP's `acr`/`amr` claims;
  - multi-issuer or Entra multi-tenant support;
  - distributed rate limiting;
  - PostgreSQL (ADR 0001).
