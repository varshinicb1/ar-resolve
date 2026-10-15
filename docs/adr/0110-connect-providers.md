# ADR 0110: Connect providers (keys and modes entered in the app)

Status: accepted for the synthetic build. Migration `110_connector_settings.sql`. Code: `server/connectors/live/connector-settings.ts`, `server/http/routes/connector-settings.ts`, `web/src/pages/ConnectProviders.tsx`.

## Context

The owner asked for one page where all provider API keys can be entered and each provider switched between sandbox and production, instead of editing environment files. ADR 0100 read keys only from the environment. This ADR adds an in-app store under the environment, without weakening the ADR 0100 gate.

## Decisions

1. **Deployment-level store.** `connector_settings` holds one row per provider and variable name, plus a mode row. There are no tenant or client columns, because these values stand in for environment variables (the same documented exception as `live_smoke_runs`). Only names declared in `SPECS` (`config.ts`) and each provider's mode variable are accepted. Base URL overrides, `AR_LIVE_ALLOW_LOOPBACK`, `AR_PHI_MODE` and OIDC stay environment-only.
2. **Sealing.** Secret values are sealed with AES-256-GCM through `services/phi.ts` (`enc:v2:<key id>:…`). A table CHECK refuses an unsealed secret row. The key is the PHI keyring from the environment when one is configured. Outside `AR_ENV=synthetic` without a keyring, storing a secret is refused (409 `sealing_key_missing`, naming `AR_PHI_KEYS`/`AR_PHI_ACTIVE_KEY_ID`/`AR_PHI_KEY`); non-secret values still save. In synthetic only, a per-installation key file `connector-settings.key` is created next to the database, or at `AR_CONNECTOR_KEY_FILE`, with mode 0600. A file readable by others is refused, and the page says which key is in use. Stored values that the current keys cannot open are reported as "cannot be opened" and treated as missing.
3. **Nothing in clear.** API responses show a secret's last 4 characters at most, and none for values under 12 characters. Audit rows carry names and actions only. The append-only `connector_setting_changes` history holds a `…last4` fingerprint for secrets. Validation errors never echo a value. Test result lines are scrubbed of every stored secret before they are returned or recorded.
4. **Precedence.** `config.ts` gains `liveEnv()`, which takes the environment and fills in stored values only for names the environment leaves unset (direct or `<NAME>_FILE`). Every default argument in `config.ts`, `providerGate` and `smokeRefusals` now uses it, so the gate, the adapters, the overview and `smoke:live` all see stored values. A name set in the environment is locked: saving it returns 409 `locked_by_environment`.
5. **Cache.** Opened values are cached per process. The cache is dropped on every save in that process, which also clears the OAuth token cache. Elsewhere it lives at most 5 s, so a separate `npm run worker` process picks up a change within 5 s. The worker and `smoke:live` register the store too.
6. **API** (all `integration_admin`; others get 403, and a user without the scope gets 404):
   - `GET /api/integrations/connect`
   - `GET /api/integrations/connect/:provider/history`
   - `PUT /api/integrations/connect/:provider/values` (`{values, clear}`; an empty string leaves a value unchanged)
   - `PUT /api/integrations/connect/:provider/mode`
   - `POST /api/integrations/connect/:provider/test`

   The router now reads bodies for PUT, and CORS preflight allows PUT. Recording a customer authorization stays on `POST /api/integrations/connectors/:id/authorization`.
7. **Modes.** Production is refused in a synthetic deployment (409 `production_needs_non_synthetic`). Elsewhere it can be chosen, and the ADR 0100 production gate still applies on top: authorization with covered-service verification, BAA, onboarding, non-synthetic rollout stage, `AR_PHI_MODE=on`, and the per-client live switch. Mode changes are audited (`connector_mode_changed`).
8. **Test.** The test runs the existing `runSmoke` checks in-process with vendor-documented test data. It refuses in production mode exactly as `smoke:live` does. It runs at most once per provider per 10 s, per process (429 otherwise), and is recorded in `live_smoke_runs` with `run_by = app:<user>`. When a base URL override points at loopback, the run is recorded as target `local_mock`, not `vendor_sandbox`, so a rehearsal is never reported as a vendor result.
9. **Page.** It shows six provider sections in the order Stedi, Availity, Optum, Twilio, Slack, Postmark. Each has the mode control, plain labels with the env var name underneath, password inputs that are never prefilled, field state, Save, Clear, Test sandbox, authorization, the gate in plain words and a "Where to get this" link (URLs from INTEGRATIONS_SETUP.md). A read-only OIDC panel follows. The page is reachable from the nav and from the Live connectors panel.

