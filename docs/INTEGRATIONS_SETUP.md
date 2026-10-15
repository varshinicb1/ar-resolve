# Integrations setup (ADR 0100)

What a person has to obtain before each real connector can run, and how to check it. Every vendor fact below comes from the vendor's own documentation, retrieved on 2026-10-14; the URL is next to each fact. Anything we could not confirm says **NOT FOUND** or **unverified**. Costs appear only where the vendor states them.

## Enter keys in the app (ADR 0110)

The simplest path: sign in as a supervisor, open **Integrations > Connect providers** (`#/connect`), and for each provider:

1. click **Where to get this** to open the vendor's signup or key page, create a sandbox/test key;
2. paste the values and press **Save** (secrets are sealed before they are stored and never shown again; the page shows only "Saved, ends in 4f2a, by Sam on 15 Oct");
3. choose **Sandbox**;
4. press **Record an authorization** (reference and reason) for the client you are working in;
5. press **Test sandbox**: it runs the same checks as `npm run smoke:live` against the vendor sandbox and shows pass/fail lines.

Rules: an environment variable (or `<NAME>_FILE`) always wins and the field shows "Set in environment"; Production cannot be chosen in a synthetic deployment, and in a real one the production gate below still applies; a test never runs in production mode and runs at most once per provider every 10 seconds. Outside `AR_ENV=synthetic`, secrets are stored only when `AR_PHI_KEYS` + `AR_PHI_ACTIVE_KEY_ID` (or `AR_PHI_KEY`) is set; in synthetic, a per-installation key file is created next to the database (mode 0600; override with `AR_CONNECTOR_KEY_FILE`). Company sign-in (OIDC) is read at startup and stays in the environment; the page shows which `AR_OIDC_*` settings are present. Keys saved here are deployment-wide, not per client.

The environment variables below remain the alternative (containers, secrets managers).

All providers are **off** by default. A provider runs only when all of these hold (see `server/connectors/live/gate.ts`):

1. its mode is `sandbox` or `production` (mode variable, or set on the Connect providers page);
2. its keys are present (env var, `<NAME>_FILE` pointing at a secrets file, or saved on the Connect providers page);
3. a customer authorization is recorded for the tenant/client (`POST /api/integrations/connectors/:id/authorization`) and has not been revoked;
4. production only: the existing live gate (covered-service verification, BAA reference, onboarding, non-synthetic environment, BAA register), `AR_PHI_MODE=on`, and the connector switched to live for that client.

Sandbox calls refuse any account whose identifiers are not synthetic. Payer writes still go through approval and the outbox; nothing here bypasses review. This document does not make the product HIPAA compliant or certified, and it makes no accuracy or recovery claims.

## Summary

| Provider | What it unlocks | Self-serve test keys? | Contract / BAA needed for real data | Env vars |
| --- | --- | --- | --- | --- |
| Stedi | Eligibility 270/271 and claim status 276/277 (raw X12) into evidence and facts; 835 ERA polling | Yes: free sandbox account, test API key (mock eligibility requests only; claim status has no test mode) | Self-serve upgrade to a paid plan, which includes agreeing to Stedi's BAA; ERAs also need transaction enrollment with each payer | `AR_STEDI_MODE`, `AR_STEDI_API_KEY` |
| Availity | Coverages (eligibility) inquiry, stored as connector events | Yes: Demo plan is auto-approved, no cost, canned responses | Standard plan through a contract with a Trading Partner Manager; BAA **NOT FOUND** | `AR_AVAILITY_MODE`, `AR_AVAILITY_CLIENT_ID`, `AR_AVAILITY_CLIENT_SECRET`, optional `AR_AVAILITY_MOCK_SCENARIO_ID` |
| Optum / Change Healthcare | Eligibility v3 (events) and claim status v2 (JSON, into facts) | Sandbox access by request form, no financial obligation (not instant self-serve) | Production contract or subscription; BAA **NOT FOUND** | `AR_OPTUM_MODE`, `AR_OPTUM_CLIENT_ID`, `AR_OPTUM_CLIENT_SECRET` |
| Twilio | Sandbox: test-credential call to documented magic numbers. Production payer calls are not wired | Yes: test credentials in the Console; test calls are not placed and not charged | Live account plus a signed BAA before PHI (terms not verified in this workstream) | `AR_TWILIO_MODE`, `AR_TWILIO_TEST_ACCOUNT_SID`, `AR_TWILIO_TEST_AUTH_TOKEN` (production vars listed below) |
| Slack | Staff notifications through an incoming webhook (opaque summaries, no account details) | Yes: create an incoming webhook in your own workspace | No PHI is sent; BAA not researched | `AR_SLACK_MODE`, `AR_SLACK_WEBHOOK_URL` |
| Postmark | Staff email (opaque summaries) | Yes: the documented `POSTMARK_API_TEST` token validates without delivering; a confirmed sender signature is still needed | Postmark states it cannot sign a BAA: **never for PHI** | `AR_POSTMARK_MODE`, `AR_POSTMARK_FROM`, `AR_POSTMARK_SMOKE_TO`, `AR_POSTMARK_SERVER_TOKEN` (production) |
| Epic | Not built. FHIR access requirements only | App registration on fhir.epic.com; non-production client ID usable in the open.epic sandbox | Each customer signs the open.epic API Subscription Agreement | none |
| athenahealth | Not built | **NOT FOUND** (docs not readable from here) | **NOT FOUND** | none |

