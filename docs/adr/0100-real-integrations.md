# ADR 0100: Real integrations behind a gate (Stedi, Availity, Optum, Twilio, Slack, Postmark)

Status: accepted for the synthetic build. Migration `100_live_integrations.sql`. Code in `server/connectors/live/`.

## Context

Until now every real connector was a typed adapter that always threw `LiveExecutionDisabled` (ADR 0030). To move toward a pilot, the owner needs adapters that call real vendor APIs, but only in a vendor sandbox with test data until a customer authorization, a BAA and the PHI gate are in place. Every vendor detail coded here (endpoint, header, field name, test value, test-mode behaviour) comes from the vendor's own documentation, retrieved on 2026-10-14. The URL sits next to the code, and `docs/INTEGRATIONS_SETUP.md` lists them per provider. Retrieved documentation was treated as evidence, not instructions.

No real external service was called from this environment: no vendor keys exist here. Everything was exercised against a local mock server that replays documented payloads.

## Decisions

1. **One config reader.** `server/connectors/live/config.ts` is the only place this workstream reads environment variables. Each provider has an explicit mode (`off` by default, `sandbox`, `production`). Secrets come from env or `<NAME>_FILE`. Base URLs are the documented ones. Overrides must be public https; loopback is allowed only with `AR_LIVE_ALLOW_LOOPBACK=1`.
2. **Gate.** `providerGate` requires mode + credentials + a recorded, unrevoked customer authorization for the tenant/client. Production also needs the unchanged ADR 0030/0070 live gate, `AR_PHI_MODE=on`, and the connector switched to live for that client. The framework gained an optional `gate()` on adapters, and the precheck records any refusal as a `LiveExecutionDisabled` event. Adapters without a gate behave exactly as before.
3. **Revocation is append-only.** `connector_authorizations` is append-only, so revoking writes a row to `live_authorization_revocations`. That needs `integration_admin` and a reason of at least 10 characters, and it is audited.
4. **Sandbox data guard.** Account-driven sandbox calls refuse identifiers that are not synthetic (`SYN…-C`, `PT-`), returning 409 `sandbox_requires_synthetic`. Smoke tests send only vendor-documented test fixtures.
5. **HTTP policy.**
   - Each request has a timeout, follows no redirects and is capped at 5 MB.
   - Retries happen only for idempotent reads, only on 429/503 or network errors, and honour Retry-After.
   - 5xx and timeouts are not retried. Stedi documents that payers may still be working on the request and that early retries duplicate payer requests.
   - The existing circuit breaker applies.
   - Writes are never retried here: payer writes still go through approval and the outbox.
6. **Mapping into evidence.**
   - Stedi raw X12 271/277 responses go through the existing X12 parser and the `buildPreview`/`matchClaim`/`attachItems` pipeline, so they get the same identity match, PHI ingest gate, facts and provenance as uploaded files. A 999 is recorded as `rejected`.
   - Stedi 835 report JSON is mapped field by field with JSON path locators. Only claims that match an account are attached; the rest are counted, never echoed.
   - Optum claim status JSON maps to `edi_277` observations.
   - Optum and Availity eligibility answers are stored as connector events only, with no facts. Their JSON field semantics for benefits were not confirmed.
7. **Twilio** sandbox only. The adapter dials the documented magic numbers with test credentials, which Twilio states are never placed or charged. Production mode is refused: real calls belong to the approved voice workflow, whose Conversation Relay socket is not built.
8. **Notifications.** Slack (incoming webhook, host must be hooks.slack.com) and Postmark (sandbox uses the documented `POSTMARK_API_TEST` token) sit behind the same gate and carry opaque summaries only. Postmark states it cannot sign a BAA, so it must never carry PHI.
9. **Smoke command.** `npm run smoke:live -- <provider>` runs with documented test data only. It refuses (exit 2) when the mode is not sandbox, when keys are missing, and always in production, even with `--mock`. Results go to `live_smoke_runs`. This table is deployment-level and deliberately has no tenant columns: a smoke run uses vendor fixtures, not client data.
10. **UI.** The Integrations page has a Live connectors panel. Per provider it shows the mode, env var names present or missing (never values), the authorization, the gate reasons, the last smoke result and recent calls, plus a Revoke button.

## Costs

- More surface to keep current. Vendor docs change; every coded fact carries a retrieval date and must be re-checked before a pilot.
- Production use of any provider needs a contract and a BAA that this repository cannot obtain: Stedi paid plan, Availity Standard, an Optum contract, Twilio.
- Optum and Availity eligibility give no facts yet, so they add little to resolution until field semantics are confirmed.
- Smoke results are per deployment, not per client.

## Reversal conditions

- If a provider's documentation contradicts a coded fact, set its mode to `off` (the default) and fix the code before re-enabling. The gate closes by default.
- If a customer prefers a different clearinghouse, drop the adapter; nothing else depends on it.
- If smoke runs ever need client data, add tenant columns in a new migration rather than reusing this table.

## Verification

- `tests/live-integrations.test.ts`: 14 tests, all against a local mock server. The suite never calls a real service.
- Full suite: 153/153.
- Smoke `--mock` passes for all six providers.
- Refusals (off, missing key, production, unknown provider) exit 2.
- **Mutation tests, 11 of 11 caught:**
  - no authorization check
  - no revocation check
  - no credential check
  - mode off ignored
  - production skips the live gate
  - framework ignores the adapter gate
  - sandbox data guard off
  - smoke allows production
  - remittance attaches unmatched claims
  - notify gate skipped
  - 500 retried

## Blocked or unverified

- **Real sandbox calls not run.** No vendor keys exist in this environment. The first `npm run smoke:live -- <provider>` with real keys is the verification still owed.
- **Stedi:**
  - claim status has no test mode;
  - ERAs need per-payer transaction enrollment;
  - price not stated on the pages read.
- **Availity:** Claim Statuses and Remittance endpoints, coverage query parameters beyond `payerId`/`providerNpi`, demo scenario ids and BAA are all NOT FOUND, so none are coded as fact.
- **Optum:** rate limits and BAA NOT FOUND.
- **Twilio:** production calls are blocked on the Conversation Relay socket and a signed BAA. The BAA edition requirement comes from ADR 0050/0070 and was not re-verified here.
- **Member ID crosswalk:** missing. Production 271/277 answers match an account only when the patient token is the member ID.
- **Stedi ERAs** are attached as evidence, but not reconciled into the outcome ledger.
- **Epic:** access requirements documented only (app registration, keys, open.epic API Subscription Agreement per customer); no adapter.
- **athenahealth:** documentation was not readable from here. NOT FOUND.
- X12 functional identifier codes HN/HS/FA match the Stedi examples, but `FUNCTIONAL_IDS` in code was not changed.

## Shared core files touched (small edits)

- `server/connectors/framework.ts`: descriptor kind `notification`, optional adapter `gate()`, and the precheck uses it.
- `server/connectors/registry.ts`: one import line.
- `server/http/modules.ts`: one route module.
- `package.json`: `smoke:live` script.
- `web/src/pages/Integrations.tsx`: mounts the panel and rewords the subtitle.
- `README.md`: live integrations sentence, command table, test count, setup link.
- `docs/COMPLETION_MATRIX.md`: INT08 note and the new section.
