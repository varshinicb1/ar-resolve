# Business Continuity Policy

**DRAFT for owner adoption. Not in force until signed.** Adapted from the clinic-receptionist
compliance folder (same owner) for AR Resolve (ADR 0070). Adopting this policy does not make AR
Resolve HIPAA compliant and does not produce a SOC 2 report; see `../README.md`. Nothing here is an
attestation, a certification or legal advice.

Adopted by: ____________________   Date: __________   Version: 0.1-draft

## Purpose
Keep account follow-up safe and recoverable through outages.

## Policy statements
1. **Fail safe, not open.** When a connector fails, its circuit opens and the work routes to
   people. No action is retried blindly: an uncertain dispatch is reconciled by read-back first.
2. **Backups** of the database are encrypted, and a restore is tested at least quarterly.
3. **Recovery targets** are agreed per client by the owner. None are asserted here.
4. **Contacts** for vendors and clients are kept current.
5. **Emergency mode:** pause the client or tenant. Never move data to an unapproved vendor to keep
   working.
6. **Test** the plan yearly (tabletop exercise).

## Owner
Security officer.

## Review cadence
Yearly.

## How this system meets it today / gaps
- **Meets:** circuit breaker with an audited `connector_circuit_opened` event (and a notification
  event); pause controls; crash-safe call and outbox state machines with restart tests.
- **Gaps:** no backups or restore tests are configured; no recovery targets are agreed.
