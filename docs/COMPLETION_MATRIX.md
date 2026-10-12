# Completion matrix (Phase 0)

Status values: **Implemented** (works and tested on synthetic data), **Mocked** (stand-in that behaves like the real boundary), **Blocked** (needs an external business, legal or access decision), **Not started**.

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| FR01 | Import with mapping preview, validation, ambiguous-row rejection, source hash, batch ID, idempotent re-import | Implemented | tests/workflow.test.ts "import validates rows" |
| FR02 | Identity check (claim ref, patient token, DOS vs EOB); conflict blocks proposal and calls | Implemented | "identity conflict blocks" |
| FR03 | Queue with saved views, explained priority, server pagination, scoped search | Implemented | Queue UI; scope test |
| FR04 | Evidence with sha256, observed/effective time, locators; provenance on every fact | Implemented | evidence/facts services |
| FR05 | Scenario selection | Partial | Only DED01; other CARC scenarios are backlog (templates/supplied-scenario-backlog.csv) |
| FR06 | Rule versions: immutable definition + hash, draft state, fixture runner | Implemented (draft only) | Rule studio; publish/approve workflow Not started |
| FR07 | Authorized payer calls | Mocked | Pre-scripted transcript adapter; telephony Blocked (legal/TCPA review, vendor) |
| FR08 | Fact capture with unknown and conflicting states | Implemented (from structured extracts) | Model-based extraction Not started |
| FR09 | Deterministic verifier: arithmetic, evidence, permission | Implemented | review.ts approvalChecks |
| FR10 | Review UI with evidence, payload, financial check, prerequisites, rationale | Implemented | Account workspace |
| FR11 | Approval bound to payload hash and account revision; atomic; idempotent execution | Implemented | stale review, double approval, duplicate dispatch tests |
| FR12 | Draft notes | Implemented (deterministic template) | Write-back to PM/EHR Blocked (no system access) |
| FR13 | Follow-up scheduling from verified payer commitments | Not started | No verified TAT source; field left empty deliberately |
| FR14 | Receipt reconciliation; promise vs acceptance vs payment kept separate | Implemented for receipts | Remittance/cash matching Not started |
| FR15 | Scoped audit export with redaction profile; export itself audited; hash chain | Implemented | audit test |
| FR16 | Halt controls | Implemented (client scope via UI, global via DB) | pause test |
| Security | Server-derived tenant/client scope, roles, separation of duties | Implemented | scope tests |
| Security | Signed, replay-protected receipt webhook | Implemented (simulated payer) | webhook test |
| Security | SSO/MFA, secrets manager, encryption at rest, BAA | Blocked | Required before any PHI (docs/08) |
| Connectors | Live payer executor | Blocked (disabled by design) | livePayer always throws |
| Connectors | PM/EHR, 835/271, clearinghouse feeds | Mocked | synthetic-source adapter; real feeds Blocked on design partner |
| Eval | Fixture agreement 40/40 and cohort 12/12 | Implemented | evaluation/REPORT.md |
| Eval | Shadow-mode accuracy on labeled real cases | Blocked | Gate B needs authorized data and expert labels |
| Ops | Durable workflow runtime for long-running calls | Not started | ADR 0001 |
| Ops | Observability (traces, cost per account) | Not started | |
| UI | Call operations, outcomes, integration health screens | Not started | Specified in docs/11 |
| UI | Accessibility: semantic tables, labels, focus, Escape, 390px no horizontal scroll | Implemented (automated check only) | Manual screen-reader and 200% zoom review Not started |

## Integrations workstream (ADR 0030, migration 030)

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| INT01 | Connector framework: adapter contract, persisted connector events, per-scope modes/settings, versioned onboarding records, authorizations, live gate, circuit breaker, health | Implemented | tests/integrations.test.ts "simulated clearinghouse", "live adapters refuse" |
| INT02 | X12 5010 envelope parse/validate; malformed-input rejection with specific codes; byte-exact round trip | Implemented (public-example layouts) | tests/x12.test.ts; full TR3 conformance Blocked on licensed guides |
| INT03 | 835 mapping incl. reversal (CLP02 22), corrected claim, multiple CAS triplets, PLB, exact cents | Implemented | tests/x12.test.ts "835: reversal…"; integrations "835 reversal + corrected claim" |
| INT04 | 277 / 277CA / 271 / 999 mapping; 276 / 270 generation | Implemented | tests/x12.test.ts |
| INT05 | EDI upload → preview → ingest bound to sha256; identity match (claim ref + patient token + DOS); mismatches blocked and audited; idempotent | Implemented | integrations "835 ingestion produces verified facts…" |
| INT06 | Simulated clearinghouse 276→277, 270→271 with latency and fault injection; structured-status-first step in investigate (per-client, default off) | Mocked (simulator) | integrations "simulated clearinghouse…" |
| INT07 | FHIR R4 read (EOB, Coverage) with SMART Backend Services auth | Mocked (local mock server; real EHR registration Blocked) | integrations "FHIR R4 mock round trip…" |
| INT08 | Availity, Optum/Change Healthcare, Epic, athenahealth, SFTP EDI, Twilio adapters | Blocked (disabled by design; throw LiveExecutionDisabled) | integrations "live adapters refuse…" |
| INT09 | Generic signed webhooks: HMAC, timestamp window, server-side tenant resolution, dedupe, persist-before-ack, monotonic status with correction | Implemented (simulated provider) | integrations "signed connector webhooks…" |
| INT10 | Integrations admin UI with connector health (supervisor; `integration_admin` permission) | Implemented | web/src/pages/Integrations.tsx |
| INT11 | Scope isolation and permissions across all integration routes | Implemented | integrations "integration scope isolation and permissions" |
| INT12 | Real trading-partner feeds, payer IDs, patient identity crosswalk | Blocked | Design partner, BAA, enrollment (ADR 0030 "Blocked") |
