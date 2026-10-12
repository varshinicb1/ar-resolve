# Completion matrix (Phase 0)

Status values: **Implemented** (works and tested on synthetic data), **Mocked** (stand-in that behaves like the real boundary), **Blocked** (needs an external business, legal or access decision), **Not started**.

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| FR01 | Import with mapping preview, validation, ambiguous-row rejection, source hash, batch ID, idempotent re-import | Implemented | tests/workflow.test.ts "import validates rows" |
| FR02 | Identity check (claim ref, patient token, DOS vs EOB); conflict blocks proposal and calls | Implemented | "identity conflict blocks" |
| FR03 | Queue with saved views, explained priority, server pagination, scoped search | Implemented | Queue UI; scope test |
| FR04 | Evidence with sha256, observed/effective time, locators; provenance on every fact | Implemented | evidence/facts services |
| FR05 | Scenario selection | Implemented (synthetic map, draft) | See "Scenario rule packs" below; ADR 0020 |
| FR06 | Rule versions: immutable definition + hash, draft state, fixture runner, review/publish/rollback/retire | Implemented (synthetic) | See "Scenario rule packs" below; ADR 0020 |
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

## Scenario rule packs and rule studio lifecycle (ADR 0020)

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| Engine | Registry of versioned packs; DED01 definition, hash, 40 fixtures and tests unchanged | Implemented | tests/scenario-packs.test.ts (hash assertion); evaluate 40/40 |
| FR05 | Selection from a versioned mapping table (CARC, claim status, inventory hint); ambiguous/unknown/conflict route to specialist review with reasons | Implemented (draft map) | evaluation/selection-fixtures.json 17/17; Account page "Scenario" panel |
| FR05 | CARC rows cite X12 CARC list (retrieved 2026-10-12) | Implemented | SCENARIO_MAP_V1.sources |
| FR05 | RARC mapping | Blocked | No verified RARC source; table left empty |
| Packs | PEND01, DOC01, DUP01 executable; COB01, TF01, AUTH01, MN01, BUN01 abstain-only with evidence checklists | Implemented (draft, synthetic labels) | 141/141 pack fixtures incl. adversarial transcript injection |
| Packs | Customer sign-off of packs and payer-specific policy (timely filing, auth, medical necessity, bundling) | Blocked | Needs design partner and payer policy access |
| FR06 | Draft → validate (schema + all fixtures) → review by different `rule_approver` → publish with activation time → retire | Implemented | tests/rule-studio.test.ts |
| FR06 | Immutable versions, client scope, effective dates, runs pinned to started version, rollback as new activation | Implemented | tests/rule-studio.test.ts lifecycle |
| FR06 | Before/after impact on fixtures and current accounts | Implemented | /api/rule-studio/.../impact; Rule studio UI |
| FR06 | Phase 0 "drafts run only because synthetic" check | Implemented | scenario.ts `draftsMayRun`; test |
| Eval | End-to-end cohort across 3 synthetic clients | Implemented | evaluation/REPORT.md cohort 35/35 |
| Eval | Accuracy of selection or packs on real accounts | Blocked | Gate B (shadow mode, expert labels) |
