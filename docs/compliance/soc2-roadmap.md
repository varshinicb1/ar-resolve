# SOC 2 roadmap (DRAFT)

Status as of 2026-10-12. **AR Resolve has no SOC 2 report** and no auditor is engaged. Only an
independent CPA firm issues a SOC 2 report; nothing in this repository can produce one. This is a
plan for the owner, not a claim of readiness. Adapted from the clinic-receptionist roadmap.

## Outline

- A **Type I** report covers control design at a point in time. A **Type II** report covers
  operation over an observation window (length: verify with the chosen auditor).
- **Scope:** Security (Common Criteria) is mandatory. Confidentiality and Processing Integrity are
  candidates for a revenue-cycle product; verify with the auditor.
- SOC 2 does not replace HIPAA duties (`baa-tracker.md`, risk analysis).

## Steps

1. Define the system boundary (AR Resolve server, database, worker, web UI, connectors) and the
   subservice organisations (hosting provider, clearinghouses, and Twilio if voice goes live).
2. Adopt the policies in `policies/`.
3. Close the gaps auditors flag first: SSO with MFA, key rotation, backups with a tested restore,
   CI with retained results, access reviews, training records, vendor reviews.
4. Run a readiness self-assessment.
5. Type I audit, then the observation window, then a Type II audit and yearly renewal.

## Evidence the system already produces

| Evidence | Source |
|---|---|
| Every state change with actor, scope and hash chain | `audit_events`, audit export |
| Approvals bound to payload hash and account revision | `review_decisions`, `proposed_actions` |
| Connector calls, outcomes, latency, refusals | `connector_events` |
| BAA register history | `vendor_baas` (append-only) |
| PHI readiness state | `GET /api/governance/readiness` |
| Refused ingests of non-synthetic data | `phi_gate_refused` audit events |
| Notification deliveries, refusals and failures | `notification_deliveries`, `notification_*` audit events |
| Guard findings on calls | call flags `guard_*`, `GET /api/accounts/:id/guard-findings` |
| Code change history | git |

## Owner checklist

1. [ ] Name the security officer.
2. [ ] Edit and sign the policies.
3. [ ] Turn on MFA for every vendor console and the repository.
4. [ ] Complete the risk assessment.
5. [ ] Approve engineering work for the gaps above.
6. [ ] Decide on a compliance platform and an auditor (spend decisions).
7. [ ] Type I, observation window, Type II.