## Costs

- **Any supervisor of any client can change deployment-wide keys.** `integration_admin` is a per-client role, and there is no deployment-admin role yet. Acceptable for a single-customer pilot. It is recorded as blocked item CON08.
- A secret now lives in the database, sealed, as well as possibly in the environment. Backups carry it, sealed (backup encryption is required outside synthetic). Rotating the PHI keyring needs the stored secrets re-entered or re-sealed: `phi-keys.ts` re-encryption does not cover this table.
- The synthetic key file sits next to the database. Anyone who copies both can open the secrets. That is acceptable only for synthetic test keys, which is why it is refused elsewhere.
- The 5 s cache means a second process can use an old key for up to 5 s after a change.
- The rate limit is in memory and per process.

## Reversal conditions

- If a deployment-admin role is introduced, switch the permission check in `connector-settings.ts` (one function, `admin`).
- To go back to environment-only, drop the route module line. Stored values are then ignored, because `liveEnv()` returns the environment unchanged when no store is registered.
- If secrets must never touch the database (customer policy), refuse secret names in `saveValues` and keep the page for modes, non-secret values and tests.

## Stedi documentation re-check (2026-10-15)

https://www.stedi.com/docs/healthcare/api-reference was re-read. It still says:

- there are two key types, test and production;
- the key goes in the `Authorization` header with no `Bearer` (the older `Key <key>` form is still accepted);
- the same hosts serve both key types;
- keys are created under API keys, with Test or Production chosen at creation, shown once and never expiring.

Differences from what ADR 0100 recorded, none of which changes the code:

1. The page now says test keys work for all claims-processing endpoints except real-time claim status (276/277, JSON and raw X12). ADR 0100 mentioned only eligibility mock requests. Claim status remains test-mode-less, which matches the smoke SKIP.
2. The page gives rate limits as pools per category: claims processing and enrollment at 100 requests per second, and concurrency of 50 for eligibility, 100 for claims and 5 for insurance discovery, per account. It does not say whether test keys differ.
3. Production keys keep the permissions of the member who created them.

The page does not mention sandbox accounts. The "free sandbox account" statement in ADR 0100 came from the account-settings page, which was not re-read.

## Verification

- `tests/connector-settings.test.ts`: 12 tests over the real HTTP API with a local vendor mock.
  - Every response body and every captured log line is checked for the secret. So are `audit_events`, `connector_setting_changes`, `live_smoke_runs`, `connector_events` and `connector_settings`.
  - End to end: the key is saved via the API, the test runs via the API, and the Stedi adapter's eligibility call is made through the gate. The mock sees the stored key in `Authorization` both times.
  - Non-synthetic is exercised with a second app instance using a staging config.
- Mutation checks, added to `npm run stress:mutate`. **10 of 10 caught:**
  - stored value beats the environment
  - sealing key not required outside synthetic
  - secret stored unsealed
  - production allowed in synthetic
  - test runs in production
  - rate limit removed
  - `integration_admin` check removed
  - GET returns the secret
  - audit carries values
  - stored values not used by the adapter
- Screenshot: the built app as u_sam with a fake Stedi test key (`test_fake_0000`), with Stedi pointed at the local mock. Test sandbox passed, recorded as `local_mock`.

## Blocked or unverified

- No real vendor sandbox was called. There are no vendor keys in this environment, so the first real "Test sandbox" per provider is still owed.
- There is no deployment-admin role (CON08).
- PHI keyring rotation does not re-seal `connector_settings`.

## Shared core files touched (small edits)

- `server/http/app.ts`: read the body for PUT as well as POST (one condition).
- `server/http/hardening.ts`: CORS preflight allows PUT.
- `server/http/modules.ts`: one route module.
- `server/worker.ts`: registers the store (one import, one line).
- `server/connectors/live/config.ts`: `liveEnv()`, `envProvides()`, `storableNames()`, `setStoredSettingsSource()`; defaults use `liveEnv()`.
- `server/connectors/live/gate.ts`, `server/connectors/live/smoke.ts`: default env argument uses `liveEnv()`.
- `scripts/smoke-live.ts`: reads stored values; the production check uses the effective mode.
- `scripts/stress/mutate.ts`: optional per-mutation suite and ten mutations.
- `web/src/api.ts`: `api.put`.
- `web/src/App.tsx`: nav item and route.
- `web/src/pages/LiveConnectors.tsx`: link and wording.
- `web/src/styles.css`: appended block.
- `README.md`, `docs/COMPLETION_MATRIX.md`, `docs/INTEGRATIONS_SETUP.md`, `.env.example`: documentation.
