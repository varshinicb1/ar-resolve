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
## Operations workstream: follow-up, reconciliation, write-back, controls, analytics (ADR 0040)

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| FR13 | Versioned business calendars; most specific (payer/client/tenant/global) wins | Implemented | tests/followups.test.ts "business-day math" |
| FR13 | US federal holidays 2026-2027 from OPM (retrieved 2026-10-12), status reference | Implemented | `server/services/calendar.ts` |
| FR13 | Real payer calendars | Blocked | No payer calendar supplied; Demo Payer A calendar is synthetic |
| FR13 | Follow-up only from a captured commitment (value, unit, basis, evidence locator); else labelled policy interval | Implemented | "follow-up from a captured payer commitment", "no commitment" tests |
| FR13 | Due / overdue / upcoming / snoozed queue; snooze with reason; completion codes; worker tick emits followup_due | Implemented | "worker tick moves follow-ups" test; Follow-ups page |
| FR14 | `RemittanceLine` contract; line-level matching by claim + payer within scope; unmatched/ambiguous kept | Implemented (synthetic input) | tests/outcomes.test.ts |
| FR14 | 835 parsing and real cash feeds | Blocked | Integrations workstream parser feeds `RemittanceLine`; real feeds need a design partner |
| FR14 | Promise / accepted request / adjudication / cash kept apart in an append-only, hash-chained ledger; auditor export | Implemented | "outcome ledger is append-only" test |
| FR14 | Versioned attribution rule (ATTR01 v1, draft) with explicit methodology | Implemented (draft) | Customer-agreed methodology Blocked |
| FR14 | Contradictory outcome reopens the account (unchanged after request, unfavourable change, reversal, cash mismatch) | Implemented | "contradictions reopen the account" test |
| FR12 | Note write-back: own permissions, destination preview, hash + revision + PM record version binding, drafter cannot approve | Implemented | tests/writeback.test.ts |
| FR12 | Read-back verification; writeback_uncertain until read-back matches; never success without read-back | Implemented | "read-back mismatch stays writeback_uncertain" test |
| FR12 | Edited notes keep original draft, edits, editor and approver | Implemented | "edited notes keep the original draft" test |
| FR12 | PM/EHR target | Mocked | `server/connectors/sim-pm.ts` simulator; real PM write-back Blocked (no system access) |
| FR16 | Payer and workflow pauses (client supervisors); pending dispatches held with reason | Implemented | tests/controls-analytics.test.ts |
| FR16 | Resume releases held rows only after re-check (hash, revision, approver role, expiry, other pauses) | Implemented | "resume re-check blocks" test |
| FR16 | Tenant and global pause from the UI; controlled cancellation of active calls | Not started | Platform operation; no live calls exist |
| Analytics | 15 doc 03 events, append-only, opaque ids and allow-listed codes only | Implemented | "analytics events use opaque ids" test |
| KPIs | Touches, review burden, abstention, time to proposal, approval latency, dispatch success, uncertain rate, follow-up adherence, outcomes by type, reopened rate, identity blocks, with definitions | Implemented (synthetic activity) | Insights page; KPI test |
| Economics | Capacity/unit-economics calculator reproducing build pack calculate.py; inputs labelled assumptions | Implemented | KPI test reproduces economics-results.csv |
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
