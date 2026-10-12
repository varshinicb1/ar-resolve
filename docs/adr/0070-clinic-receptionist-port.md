# ADR 0070: Components ported from clinic-receptionist (PHI gate, Guard, Twilio telephony, notifications, SMART hardening)

Status: accepted for the synthetic environment. Date: 2026-10-12. Migration range 070-079 (`server/db/070_maya_port.sql`).

## Context

The owner asked to reuse code from their other project, clinic-receptionist (a patient-facing phone receptionist), in AR Resolve. That project already had a PHI gate, a code Guard for agent speech, a Twilio telephony layer, notification connectors and a SMART Backend Services client. AR Resolve had none of the first four, and a narrower version of the fifth.

Reuse here means porting the logic and the contracts, then adapting them to AR conventions:

- tenant/client scope;
- the hash-chained `audit()`;
- `LiveExecutionDisabled`;
- tests over the HTTP API.

Each ported file names its origin in a header comment. The origin repository was read, never modified.

## Decisions

1. **PHI gate** (`server/services/governance.ts`, `server/services/phi.ts`, `server/core/registry.ts`).
   - **Vendors per layer.** The gate computes which vendors are in use at each layer:
     - hosting: `AR_HOSTING_VENDORS`;
     - connectors in live mode: a descriptor-to-vendor table;
     - call engines: `AR_CALL_ENGINES`, default `sim_voice`;
     - enabled notification channels;
     - extraction: deterministic, no vendor.
   - **`phiReadiness`** (version `phi-gate.v1`) reports seven checks:
     - the environment is not synthetic;
     - `AR_PHI_KEY` is set;
     - a hosting vendor is declared;
     - every enabled engine is guarded;
     - the extraction layer sends text to no vendor;
     - every required vendor has a BAA in force;
     - `AR_PHI_MODE=on`.
   - **Vendor/BAA register** (`vendor_baas`). It is per tenant/client, append-only (triggers), versioned and audited (`vendor_baa_recorded`). It requires `integration_admin` and a reason of at least 10 characters.
     - `signed` needs `baaRef`, `effectiveOn` and `coveredServices`; the database CHECK enforces the first two.
     - Recording is a person's attestation. The code cannot verify a contract, and says so in the audit details.
   - **Live gate (ADR 0030).** `liveGate` now appends `PHI gate: …` reasons for every live-capable connector. These reasons are additive: the existing authorization, onboarding and environment reasons are unchanged.
   - **Ingest gate.** `importInventory` refuses rows unless every identifier carries the synthetic markers (`SYN…-`, `SYN…-C`, `PT-`). EDI preview refuses an interchange unless ISA15 is `T`. The usage indicator values (P = production, T = test) come from the Nevada Medicaid 835 companion guide (https://www.medicaid.nv.gov/Downloads/provider/companionguide835.pdf, p. 4, read 2026-10-12). A refusal returns 409 `phi_gate_closed` with reasons and an audit event `phi_gate_refused`. With `AR_PHI_MODE` off, nothing non-synthetic is accepted at all.
   - **Startup refusal.** `server/main.ts` and `server/worker.ts` exit with code 78 when `AR_PHI_MODE=on` and any of these is true:
     - the environment is synthetic;
     - the key is missing or invalid;
     - no hosting vendor is declared;
     - an unguarded engine is enabled.
   - **Sealing.** AES-256-GCM in the format `enc:v1:iv:ct+tag`, the same as the origin, keyed by `AR_PHI_KEY` (base64, 32 bytes). Sealed data:
     - `voice_call_events.text` and `voice_calls.handoff`;
     - `evidence.content`; the evidence hash stays over the plaintext, so provenance is unchanged;
     - `note_writebacks` draft and final text;
     - notification payloads, sink messages and channel settings.

     Reads open the text transparently. Without a key, values stay plaintext and readiness reports it.
   - **Readiness on screen.** The Integrations page shows readiness, vendors per layer and the register.
2. **Guard** (`server/services/guard.ts`, version `guard.v1`).
   - **Inbound modules** (rep turns): injection (including AR's existing `isInstructionLike`), excessive agency, memory poisoning, identity requests (DOB, SSN, address, name), credential requests, payment redirect. These modules **flag only**.
   - **Outbound modules** (agent utterances, after spelled-digit normalization):
     - identifiers: SSN-shaped, DOB, card, email, phone, `PT-` token;
     - a claim to be human;
     - unearned promises;
     - a missing automation disclosure on the opening;
     - figures with no source on the call or account.
   - **Origin rules kept.** The origin's clinical crisis rules are kept as a `clinical_safety` module that is disabled in the `payer_rep` profile. The `patient_line` profile is registered unavailable.
   - **Voice engine wiring** (`server/services/voice/engine.ts`):
     - every non-IVR agent utterance is checked before it is recorded;
     - every rep turn is checked after it arrives.
   - **Rep turns** become `guard_inbound_warning` call flags (evidence warnings). They never change answers, facts or actions.
   - **A blocked agent utterance** is not recorded as spoken. The call records `guard_blocked_utterance` and hands off to a person (`GUARD_BLOCKED_UTTERANCE`). Proposals are untouched.
   - **Medium-severity outbound hits**, such as an unsourced figure, are flagged.
   - **`GET /api/accounts/:id/guard-findings`** scans stored transcripts, read-only.
   - **Test script.** A new sim script, `guard_probe`, exercises both directions.
3. **Telephony** (`server/connectors/telephony/twilio.ts`, `engines.ts`, `server/connectors/live-voice.ts`). These were checked against Twilio's documentation on 2026-10-12:
   - S-TW1 https://www.twilio.com/docs/usage/security
   - S-TW2 https://www.twilio.com/docs/voice/api/call-resource
   - S-TW3 https://www.twilio.com/docs/voice/tutorials/how-to-modify-calls-in-progress
   - S-TW4 https://www.twilio.com/docs/voice/twiml/connect/conversationrelay

   The ported contracts:
   - **Request validation:** HMAC-SHA1 over the URL plus the POST parameters, sorted, then base64. The URL is accepted in its port and credential variants. It is tested against the documented example vector.
   - **TwiML builders:** Conversation Relay requires wss, its parameters must be opaque ids only, and attributes are escaped. The relay-done handler dials the specialist line on hand-off and hangs up otherwise.
   - **Call request builders:**
     - create: E.164 numbers; Timeout capped at 600; status callback events `initiated`, `ringing`, `answered`, `completed`; inline TwiML up to 4000 characters;
     - end: `Status=completed`;
     - redirect;
     - fetch.
   - **Status-callback parser:** the dedupe key is CallSid + SequenceNumber + CallStatus, because events can arrive out of order.
   - **`CallEngine` registry:** `sim_voice` and `twilio_relay`, both guarded.
   - **`LiveTelephonyAdapter`** is now a real implementation behind an injected transport, and it stays refused:
     - every method first checks the deployment gate (synthetic environment, `AR_PHI_MODE` off, no credentials, no authorization) and throws `LiveExecutionDisabled`;
     - the synchronous `VoiceAdapter` surface never performs I/O.
   - **Webhooks:** `POST /api/webhooks/twilio/voice-status` and `/relay-done` verify `X-Twilio-Signature` against `AR_PUBLIC_BASE_URL`.
     - Without configuration they answer 503.
     - Callbacks are deduplicated into `telephony_callbacks`.
     - Callbacks for calls this system did not place are recorded unmatched and change nothing.

   `app.ts` gained two small additions: form-encoded bodies and a `RawResponse` for XML. No call is ever placed.
4. **Notifications** (`server/services/notifications.ts`, version `notify.v1`).
   - **Registry.** A connector registry holds `sim_sink`, `webhook` (signed `x-ar-signature: t=…,v1=HMAC-SHA256`), `slack`, `teams`, `email` (Resend) and `staff_sms` (Twilio).
   - **Event mapping.** `audit()` calls `notifyFromAudit` in the same transaction. It maps audit events to AR events:
     - `action_proposed` and `writeback_proposed` → `review.needed`;
     - follow-up due and overdue;
     - `dispatch_uncertain` → `receipt.uncertain`;
     - `verbal_request_recorded`;
     - `outcome_reconciled`;
     - `account_reopened`;
     - `connector_circuit_opened`, which the framework now emits.
   - **Queueing.** Each AR event queues one delivery per matching channel. Channels filter by event, scenario, payer and action kind. Deliveries are idempotent per (channel, event id). The function never throws.
   - **Delivery.** `deliverDue` (worker and API) sends:
     - `sim_sink` writes to `notification_sink`;
     - every real kind is refused (`LiveExecutionDisabled`) and recorded as `refused`, with an audit event.
   - **Retries.** Failures retry with backoff at 1, 5, 30 and 120 minutes, then fail after 5 attempts.
   - **Payloads** carry opaque ids, event codes and allowlisted detail values only. Account details are added only when the channel opts in and either the environment is synthetic, or every vendor behind the channel has a BAA in force. This is re-checked at send time. Patient tokens are never included.
   - **Admin.** Channel admin needs `integration_admin`. The webhook secret is shown once.
5. **SMART/FHIR hardening**, from the origin's `smart.ts` and `fhir.ts`:
   - token endpoint discovery from `.well-known/smart-configuration`;
   - FHIR bases and token endpoints vetted by `safePublicHttpsUrl` (loopback is an explicit opt-in for the local mock only);
   - `redirect: 'manual'` and an 8-second timeout on every request;
   - a 60-second token refresh margin;
   - RS384 alongside ES384, with the JWT `alg` required to match the registered key type.
6. **Compliance documents** were adapted into `docs/compliance/`. All are DRAFT, carry no attestations, and mark vendor facts not read this session as unverified.

## Not ported (verdicts on the other origin files)

| Origin file | Verdict |
|---|---|
| `src/attribution.ts` | Not applicable: call-to-booking attribution. AR has its own attribution rule (ATTR01, ADR 0040). |
| `src/value.ts` | Worth porting later: a staff-time value report could become an operations analytics card. |
| `src/team.ts` | Not applicable: patient-facing personas. |
| `src/access.ts` | Worth porting later: named API keys with hashing and audit, for service accounts. |
| `src/recording.ts` | Worth porting later, but blocked: call recording needs counsel review of consent law. |
| `src/memory.ts` | Not applicable: patient memory across calls. |
| `src/governance.ts` `purgeExpired` | Worth porting later: retention purge, once retention periods are set (`docs/compliance/policies/data-retention.md`). |

## Consequences

- The existing live-gate test still asserts the environment reason. It now also accepts the additive PHI-gate reasons.
- The existing FHIR test opts in to loopback for the mock.
- Notification queueing adds one query per mapped audit event when a scope has channels.
- Sealed columns cannot be searched with SQL `LIKE`. Nothing in the product searched them.

## Left open

- **`proposed_actions` payload.** The note text inside this payload is not sealed, because the approved hash covers it. Sealing it needs a hash-over-plaintext change in review and execution.
- **`AR_PHI_KEY` rotation.** No rotation or re-encryption job exists.
- **Guard rules** are English-only regular expressions.
- **Live voice orchestration.** No socket server or turn loop exists. The adapter's `*Async` methods are not called by the engine.
- **Real notification sends**, the Slack, Teams, Resend and staff-SMS payload shapes, and the Twilio Messages endpoint used by `staff_sms` are ported unchanged from the origin and were not re-verified in this build. They are unreachable while sends are disabled.
