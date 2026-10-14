# Operations guide (single-node pilot)

Status: draft for a pilot deployment, 2026-10-14 (ADR 0090). This guide covers the
mechanics: deploy, configure, keys, backups, upgrades, incidents. It does not make the deployment
fit for patient data. That also needs the contractual and organisational steps in
[SECURITY.md](SECURITY.md) and [compliance/README.md](compliance/README.md).

## 1. What runs

| Process | Command | Role |
| --- | --- | --- |
| API | `node server/main.ts` | HTTP API, UI, single sign-on. With `AR_WORKER=off` it runs no background work |
| Worker | `node server/worker.ts` | Outbox dispatch and reconciliation, voice steps, notifications, PHI re-encryption, retention, session purge, scheduled backups |

Both processes open the same SQLite database (WAL mode, `busy_timeout` 5 s, `BEGIN IMMEDIATE` for
every state change). Outbox claims are conditional updates, so the worker and the API never send
the same action twice. Run **one** worker. A second worker is safe for correctness but adds
nothing. SQLite means one host: do not put the database on a network filesystem.

## 2. Environments

`AR_ENV` selects the deployment kind. `server/config.ts` validates it at startup.

| | `synthetic` (default) | `staging` / `production` |
| --- | --- | --- |
| Sign-in | development identities and/or SSO | SSO (OIDC) only; development tokens refused |
| Seed data | demo tenants, users, grants | reference data only (rule definitions, calendars); no users |
| Simulators (payer, PM, clearinghouse, FHIR, voice scripts) | on | routes absent, executors refuse, connectors disabled |
| Draft rules as baseline | yes | never; only approved activations run |
| Missing configuration | defaults | **refuses to start** (exit 78), listing every problem |
| HSTS / `upgrade-insecure-requests` | no | production only / both |
| `/metrics` | open unless a token is set | bearer token required |
| Backup encryption | optional | mandatory |

`AR_ENVIRONMENT` (`shadow` | `assisted_live`) is the rollout stage that the connector and PHI
gates use (ADR 0030/0070). Outside synthetic it must be set explicitly. Inside synthetic it must
be unset or `synthetic`.

## 3. Deploy with Docker Compose

Prerequisites:

- A Linux host with Docker.
- A TLS-terminating reverse proxy in front of port 8080 (Caddy, nginx or a cloud load balancer). Set `AR_TRUST_PROXY_HOPS=1`.
- An OIDC application registered at the customer's IdP.

1. **Register the OIDC application** at the IdP (Okta, Microsoft Entra ID or Google Workspace):
   - Type: web application with a client secret, authorization code flow.
   - Redirect URI: `https://<host>/api/auth/callback`.
   - Optional post-logout redirect URI: `https://<host>/`.
   - Turn on MFA in the IdP sign-on policy for this application. AR Resolve does not run its own MFA.
   - Note the issuer URL exactly as the IdP's discovery document states it. For Entra ID that is the tenant-specific v2.0 issuer, not `common`.
