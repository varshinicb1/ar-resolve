# Access Control Policy

**DRAFT for owner adoption. Not in force until signed.** Adapted from the clinic-receptionist
compliance folder (same owner) for AR Resolve (ADR 0070). Adopting this policy does not make AR
Resolve HIPAA compliant and does not produce a SOC 2 report; see `../README.md`. Nothing here is an
attestation, a certification or legal advice.

Adopted by: ____________________   Date: __________   Version: 0.1-draft

## Purpose
Ensure only authorised people and systems access AR Resolve data, with the least privilege needed.

## Policy statements
1. **Unique identities** for every person and service; no shared accounts.
2. **Roles** (`specialist`, `reviewer`, `supervisor`, `auditor`, `rule_approver`) are granted per
   tenant and client, and permissions are enforced on the server (`PERMISSIONS`). Connectors, the
   vendor/BAA register and notification channels require `integration_admin` (supervisor).
3. **Scope.** A user acts only inside their tenant/client grants. Requests outside them are refused
   or return not found.
4. **Separation of duties.** Proposers cannot approve their own financial actions; rule authors
   cannot approve their own rules.
5. **Provisioning and revocation** happen on written request, with same-day removal on departure.
6. **Quarterly access review** of grants and vendor console users, recorded.
7. **Vendor consoles and the repository** require MFA.
8. **Secrets** (`AR_PHI_KEY`, `AR_TWILIO_AUTH_TOKEN`, connector credentials) are held in the secret
   store, referenced by name in configuration, and never logged or returned by the API.

## Owner
Security officer.

## Review cadence
Yearly.

## How this system meets it today / gaps
- **Meets:** server-side scope and permission checks with tests; separation of duties; a webhook
  signing secret is shown once and never again.
- **Gaps:** development sign-in only; no SSO, MFA or automatic logoff; no service-account keys
  (the origin's named API keys are a candidate to port).