## How to check a provider

```bash
npm run smoke:live -- stedi            # real sandbox, documented test data only
npm run smoke:live -- stedi --mock     # rehearsal against a local mock, no keys needed
npm run smoke:live -- stedi --no-record
```

Providers: `stedi`, `availity`, `optum`, `twilio`, `slack`, `postmark`. Exit codes: 0 pass, 1 fail, 2 refused. The command refuses when the mode is not `sandbox`, when a required variable is missing, and always in `production` mode, including with `--mock`. The result is written to `live_smoke_runs` in the database at `AR_DB` (default `data/ar-resolve.db`) and shown on the Integrations page (Live connectors panel), together with the mode, which variables are present or missing (names only, never values), the authorization status and the gate reasons.

Every variable is listed in `.env.example`. Secrets can be supplied as `<NAME>_FILE=/run/secrets/...` instead of the value. Base URL overrides (`AR_*_BASE_URL`) must be public https URLs; loopback is accepted only with `AR_LIVE_ALLOW_LOOPBACK=1`, which only tests and mock rehearsals set.

## Stedi

- **Sign up:** create an account; "New accounts start as free sandbox accounts, which are limited to test mode" (https://www.stedi.com/docs/healthcare/account-settings).
- **Keys:** create a test API key at https://portal.stedi.com/app/settings/api-keys. The key goes in the `Authorization` header with no `Bearer` prefix (https://www.stedi.com/docs/healthcare/api-reference).
- **Test mode:** test keys return mock eligibility responses only for the documented mock requests (https://www.stedi.com/docs/healthcare/api-reference/mock-requests-eligibility-checks). The smoke test sends the documented UnitedHealthcare mock (payer 87726, NPI 1999999984, member UHC202649), which equals the OpenAPI example `EligibilityRawX12Check_example1` (https://raw.githubusercontent.com/Stedi/openApi/main/healthcare.json).
- **Claim status:** production keys only, no test mode (https://www.stedi.com/docs/healthcare/api-reference/post-healthcare-claim-status-raw-x12). The smoke test marks it SKIP.
- **Production:** self-serve "Upgrade account"; upgrading to a paid plan includes MFA and agreeing to a BAA (https://www.stedi.com/docs/healthcare/account-settings; BAA text at https://legal.stedi.com/legal/baa-4a521009). Price: not stated on the pages read.
- **ERAs:** need transaction enrollment with each payer (https://www.stedi.com/docs/healthcare/claim-responses-overview). Polling: https://www.stedi.com/docs/healthcare/api-reference/get-poll-transactions; report: https://www.stedi.com/docs/healthcare/api-reference/get-healthcare-reports-835.
- **Timing:** payers can take up to 60 s and Stedi holds requests up to 120 s; retrying early can create duplicate payer requests (https://www.stedi.com/docs/healthcare/send-eligibility-checks). We do not retry 5xx or timeouts for that reason.
- **Env:** `AR_STEDI_MODE=sandbox`, `AR_STEDI_API_KEY`. Smoke: `npm run smoke:live -- stedi`.

## Availity

- **Sign up:** developer portal https://developer.availity.com/. "Availity automatically approves subscriptions to the Demo plan"; Demo is "at no cost to you", gives canned responses and "does not allow for end-to-end testing or testing with any live data" (https://developer.availity.com/blog/2025/10/31/availity-api-guide).
- **Auth:** `POST https://api.availity.com/availity/v1/token` with `grant_type=client_credentials`, `client_id`, `client_secret`, `scope=hipaa`; tokens last 300 s (same page).
- **Demo scenarios:** send `X-Api-Mock-Scenario-ID`; mock responses carry `X-Api-Mock-Response: true`. Scenario ids are in each API reference, which we could not read: **unverified**, so the id is optional config.
- **Limits:** Demo 5 per second and 500 per day; Standard 100 per second and 100,000 per day; every call counts, token and polling included (same page).
- **Production:** Standard plan through your Trading Partner Manager (contract). BAA: **NOT FOUND**. Claim Statuses and Remittance endpoints: **NOT FOUND**, so not built.
- **Env:** `AR_AVAILITY_MODE=sandbox`, `AR_AVAILITY_CLIENT_ID`, `AR_AVAILITY_CLIENT_SECRET`, optional `AR_AVAILITY_MOCK_SCENARIO_ID`. Smoke: `npm run smoke:live -- availity`.

## Optum / Change Healthcare

- **Sandbox access:** request at https://marketplace.optum.com/apiservices/api-sandbox-access; Optum states there is no financial obligation (https://developer.optum.com/eligibilityandclaims/docs/create-a-sandbox-account).
- **Auth:** JSON `{client_id, client_secret, grant_type: "client_credentials"}` to `https://sandbox-apigw.optum.com/apip/auth/v2/token` (production `https://apigw.optum.com/...`) (https://developer.optum.com/eligibilityandclaims/docs/api-urls, https://developer.optum.com/eligibilityandclaims/docs/api-environments).
- **Sandbox data:** only predefined values work (https://developer.optum.com/eligibilityandclaims/docs/sandbox-predefined-fields-and-values); the smoke test uses those (eligibility payer 00001, claim status payer 00003, members 0000000001 and 0000000000, DOB 18800102). Optum asks for no load testing and no production data in the sandbox.
- **Production:** contract or subscription (https://developer.optum.com/eligibilityandclaims/docs/api-onboarding). BAA and rate limits: **NOT FOUND**.
- **Env:** `AR_OPTUM_MODE=sandbox`, `AR_OPTUM_CLIENT_ID`, `AR_OPTUM_CLIENT_SECRET`. Smoke: `npm run smoke:live -- optum`.

## Twilio

- **Test credentials:** Console, Admin > Account management > API keys & tokens. Supported for Calls; test calls are not placed, not charged and fire no callbacks; other resources return 403 (https://www.twilio.com/docs/iam/test-credentials).
- **Magic numbers:** From +15005550006 is valid; To +15005550001..4 return errors 21217, 21214, 21215, 21216 (same page). The adapter only dials these and the documented example destination.
- **Auth:** HTTP Basic, form-encoded bodies (https://www.twilio.com/docs/usage/requests-to-twilio).
- **Production:** not wired. Real payer calls need the Conversation Relay socket (not built), a live account, an owned number and a signed BAA. The BAA edition requirement is recorded from an earlier workstream (ADR 0050/0070) and was not re-verified here.
- **Env (sandbox):** `AR_TWILIO_MODE=sandbox`, `AR_TWILIO_TEST_ACCOUNT_SID`, `AR_TWILIO_TEST_AUTH_TOKEN`. Production names reserved: `AR_TWILIO_ACCOUNT_SID`, `AR_TWILIO_AUTH_TOKEN`, `AR_TWILIO_CALLER_ID`, `AR_PUBLIC_BASE_URL`, `AR_TWILIO_RELAY_URL`. Smoke: `npm run smoke:live -- twilio`.

## Slack

- **Setup:** create an incoming webhook for a test channel; POST JSON `{"text": ...}` to the `https://hooks.slack.com/services/...` URL, which is itself a secret (https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks). Success body and error codes were not stated on that page, so the adapter only checks for HTTP 200.
- **Data:** messages carry opaque summaries only. No PHI goes to Slack.
- **Env:** `AR_SLACK_MODE=sandbox`, `AR_SLACK_WEBHOOK_URL`. Smoke: `npm run smoke:live -- slack` (posts one test message).

## Postmark

- **Setup:** create a server and confirm a sender signature; `POST https://api.postmarkapp.com/email` with `X-Postmark-Server-Token` (https://postmarkapp.com/developer/user-guide/send-email-with-api, https://postmarkapp.com/developer/api/overview). The token `POSTMARK_API_TEST` validates a request without delivering it; sandbox mode always uses it.
- **BAA:** "We also cannot sign any Business Associate Agreements around HIPAA" (https://postmarkapp.com/support/article/1041-is-postmark-hipaa-compliant). Use it for staff notices without PHI only.
- **Env:** `AR_POSTMARK_MODE=sandbox`, `AR_POSTMARK_FROM`, `AR_POSTMARK_SMOKE_TO`; production adds `AR_POSTMARK_SERVER_TOKEN`. Smoke: `npm run smoke:live -- postmark`.

## Epic (access requirements only, not built)

- Register the app on fhir.epic.com (Build Apps, Create an App); Epic assigns production and non-production client IDs. Backend apps upload production and non-production public keys or JWK Set URLs, different per customer and environment. About an hour after the app is marked Ready for Sandbox it can be tested in the open.epic sandbox. Production use needs each customer (community member) to sign the open.epic API Subscription Agreement (https://fhir.epic.com/Documentation?docId=oauth2&section=BackendOAuth2Guide).
- Not verified: token endpoint behaviour, signing algorithms, cost.

## athenahealth (not built)

- **NOT FOUND.** The developer docs (https://docs.athenahealth.com/api/guides/authorization-overview, https://dev.docs.athenahealth.com/api/guides/authentication-and-url-locations) refused automated reading and https://mydata.athenahealth.com/ is client-rendered. Signup path, sandbox access, grant types and partner requirements must be confirmed by a person.
