# Change Management Policy

**DRAFT for owner adoption. Not in force until signed.** Adapted from the clinic-receptionist
compliance folder (same owner) for AR Resolve (ADR 0070). Adopting this policy does not make AR
Resolve HIPAA compliant and does not produce a SOC 2 report; see `../README.md`. Nothing here is an
attestation, a certification or legal advice.

Adopted by: ____________________   Date: __________   Version: 0.1-draft

## Purpose
Make every change to AR Resolve reviewed, tested, approved and reversible.

## Policy statements
1. **Version control** for all code, configuration, rules and migrations.
2. **Review** by a second person when staff allow. The security officer reviews security-relevant
   changes: auth, scope, storage, the PHI gate, the Guard, and connectors.
3. **Testing before deploy:** `npm run typecheck`, `npm test`, `npm run build`, `npm run eval`,
   `npm run demo` and `npm run kb:verify` all pass.
4. **Business logic is versioned.** Rule packs, call policies, mappings, the Guard (`guard.v1`),
   the PHI gate (`phi-gate.v1`) and notification payloads (`notify.v1`) all carry versions.
5. **Migrations** are additive and reviewed for data loss; `001_init.sql` is never edited.
6. **Sensitive switches** need security officer sign-off and an audit note: `AR_PHI_MODE`,
   `AR_PHI_KEY`, `AR_HOSTING_VENDORS`, and enabling a live connector.
7. **Emergency changes** are reviewed within 2 business days.
8. **Environments are separate.** Tests never use production data.

## Owner
Security officer.

## Review cadence
Yearly.

## How this system meets it today / gaps
- **Meets:** a full local test suite; versioned rules and policies; migrations applied by
  filename.
- **Gaps:** no CI with retained results; no record of deploy approvals.
