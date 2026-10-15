# ADR 0120: Hosted synthetic demo on Cloudflare Containers

Date: 2026-10-15. Status: accepted; built and run locally, not yet deployed.

## Context

The owner asked for the app to be hosted on Cloudflare so the Connect providers page (ADR 0110) and
the rest of the app can be opened from a link. AR Resolve is a long-running Node server with a
SQLite file and a background worker. A plain Worker cannot run it: Workers have no `node:sqlite`,
no local file and no long-lived process.

## Decisions

- **Cloudflare Containers** run the existing production `Dockerfile` unchanged. A small Worker
  (`deploy/cloudflare/worker.ts`) forwards every request to one named container instance, so all
  visitors share one demo database. Sources, retrieved 2026-10-15:
  https://developers.cloudflare.com/containers/ (Workers Paid plan; images must run on
  linux/amd64; "All disk is ephemeral by default"), the Wrangler configuration page, the
  `@cloudflare/containers` 0.3.7 README, and the wrangler 4.145.0 config schema (`instance_type`,
  `image_build_context`).
- **The container runs `AR_ENV=synthetic` only.** That keeps every existing synthetic-only rule:
  development sign-in, simulators, production mode refused on Connect providers, no PHI.
- **A password page in the Worker** guards everything, because development sign-in lets anyone who
  reaches the app act as any demo user, including the supervisor. The password is the
  `DEMO_PASSWORD` Worker secret (at least 12 characters; unset locks the demo with 503). After the
  form, the Worker sets an HttpOnly, Secure, SameSite=Lax cookie holding a SHA-256 of the password.
  A cookie, not HTTP Basic auth, because the app already uses the Authorization header for its own
  Bearer tokens and Basic auth would collide with it (found while testing; the first version used
  Basic auth). Mutation-tested: three mutations in `stress:mutate`.
- Wrangler and `@cloudflare/containers` live in `deploy/cloudflare/package.json`, not the root, so
  the app image and CI do not install them. Versions are pinned to releases at least two weeks old.

## Costs

- Containers need the Workers Paid plan and are billed while the instance runs. `sleepAfter` is
  30 minutes, so an idle demo stops costing.
- **The demo resets.** Container disk is ephemeral, so after 30 idle minutes the database and any
  keys entered on Connect providers are gone and the next visitor gets fresh synthetic data. Only
  vendor sandbox/test keys belong in this demo, never production keys.
- One shared password, not per-person accounts; anyone with it is every demo user. No attempt
  limit in the Worker; a Cloudflare rate-limiting rule or Cloudflare Access would add one.
- The cookie is an unsalted hash of the password; a stolen cookie allows offline guessing, which is
  why the password minimum is 12 characters.

## Reversal conditions

- A real pilot (staging/production with SSO) needs persistent storage: a VM or a container platform
  with a volume, per ADR 0090 and docs/OPERATIONS.md. This demo setup is not that.
- If Cloudflare Access is set up for the owner's team, the password page can be removed.

## Verification (2026-10-15, in this environment)

- `npx wrangler deploy --dry-run` builds the Worker and the container image.
- `npx wrangler dev` (Worker and container on Docker locally): no cookie gives 401 and the password
  page; a wrong password gives 401; the right one gives 303 and a cookie; then `/healthz`,
  `/api/auth/config` and the UI load, Sam (supervisor) signs in, and Connect providers renders.
- `tests/cloudflare-gate.test.ts`; `stress:mutate` catches all three gate mutations.

## Blocked

- The real deploy. This session's network policy refuses api.cloudflare.com, and there is no
  Cloudflare API token here. Either the owner deploys from their own machine (Docker running):
  `cd deploy/cloudflare && npm ci && npx wrangler login && npx wrangler secret put DEMO_PASSWORD && npx wrangler deploy`,
  or the environment allows the Cloudflare hosts and holds `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` as secrets.
