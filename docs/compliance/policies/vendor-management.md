# Vendor Management Policy

**DRAFT for owner adoption. Not in force until signed.** Adapted from the clinic-receptionist
compliance folder (same owner) for AR Resolve (ADR 0070). Adopting this policy does not make AR
Resolve HIPAA compliant and does not produce a SOC 2 report; see `../README.md`. Nothing here is an
attestation, a certification or legal advice.

Adopted by: ____________________   Date: __________   Version: 0.1-draft

## Purpose
Control which vendors receive data, and on what terms.

## Policy statements
1. **Inventory.** `../baa-tracker.md` and the vendor/BAA register are the inventory. A vendor not
   listed receives no production data.
2. **Classify** each vendor: sees PHI; may see PHI incidentally; never sees PHI.
3. **BAA gate.** The first two classes need a signed BAA naming the products used before PHI
   flows. The code enforces this through the register: the live gate (ADR 0030) and the PHI
   readiness check refuse while a required vendor lacks a BAA in force.
4. **Evidence before trust.** Each vendor fact carries its source URL and the date it was read,
   or is marked unverified.
5. **New vendor checklist:** purpose, data seen, BAA availability, security report, retention and
   data-use terms, subprocessors, exit plan.
6. **Annual review** of each vendor, and **offboarding**: revoke credentials, request deletion,
   record the date.

## Owner
Security officer.

## Review cadence
Yearly, and for each new vendor.

## How this system meets it today / gaps
- **Meets:** the register is append-only and audited; vendors per layer are computed from
  configuration; a notification webhook channel declares the vendor behind it.
- **Gaps:** no vendor has been reviewed; no BAAs exist.
