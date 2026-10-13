# Data Retention and Disposal Policy

**DRAFT for owner adoption. Not in force until signed.** Adapted from the clinic-receptionist
compliance folder (same owner) for AR Resolve (ADR 0070). Adopting this policy does not make AR
Resolve HIPAA compliant and does not produce a SOC 2 report; see `../README.md`. Nothing here is an
attestation, a certification or legal advice.

Adopted by: ____________________   Date: __________   Version: 0.1-draft

## Purpose
Keep only what is needed, for as long as it is needed, and dispose of it safely.

## Policy statements
1. **Retention periods** are set by the owner with counsel and each client's BAA; none are
   asserted here. Candidates for a period: call events and transcripts, evidence documents, the
   notification sink and deliveries, and telephony callbacks. The audit log and BAA register are
   kept for the period counsel sets.
2. **Minimum necessary.** Store what the AR workflow needs; the PM/EHR remains the system of
   record. Patient resources read over FHIR are reduced to a token at the client boundary.
3. **Encryption** of stored free text with `AR_PHI_KEY`.
4. **Deletion on request** by a client, audited.
5. **End of contract:** return or destroy the client's data (the period is for the owner to
   confirm).
6. **No PHI** in git, email, chat tools, tickets or test fixtures. Fixtures are synthetic: `SYN-`
   accounts, `PT-` tokens, and ISA15 usage indicator `T`.

## Owner
Security officer.

## Review cadence
Yearly.

## How this system meets it today / gaps
- **Meets:** the synthetic-only ingest gate; sealing; patient-token reduction.
- **Gaps:** no purge job (the origin's `purgeExpired` is not ported); no deletion endpoint.
