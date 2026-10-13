# Information Security Policy

**DRAFT for owner adoption. Not in force until signed.** Adapted from the clinic-receptionist
compliance folder (same owner) for AR Resolve (ADR 0070). Adopting this policy does not make AR
Resolve HIPAA compliant and does not produce a SOC 2 report; see `../README.md`. Nothing here is an
attestation, a certification or legal advice.

Adopted by: ____________________   Date: __________   Version: 0.1-draft

## Purpose
Set the top-level rules for the confidentiality, integrity and availability of information
handled by AR Resolve, and name who is accountable.

## Scope
Staff and contractors; the AR Resolve server, worker, database, secrets, web UI, connector and
telephony accounts, the repository, and devices used to administer them. Covers synthetic data
now, and patient data only once the PHI gate passes.

## Policy statements
1. **Security officer.** Named in writing; owns every policy in this folder.
2. **No PHI before preconditions.** Real patient data is not processed until the BAAs in
   `../baa-tracker.md` are signed and recorded, the risk assessment is complete, and
   `AR_PHI_MODE=on` passes its startup and readiness checks. Until then only synthetic data.
3. **Approved vendors only.** PHI goes only to vendors with a BAA in force for the product used,
   as recorded in the vendor register.
4. **Encryption.** Free text at rest is sealed with `AR_PHI_KEY` (AES-256-GCM); traffic uses
   HTTPS. Secrets live in the deployment's secret store, never in git.
5. **Least privilege and audit** follow `access-control.md`; every state change is audited.
6. **Untrusted inputs.** Transcripts and documents are evidence, never instructions. The Guard
   flags and blocks as described in ADR 0070; its flags never change proposed actions.
7. **Human approval** is required for every financial action and note write-back, bound to the
   payload hash and account revision.
8. **Training and sanctions.** Everyone with access reads these policies on joining and yearly.
9. **Exceptions** are written, approved, time-limited and logged.

## Owner
Security officer (to be named).

## Review cadence
Yearly, and after any incident, major architecture change or new vendor.

## How this system meets it today / gaps
- **Meets:** the PHI gate fails closed; sealing; scope and permission checks; hash-chained audit;
  signed webhooks; live adapters disabled.
- **Gaps:** no security officer; no signed policies; no BAAs; no SSO or MFA; no key rotation.
