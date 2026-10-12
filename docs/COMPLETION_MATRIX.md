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

## E08 Voice: payer call workflow (simulated), ADR 0050

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| FR07 | Call policy gate with reason codes: allowlist, payer business hours, per-payer concurrency and rate limit, pause, identity, action in flight, recent status, call needed, disclosure/recording config | Implemented | tests/voice.test.ts "policy gate refuses…", "…concurrency, rate limit…" |
| FR07 | Versioned client call policy (immutable versions, supervisor-only, reason required) | Implemented | voice_policy_versions; policy tests |
| FR07 | Deterministic question plan from missing/conflicting/unverified facts + DED01 playbook; read-back for money and references | Implemented | services/voice/plan.ts; SYN-1045 test |
| FR07 | Durable call state machine, restart-safe steps, crash rollback, recovery from provider status | Implemented | "restart mid-call…" test |
| FR07 | Controlled cancellation, pause-driven cancellation, human handoff with packet, specialist end | Implemented | cancellation and handoff tests |
| FR07 | Simulated payer line (IVR, hold, transfer, rep) with adversarial scripts | Mocked (simulator) | server/connectors/sim-voice.ts; adversarial tests |
| FR07 | Live telephony adapter (start, cancel, transfer, result, signed callbacks) | Blocked (disabled by design) | live-voice.ts throws LiveExecutionDisabled; provider, BAA, counsel review, customer authorization pending |
| FR07 | Telephony procurement checklist as data (docs/07, docs/08) | Implemented (all items not started) | TELEPHONY_PROCUREMENT_CHECKLIST |
| FR07 | Signed, replay-protected provider status callbacks | Implemented (simulated provider) | forged/stale/duplicate callback assertions |
| FR08 | Deterministic extraction (cents, dates, references, TAT value/unit/basis) bound to transcript turns; read-back marks confirmed vs unconfirmed | Implemented | extraction unit test; SYN-1045 test |
| FR08 | Verifier: unsupported statements, contradictions → conflicting, missing references never fabricated, wrong-claim quarantine, running totals not used as met-before | Implemented | SYN-1046 and adversarial tests |
| FR08 | Transcript text cannot change actions or permissions | Implemented | "prompt-injection … has no effect" test |
| FR08 | Dropped call after acceptance reconciles before re-requesting | Implemented | "call drops after acceptance…" test |
| Ops | Per-call IVR/hold/talk durations, completeness, cost estimate (labelled assumption) | Implemented (simulated time) | metrics in call detail |
| UI | Calls page (active/recent, state, payer, hold, outcome, policy, live status, checklist) and account call panel (gate, live state, plan checklist, transcript with extracted values and read-back marks, handoff/cancel) | Implemented | web/src/pages/Calls.tsx, CallPanel.tsx; checked at 1440px and 390px |
| Voice | Real speech, telephony, payer IVR trees, payer hours and holiday calendars, contracted rates | Blocked | Needs provider, design partner and counsel |
| Voice | Cross-channel duplicate check in review (verbal request vs outbox) | Not started | ADR 0050 known limitations |
