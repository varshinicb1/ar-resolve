# Incident Response and Breach Notification Policy

**DRAFT for owner adoption. Not in force until signed.** Adapted from the clinic-receptionist
compliance folder (same owner) for AR Resolve (ADR 0070). Adopting this policy does not make AR
Resolve HIPAA compliant and does not produce a SOC 2 report; see `../README.md`. Nothing here is an
attestation, a certification or legal advice. Legal timelines must be set with counsel against
45 CFR 164.400-414 and state law before adoption; none are asserted here.

Adopted by: ____________________   Date: __________   Version: 0.1-draft

## Purpose
Detect, contain and recover from security incidents, and meet notification duties to clients
(covered entities) when patient data may have been exposed.

## Scope
Suspected or actual unauthorised access, use, disclosure, loss or alteration of data; outages;
leaked secrets; vendor-reported incidents; unsafe agent behaviour on a payer call (for example an
identifier spoken, or a disclosure about the wrong claim).

## Policy statements
1. **Report fast** to the security officer, and do not delete evidence.
2. **Triage:** severity, whether PHI is involved, and which tenants and clients are affected.
3. **Contain:** pause the client or tenant (operations controls), disable connectors, rotate
   secrets and `AR_PHI_KEY`, set `AR_PHI_MODE` off, roll back the deployment.
4. **Investigate** with `audit_events` (verify the hash chain), `connector_events`, call events and
   flags, and notification deliveries.
5. **Notify the client** of a breach of unsecured PHI within the period required by law and by the
   client's BAA, whichever is shorter (periods: verify with counsel).
6. **Record** every incident: timeline, root cause, actions, notifications. Retention period:
   verify with counsel.
7. **Post-incident review** feeds `risk-assessment.md`.
8. **Drills** at least yearly. Scenarios: leaked secret; wrong account in a note write-back;
   connector outage with uncertain dispatches.

## Owner
Security officer.

## Review cadence
Yearly, and after every serious incident or drill.

## How this system meets it today / gaps
- **Meets:** tamper-evident audit; pause controls; reconciliation of uncertain dispatches;
  notification channels for review and failure events (simulated in this build).
- **Gaps:** no drills; no on-call or client contact list; no alerting on audit patterns.