2. **Write `.env`** from `.env.example`. Fill every value marked REQUIRED and keep the file out of version control. Generate secrets with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # AR_SESSION_SECRET, AR_METRICS_TOKEN
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # a PHI key
   ```

   Use a secrets manager where you have one: inject the variables at runtime rather than storing `.env` on disk.
3. **Start the stack**: `docker compose up -d --build`.
   - The API applies migrations, then becomes healthy.
   - The worker starts after the API is healthy.
   - If configuration is incomplete, the API exits with code 78 and its log lists every problem.
4. **Provision access.** Sign-in never creates users or roles. An operator records them:

   ```bash
   docker compose exec app node scripts/admin.ts tenant-add tn_acme "Acme Billing" --actor "Your Name"
   docker compose exec app node scripts/admin.ts client-add tn_acme cl_clinic1 "Clinic One" --actor "Your Name"
   docker compose exec app node scripts/admin.ts user-add u_jdoe "J. Doe" --actor "Your Name"
   docker compose exec app node scripts/admin.ts grant u_jdoe tn_acme cl_clinic1 reviewer --actor "Your Name"
   docker compose exec app node scripts/admin.ts sso-link u_jdoe --email jdoe@acme.example --actor "Your Name"
   docker compose exec app node scripts/admin.ts list
   ```

   - A link by `--email` is bound to the IdP subject on that person's first sign-in, and only if the IdP asserts `email_verified=true`.
   - A link by `--subject` (the IdP `sub` claim) needs no email.
   - Every command is recorded in `auth_events`. Grant changes are also recorded in the tenant's hash-chained audit log.
5. **Check health.**
   - `GET /healthz` is liveness.
   - `GET /readyz` is readiness: database writable, migrations applied, PHI key and session secret loaded, not draining.
   - Point Prometheus at `GET /metrics` with `Authorization: Bearer $AR_METRICS_TOKEN`.

The container runs as user `node` (uid 1000) on a read-only root filesystem. Only `/data`,
`/backups` and a `/tmp` tmpfs are writable. All capabilities are dropped, with `no-new-privileges`.

## 4. Configuration reference

The full list, with defaults, is in `.env.example` and `server/config.ts`. Highlights:

| Setting | Notes |
| --- | --- |
| `AR_SESSION_TTL_HOURS` / `AR_SESSION_IDLE_MINUTES` | Absolute (default 10 h outside synthetic) and idle (30 min) session limits, enforced server-side |
| `AR_ALLOWED_ORIGINS` | Exact https origins allowed to make credentialed cross-origin calls. Same-origin use needs only `AR_PUBLIC_BASE_URL` |
| `AR_RATE_LIMIT_IP_PER_MIN` / `AR_RATE_LIMIT_KEY_PER_MIN` | Token buckets per client IP and per credential (API key or session). In-process, so the limit applies per API process |
| `AR_BODY_LIMIT_BYTES`, `AR_REQUEST_TIMEOUT_MS`, `AR_HANDLER_TIMEOUT_MS` | Request size and time limits. A handler timeout returns 503 `timeout`; the work may still complete, so check state before retrying |
| `AR_SHUTDOWN_GRACE_MS` | How long SIGTERM waits for in-flight requests (compose gives the containers 30 s and 60 s) |
| `AR_LOG_LEVEL` | JSON logs on stdout/stderr. No request bodies, query strings, tokens or PHI-shaped values are logged (see SECURITY.md) |

## 5. Keys and secrets

### PHI keys

PHI keys seal free text at rest and derive the backup encryption keys. The rotation procedure
reuses the ADR 0080 mechanism:

1. Generate a new key and add it to `AR_PHI_KEYS` (for example `k1:<old>,k2:<new>`). Set `AR_PHI_ACTIVE_KEY_ID=k2`. Restart both containers.
2. In each client, start re-encryption: on the Data governance page, or `POST /api/governance/phi-keys/rekey` as a supervisor. The worker advances the job in batches. It is resumable and audited.
3. When `GET /api/governance/phi-keys` shows no value under `k1` in any client, retire `k1` (`POST /api/governance/phi-keys/k1/retire`). Retirement is refused while anything still uses it.
4. **Backups:** every backup sealed under `k1` still needs `k1` to restore. After retirement, move `k1` out of the running configuration into offline key escrow (two people, sealed record). Keep it until the last backup sealed under it has expired under the backup retention policy. Only then destroy it.

### Other secrets

| Secret | Rotation |
| --- | --- |
| Session secret (`AR_SESSION_SECRET`) | Changing it signs everyone out: stored session hashes and CSRF tokens no longer match. Rotate during a quiet period, or immediately after suspected exposure |
| OIDC client secret | Create a new secret at the IdP, update `AR_OIDC_CLIENT_SECRET`, restart the API, then revoke the old secret at the IdP |
| Metrics token | Update `AR_METRICS_TOKEN` and the Prometheus scrape config together |
| API keys (`ark_…`) | Create a replacement on the API keys page, move the client to it, revoke the old key (ADR 0080) |

## 6. Backups and restore

**What a backup is.**

- An online, page-by-page SQLite backup through `node:sqlite` `backup()`. It is consistent while the app keeps writing.
- Each copy must pass `PRAGMA integrity_check` before it is kept.
- The copy is sealed with AES-256-GCM. The key is derived with HKDF-SHA256 from the active PHI key.
- Each backup has a manifest (`*.arbk.json`) with its SHA-256 and the PHI key id.

**When backups run.**

- The worker takes one every `AR_BACKUP_INTERVAL_MINUTES` (default 60) and keeps the newest `AR_BACKUP_KEEP` (default 48).
- To take one on demand: `docker compose exec app node scripts/backup.ts`.
- `ar_backup_last_success_timestamp_seconds` in `/metrics` reports the last success. Alert when it is older than two intervals.

**Off-site copies.** `/backups` is a local volume. Copy it off the host on a schedule, for example with object storage that has versioning and object lock. Copy the files as they are: they are already encrypted.

**Restore** (the application must be stopped):

```bash
docker compose stop
docker compose run --rm --no-deps app node scripts/restore.ts /backups/<file>.arbk --force
docker compose start
```

The restore:

1. checks the manifest digest;
2. decrypts with the PHI key named in the header, which must be in `AR_PHI_KEYS`, so restore it from escrow first if it was retired;
3. checks integrity and that migrations are present;
4. moves the current database aside as `<db>.pre-restore-<time>` (never deletes it);
5. moves the restored file into place.

The API then applies any newer migrations at startup.

**Test restores.** `tests/backup.test.ts` restores and verifies on every CI run. In addition, restore the latest production backup into a scratch environment at least monthly and record the result.

## 7. Upgrades

1. Read the release notes and ADRs for new migrations. Migrations are forward-only and applied at API startup inside a transaction each.
2. Take a backup: `docker compose exec app node scripts/backup.ts`.
3. Run `docker compose build && docker compose up -d`. SIGTERM drains the old API (readiness turns 503, in-flight requests finish within the grace period) and lets the worker finish its current item.
4. Check `/readyz` (migrations: all applied) and the logs.
5. **Rollback:** restore the pre-upgrade backup with the previous image. Newer migrations are not reversible in place.

## 8. Incident basics

| Situation | First actions |
| --- | --- |
| Suspected account compromise | `node scripts/admin.ts sessions-revoke <userId>`; `sso-disable <linkId>`; disable the user at the IdP; review `auth_events` and the audit log |
| Leaked API key | Revoke it on the API keys page; every request it made is in the audit log (`api_key_request`) |
| Wrong or runaway automation | Pause the client, payer or workflow (Operations page, ADR 0040); the outbox stops dispatching |
| Suspected secret exposure | Rotate the affected secret (section 5); for a PHI key, rotate and re-encrypt, and keep the old key only in escrow |
| Database corruption / host loss | Restore the latest good backup on a new host (section 6) |
| Breach assessment | Follow the customer contract and counsel; notification duties are legal determinations, not engineering ones |

Preserve logs and the database file before changing anything. Restart automation only after root
cause, replay validation and an authorised release decision (build pack doc 08).
