# Risk Assessment

**DRAFT for owner adoption. Not in force until signed.** Adapted from the clinic-receptionist
compliance folder (same owner) for AR Resolve (ADR 0070). Adopting this policy does not make AR
Resolve HIPAA compliant and does not produce a SOC 2 report; see `../README.md`. Nothing here is an
attestation, a certification or legal advice.

Adopted by: ____________________   Date: __________   Version: 0.1-draft

## Purpose
Identify and treat risks to the confidentiality, integrity and availability of data before
patient data is enabled, and then on a schedule.

## Policy statements
1. A risk assessment is done before `AR_PHI_MODE=on`, then yearly and after major changes.
2. Each risk is rated likelihood (1-5) x impact (1-5). A score of 15 or more is High and needs a
   dated treatment plan.
3. Each risk has an owner and a treatment: reduce, transfer, avoid, or accept (with signature).
4. The register is reviewed quarterly.

## Starting register (not yet scored; the owner scores it)

| Risk | Current control | Gap |
|---|---|---|
| Real patient data imported by mistake | ingest gate refuses non-synthetic rows and ISA15=P (409, audited) | none known for Phase 0 |
| A payer rep talks the agent into an unsafe action | Guard flags; actions need human approval bound to hash and revision | live voice not built |
| The agent speaks an identifier | outbound Guard blocks the utterance and hands off | rules are English-only patterns |
| Transcript text at rest is exposed | AES-256-GCM sealing when `AR_PHI_KEY` is set | no key rotation |
| A notification leaks account details | opaque ids; details only with an opt-in and a BAA (or synthetic) | real sends not built |
| Webhook forgery | HMAC signatures with replay and staleness checks | none known |
| A connector outage causes duplicate submissions | idempotency; reconciliation of uncertain dispatches | none known |
| Insider misuse | scoped roles, separation of duties, hash-chained audit | no SSO or MFA; no access reviews yet |

## Owner
Security officer.

## Review cadence
Quarterly review; full assessment yearly.
