# Security overview

Status: draft, 2026-10-14 (ADR 0090). This document describes the controls that are built and
tested. It also lists what the owner and the customer must still do before any real patient data
is processed.

**AR Resolve is not HIPAA compliant, has no SOC 2 report, has not been penetration tested and holds
no security certification.** The controls below are engineering controls. Compliance depends on
contracts, policies, people and independent assessment, none of which code can supply. See
[compliance/README.md](compliance/README.md).

## Threat model summary

The assets:

- claim and patient-account data, which becomes PHI once real data is loaded;
- payer and vendor credentials;
- the approval chain for financial requests;
- the audit trail.

| Threat | Controls built | Where tested |
| --- | --- | --- |
| Unauthenticated or forged sign-in | OIDC authorization code + PKCE (S256). `state` bound to the browser by an HttpOnly cookie and single-use. `nonce` checked. ID token signature verified against the IdP JWKS (asymmetric algorithms only; `none`/HMAC refused). `iss` exact, `aud` = client (single audience), `azp`, `exp`, `iat`, `nbf` checked | `tests/sso.test.ts` (mock IdP signing real JWTs) |
| Privilege escalation through sign-in | Sign-in never creates users or roles. IdP identities map to users only through the operator-managed `sso_identities` table. Email-based pre-links bind only when the IdP asserts `email_verified=true` | `tests/sso.test.ts` |
| Session theft or fixation | Random 256-bit session id in an HttpOnly, Secure, SameSite=Lax cookie (`__Host-` prefix outside synthetic). Only an HMAC of the id is stored. Absolute and idle expiry enforced server-side. Logout revokes server-side. Disabling an identity revokes its sessions | `tests/sso.test.ts` |
| Cross-site request forgery | Every cookie-authenticated mutation needs `x-csrf-token` (HMAC of the session, never stored). An Origin header, when present, must be allowed. Cross-origin mutations from unknown origins are refused before routing | `tests/sso.test.ts`, `tests/production.test.ts` |
| Cross-client data access | Server-derived tenant/client scope on every route, role permissions, human-only permissions that API keys can never hold (ADR 0001, 0080) | `tests/scope.test.ts` and every suite |
| Synthetic shortcuts reaching production | `AR_ENV` gate: outside synthetic there is no dev login, development tokens are refused, there are no simulator routes, simulator executors refuse, simulated connectors are disabled and draft rules never run as a baseline | `tests/production.test.ts` (in process and in a separate `AR_ENV=production` process) |
| Misconfigured deployment | Staging and production refuse to start (exit 78) when any required setting is missing or weak: session secret, PHI keys, OIDC, https origins, database path, metrics token, backup directory and encryption | `tests/production.test.ts` (each setting removed in turn) |
| Browser-side attacks | CSP (`script-src 'self'`, no inline or eval, `frame-ancestors 'none'`, `object-src 'none'`); HSTS in production; `nosniff`; `X-Frame-Options: DENY`; `Referrer-Policy: no-referrer`; COOP/CORP; Permissions-Policy | `tests/production.test.ts` |
| Abuse and resource exhaustion | Per-IP and per-credential rate limits (429 + Retry-After); body size limit (413); header, request and handler timeouts | `tests/production.test.ts` |
| Information leakage in errors | One error envelope `{code, message, details, requestId}`. 500s say only "Internal error". Stacks are never sent, and are logged only in synthetic | `tests/production.test.ts` |
| PHI or secrets in logs | Structured JSON logs carry the route pattern (never the raw path or query string). Sensitive field names are redacted at any depth. Values are scrubbed of bearer tokens, API keys, JWTs, emails, phone numbers, SSN- and date-shaped strings | `tests/production.test.ts` (PHI-shaped probe) |
| Data loss | Online encrypted backups, verified by integrity check, digest manifest, tested restore; WAL with busy timeout | `tests/backup.test.ts` |
| Backup theft | Backups sealed with AES-256-GCM. The key is derived from the PHI key and the key id is bound as additional data. Tampering, a wrong key or a missing key are refused | `tests/backup.test.ts` |
| Duplicate or unapproved financial actions | Approval bound to payload hash and account revision; idempotent outbox; read-back reconciliation (ADR 0001) | `tests/review-execution.test.ts` |
| Forged webhooks | HMAC signature, replay and staleness checks (ADR 0030/0070) | `tests/integrations.test.ts`, `tests/maya-port.test.ts` |
| Prompt injection via evidence or transcripts | Evidence is typed data; the deterministic Guard; no model holds an authorization role (ADR 0070) | `tests/maya-port.test.ts`, `tests/voice.test.ts` |

