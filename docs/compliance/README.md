# HIPAA and SOC 2 readiness (DRAFT)

Status as of 2026-10-12. Adapted from the clinic-receptionist compliance folder (same owner) for
AR Resolve (ADR 0070). **Every document in this folder is a draft.**

## Bottom line

**AR Resolve is not HIPAA compliant, has no SOC 2 report and holds no security certification.**
Code cannot make it so:

- **HIPAA** obligations belong to organisations, not software: signed Business Associate
  Agreements (BAAs) with every vendor that touches patient data, administrative safeguards (a
  security officer, a risk analysis, policies, training), and technical safeguards.
- **SOC 2** is an attestation report issued by an independent CPA firm after examining controls.
  No auditor is engaged.

This build is **Phase 0: synthetic data only, live integrations disabled.** The code puts
technical safeguards in place, **fails closed** when the non-technical ones are missing, and
produces evidence an auditor would ask for.

## Technical safeguards in this build (and their tests)

| Safeguard | Implementation | Test |
|---|---|---|
| Tenant/client scope on every route | `server/services/auth.ts` (`resolveScope`, `requirePerm`) | `tests/scope.test.ts`, every suite |
| Role-based permissions | `PERMISSIONS` in `server/services/auth.ts` | `tests/scope.test.ts`, `tests/maya-port.test.ts` |
| Tamper-evident audit log | hash-chained `audit_events` (`server/services/audit.ts`) | `tests/workflow.test.ts` |
| Approval bound to payload hash and account revision | `server/services/review.ts` | `tests/review-execution.test.ts` |
| Encryption of free text at rest | AES-256-GCM with `AR_PHI_KEY` for call events, hand-off packets, evidence content, note write-back texts, notification payloads and channel settings (`server/services/phi.ts`) | `tests/maya-port.test.ts` (round trip, tamper, wrong key, sealed rows) |
| PHI gate (fail closed) | `server/services/governance.ts`: readiness checks, vendor/BAA register, ingest gate (non-synthetic rows and ISA15=P interchanges refused with 409), live-gate reasons, startup refusal with `AR_PHI_MODE=on` | `tests/maya-port.test.ts`, `tests/integrations.test.ts` |
| Live integrations disabled | `LiveExecutionDisabled` in every live adapter; ADR 0030 live gate | `tests/integrations.test.ts`, `tests/voice.test.ts` |
| Signed inbound webhooks | HMAC with replay and staleness checks; Twilio `X-Twilio-Signature` validation checked against Twilio's documented example | `tests/integrations.test.ts`, `tests/maya-port.test.ts` |
| Untrusted transcripts | code Guard flags injection, credential, payment-redirect and identity requests; an outbound utterance with identifier-shaped content is blocked and the call is handed to a person | `tests/maya-port.test.ts`, `tests/voice.test.ts` |
| Minimum necessary in notifications | opaque ids and event codes only; account details only with a channel opt-in and either a synthetic environment or a BAA in force | `tests/maya-port.test.ts` |

## What only the owner can do

1. Name a security officer in writing.
2. Complete the risk assessment (`policies/risk-assessment.md`).
3. Sign BAAs with each vendor marked as needing one in `baa-tracker.md` and record them in the
   vendor register (Integrations page). Recording is a person's attestation; the code cannot
   verify a contract.
4. Adopt the policies in `policies/` (edit first).
5. Decide on SOC 2 (`soc2-roadmap.md`): auditor, scope, timeline. These are spend decisions.
6. Only then: set `AR_PHI_KEY`, `AR_HOSTING_VENDORS` and `AR_PHI_MODE=on` in a non-synthetic
   environment. The server refuses to start if any deployment precondition is missing.

## Known gaps (engineering)

- Development sign-in only (`/api/dev/login`); production needs SSO with MFA.
- No `AR_PHI_KEY` rotation or re-encryption job.
- Note text inside the hash-bound `proposed_actions` payload is not sealed (sealing would change
  the approved hash). It is minimum-necessary text, but plaintext at rest.
- No retention purge job (the origin's `purgeExpired` is not ported).
- Backups and restore tests are not configured.

## How to check the current state

`GET /api/governance/readiness` (view permission) returns each check, what is missing, the
vendors per layer and the BAA register state. It never returns secrets.
