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

## Knowledge base workstream (ADR 0010)

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| KB | Sourced, hashed, versioned datasets under `knowledge/` loaded into `kb_*` tables | Implemented | tests/kb.test.ts "loader versions datasets by hash" |
| KB | CARC index (370 codes, 1 to P7; dates/status; excerpts for routed codes) | Implemented (partial coverage) | knowledge/x12/carc.json; tail after P7 and full descriptions Blocked (X12 licence / page length) |
| KB | RARC index (416 codes, M1 to N138) | Implemented (partial coverage) | knowledge/x12/rarc.json; N139+ Blocked |
| KB | Claim adjustment group codes (CO, CR, OA, PI, PR) | Implemented | CMS Blue Button + Manual Ch. 22 §60.1 |
| KB | 277 claim status categories (56, complete) and claim status codes (543, 0 to 555) | Implemented (status codes partial) | knowledge/x12/claim-status*.json |
| KB | Regulatory articles with per-fact citations (7, all draft) | Implemented (draft; compliance review Not started) | knowledge/regulatory/articles.json |
| KB | Structured playbooks for all 9 doc 05 packs | Implemented (draft; business sign-off Not started) | knowledge/playbooks/playbooks.json |
| KB | Draft CARC/RARC/group routing `routeScenario()`; unknown/multiple go to specialist review | Implemented (draft mapping) | shared/kb/routing.ts; routeScenario test |
| KB | `explainAdjustment` API + `<CodeExplain>` component | Implemented | /api/kb/explain; web/src/kb.tsx |
| KB | Full-text search (FTS5, LIKE fallback) | Implemented | KB API test |
| KB | Glossary (33 terms) | Implemented | knowledge/glossary/glossary.json |
| KB | Payer directory scoped by tenant/client | Mocked (synthetic payers only) | scope test; real payer data Blocked on contracts |
| KB | `npm run kb:verify` integrity check | Implemented | kb:verify tamper test |
| KB | Knowledge UI (search, explain, playbooks, articles, glossary, code lists, payers, sources) | Implemented | Nav "Knowledge"; Playwright smoke at 1400px and 390px |
| KB | Licensed X12 full-text import | Blocked | Needs an X12 licence |