Every gate above was mutation-tested: removing the guarded condition makes its test fail
(ADR 0090 lists the 19 mutations).

## Controls built (summary)

| Area | Controls |
| --- | --- |
| Identity | OIDC SSO (works with any OpenID Provider that publishes discovery, for example Okta, Microsoft Entra ID and Google Workspace); MFA delegated to the IdP's sign-on policy; named, expiring, role-bounded API keys for machines (ADR 0080) |
| Sessions | Server-side, HMAC-stored, absolute and idle expiry, CSRF synchronizer token, logout with IdP end-session URL |
| Authorization | Tenant/client scope, roles, separation of duties, human-only permissions |
| Transport | HSTS and https-only configuration outside synthetic; TLS is terminated by the operator's reverse proxy |
| Data at rest | Free-text PHI columns sealed with AES-256-GCM under a rotatable keyring (ADR 0080); encrypted backups |
| Audit | Hash-chained per-tenant audit log; `auth_events` for sign-in, refusal, logout and every operator change (append-only by trigger) |
| Operations | Readiness and liveness probes, Prometheus metrics behind a token, graceful shutdown, non-root read-only container |
| Supply chain | No runtime npm dependencies in the image (Node built-ins only); CI runs typecheck, tests, build, fixture evaluation, KB verification and an image build on every push and pull request, with no secrets |

## What the owner and the customer must still do

None of the following can be done in code.

1. **BAAs.** Sign Business Associate Agreements with the customer and with every subprocessor that will touch PHI (hosting, any model or telephony vendor). Record them in the vendor register. Status today: none signed (`compliance/baa-tracker.md`).
2. **Hosting decision.** Choose a host covered by a BAA. Run the stack there behind a TLS reverse proxy. Manage secrets in a secrets manager, not in a file on disk.
3. **Key management.** Generate the PHI keys and session secrets. Store them in a managed KMS or secrets manager. Set up two-person offline escrow for retired PHI keys that backups still need.
4. **IdP configuration.** The customer registers the OIDC application, enforces MFA for every user of the application, and owns joiner/mover/leaver processes. Operators mirror role changes with `scripts/admin.ts`.
5. **Policies and people.** Name a security officer. Complete the risk assessment. Adopt access-control, incident-response, backup/contingency and workforce-training policies (drafts in `compliance/policies/`).
6. **Independent testing.** Commission a penetration test of the deployed pilot before real data. Fix the findings and record them.
7. **SOC 2 readiness.** Decide scope and auditor (`compliance/soc2-roadmap.md`). The controls and evidence here are inputs, not an attestation.
8. **Off-site backups and restore drills.** Copy `/backups` off the host with versioning and object lock. Restore into a scratch environment at least monthly and keep the record.
9. **Monitoring and alerting.** Scrape `/metrics`. Alert on readiness, error rate, the age of the last backup and outbox items stuck as `uncertain`. Ship logs to a store with access control and a retention period.
10. **Dependency and image scanning.** Add container and dependency scanning in the customer's CI or registry. Pin the base image by digest.

## Known limitations

| Limitation | Notes |
| --- | --- |
| One issuer | One OIDC issuer per deployment. Multi-tenant Entra (`common`) issuers are not supported |
| No SCIM or provisioning API | Operators use `scripts/admin.ts` with host access |
| In-process rate limits | Correct for the single-node pilot, not for several API replicas |
| SQLite | Single host only. ADR 0001 plans the move to PostgreSQL for multi-node operation |
| CSP not browser-tested | CSP was checked against the built HTML and code, not in a browser session (none was available in the build environment) |
| No MFA claim check | AR Resolve does not check an MFA claim (`amr`/`acr`) itself; it relies on the IdP policy. Requesting and checking `acr` is a possible later control |
