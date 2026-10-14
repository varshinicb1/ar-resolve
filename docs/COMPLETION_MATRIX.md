# Completion matrix

Phase 0 core rows come first; each workstream section below holds the detail. Where a core row and a section overlap, the core row points to the section and they agree (reconciled in ADR 0060).

Status values: **Implemented** (works and tested on synthetic data), **Mocked** (stand-in that behaves like the real boundary), **Blocked** (needs an external business, legal or access decision), **Not started**.

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| FR01 | Import with mapping preview, validation, ambiguous-row rejection, source hash, batch ID, idempotent re-import | Implemented | tests/workflow.test.ts "import validates rows" |
| FR02 | Identity check (claim ref, patient token, DOS vs EOB); conflict blocks proposal and calls | Implemented | "identity conflict blocks" |
| FR03 | Queue with saved views, explained priority, server pagination, scoped search | Implemented | Queue UI; scope test |
| FR04 | Evidence with sha256, observed/effective time, locators; provenance on every fact | Implemented | evidence/facts services |
| FR05 | Scenario selection; one routing source (selection map), KB routing derived and cross-checked | Implemented (synthetic map, draft) | See "Scenario rule packs" and "Cross-workstream glue" below; ADR 0020, 0060 |
| FR06 | Rule versions: immutable definition + hash, draft state, fixture runner, review/publish/rollback/retire | Implemented (synthetic) | See "Scenario rule packs" below; ADR 0020 |
| FR07 | Authorized payer calls | Mocked (simulated payer line, voice engine) | See "E08 Voice" below; ADR 0050. The legacy pre-scripted adapter remains for the Phase 0 demo. Live telephony Blocked (provider, BAA, counsel review, customer authorization) |
| FR08 | Fact capture with unknown and conflicting states | Implemented (deterministic extraction bound to transcript turns) | See "E08 Voice"; model-based extraction Not started |
| FR09 | Deterministic verifier: arithmetic, evidence, permission, open verbal requests | Implemented | review.ts approvalChecks; tests/verbal-guard.test.ts |
| FR10 | Review UI with evidence, payload, financial check, prerequisites, rationale | Implemented | Account workspace |
| FR11 | Approval bound to payload hash and account revision; atomic; idempotent execution | Implemented | stale review, double approval, duplicate dispatch tests |
| FR12 | Draft notes and note write-back | Implemented (deterministic template; write-back against the simulated PM) | See "Operations workstream"; real PM/EHR write-back Blocked (no system access) |
| FR13 | Follow-up scheduling from verified payer commitments | Implemented (synthetic calendars and commitments) | See "Operations workstream"; real payer calendars and turnaround commitments Blocked |
| FR14 | Receipt, remittance and cash reconciliation; promise vs acceptance vs adjudication vs cash kept separate | Implemented (synthetic remittance JSON and ingested synthetic 835) | See "Operations workstream" and "Cross-workstream glue"; real ERA/cash feeds Blocked |
| FR15 | Scoped audit export with redaction profile; export itself audited; hash chain | Implemented | audit test |
| FR16 | Halt controls | Implemented (client, payer and workflow via UI; tenant and global via DB) | pause test; tests/controls-analytics.test.ts |
| Security | Server-derived tenant/client scope, roles, separation of duties | Implemented | scope tests |
| Security | Signed, replay-protected receipt webhook | Implemented (simulated payer) | webhook test |
| Security | SSO/MFA, secrets manager, encryption at rest, BAA | SSO Implemented (OIDC + PKCE, MFA delegated to the IdP); secrets manager, BAA Blocked | See "Production hardening" below; ADR 0090; required before any PHI (docs/08) |
| Connectors | Live payer executor | Blocked (disabled by design) | livePayer always throws |
| Connectors | PM/EHR, 835/277/271, clearinghouse, FHIR feeds | Mocked (simulators, local mocks, synthetic X12 files) | See "Integrations workstream"; real feeds Blocked on design partner, enrollment and BAA |
| Eval | Fixture agreement: DED01 40/40, all packs 141/141, selection 17/17, 3-client cohort 35/35 | Implemented | evaluation/REPORT.md |
| Eval | Shadow-mode accuracy on labeled real cases | Blocked | Gate B needs authorized data and expert labels |
| Ops | Durable workflow runtime for long-running calls | Not started (calls use a restart-safe state machine in SQLite, ADR 0050) | ADR 0001 |
| Ops | Observability (traces, cost per account) | Not started | |
| UI | Call operations, outcomes, integration health screens | Implemented | Calls, Insights, Integrations pages; browser walkthrough (ADR 0060) |
| UI | Accessibility: semantic tables, labels, focus, Escape, 390px no horizontal scroll | Implemented (automated check only) | Playwright walkthrough of every page at 1400px and 390px for four roles; manual screen-reader and 200% zoom review Not started |

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
| KB | Draft CARC/RARC/group routing `routeScenario()`, derived from the selection map with stricter-only guards; unknown/multiple go to specialist review | Implemented (draft mapping) | shared/kb/routing.ts; tests/routing-consistency.test.ts |
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
| FR14 | 835 claim payments feed `RemittanceLine` reconciliation | Implemented (synthetic 835) | ADR 0060; tests/remittance-835.test.ts. Real ERA and cash feeds Blocked on a design partner |
| FR14 | Promise / accepted request / adjudication / cash kept apart in an append-only, hash-chained ledger; auditor export | Implemented | "outcome ledger is append-only" test |
| FR14 | Versioned attribution rule (ATTR01 v1, draft) with explicit methodology | Implemented (draft) | Customer-agreed methodology Blocked |
| FR14 | Contradictory outcome reopens the account (unchanged after request, unfavourable change, reversal, cash mismatch) | Implemented | "contradictions reopen the account" test |
| FR12 | Note write-back: own permissions, destination preview, hash + revision + PM record version binding, drafter cannot approve | Implemented | tests/writeback.test.ts |
| FR12 | Read-back verification; writeback_uncertain until read-back matches; never success without read-back | Implemented | "read-back mismatch stays writeback_uncertain" test |
| FR12 | Edited notes keep original draft, edits, editor and approver | Implemented | "edited notes keep the original draft" test |
| FR12 | PM/EHR target | Mocked | `server/connectors/sim-pm.ts` simulator; real PM write-back Blocked (no system access) |
| FR16 | Payer and workflow pauses (client supervisors); pending dispatches held with reason | Implemented | tests/controls-analytics.test.ts |
| FR16 | Resume releases held rows only after re-check (hash, revision, approver role, expiry, other pauses) | Implemented | "resume re-check blocks" test |
| FR16 | Tenant and global pause from the UI | Not started | Platform operation (database only). Controlled and pause-driven cancellation of active simulated calls is Implemented (see "E08 Voice") |
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
| Voice | Cross-channel duplicate check in review (verbal request vs outbox) | Implemented | ADR 0060 VERBAL01; tests/verbal-guard.test.ts |
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
| INT08 | Availity, Optum/Change Healthcare, Epic, athenahealth, SFTP EDI, Twilio adapters | Blocked (disabled by design; throw LiveExecutionDisabled). Availity, Optum and Twilio now have gated real adapters: see ADR 0100 section | integrations "live adapters refuse…" |
| INT09 | Generic signed webhooks: HMAC, timestamp window, server-side tenant resolution, dedupe, persist-before-ack, monotonic status with correction | Implemented (simulated provider) | integrations "signed connector webhooks…" |
| INT10 | Integrations admin UI with connector health (supervisor; `integration_admin` permission) | Implemented | web/src/pages/Integrations.tsx |
| INT11 | Scope isolation and permissions across all integration routes | Implemented | integrations "integration scope isolation and permissions" |
| INT12 | Real trading-partner feeds, payer IDs, patient identity crosswalk | Blocked | Design partner, BAA, enrollment (ADR 0030 "Blocked") |
## Cross-workstream glue (ADR 0060, migration 060)

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| FR14 | Ingested 835 claim payments (per SVC line, exact cents, reversals, paired corrections) reconcile into the outcome ledger in the ingest transaction; identity gate (claim + patient token + DOS) and per-client payer crosswalk; skipped claims reported with reasons | Implemented (synthetic 835) | tests/remittance-835.test.ts |
| FR14 | Reversal paired with a correction of the same line in the same remittance does not reopen; a lone reversal does | Implemented | tests/remittance-835.test.ts |
| FR14 | Real payer crosswalk (N1*PR / payer IDs) | Blocked | Synthetic one-row default (`DEMOPAYER` -> `demo-payer`); needs trading-partner data |
| FR05 | One routing source: KB routing derives from the versioned selection map; consistency test fails on any disagreement | Implemented | tests/routing-consistency.test.ts |
| FR05 | `kb:verify` fails when a selection-map CARC is missing from or deactivated in the KB CARC dataset | Implemented | tests/kb.test.ts; `npm run kb:verify` |
| FR05 | KB-proposed CARC rows (133, 252, 150, 151) | Not started (proposal only) | Need a new selection-map version and business sign-off |
| FR09 | Verbal acceptance on a call blocks approval and dispatch of a same-class request until receipt, adjudication change, no-request-on-file or reviewer release with reason | Implemented | tests/verbal-guard.test.ts |
| UI | Account page: KB code explanations for adjustment facts, "Simulated call" badge, readable voice/integration event labels, verbal requests panel | Implemented | docs/screenshots/account-ded01-codes.png, account-verbal.png |
| UI | Browser walkthrough of every page, four roles, 1400px and 390px: no console errors, no horizontal scroll | Implemented | ADR 0060; Operations no longer polls for non-supervisors |
## Ported from clinic-receptionist (ADR 0070, migration 070)

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| PHI01 | PHI readiness: vendors per layer, seven checks, `AR_PHI_MODE`, shown on the Integrations page | Implemented | tests/maya-port.test.ts "PHI gate: readiness…"; `GET /api/governance/readiness` |
| PHI02 | Vendor/BAA register: append-only, versioned, audited, `integration_admin`, scoped; backs the ADR 0030 live gate | Implemented (attestation recorded by a person; contracts not verifiable by code) | tests/maya-port.test.ts; tests/integrations.test.ts "live adapters refuse…" |
| PHI03 | Ingest gate: non-synthetic inventory rows and ISA15=P interchanges refused (409, audited); startup refuses unsafe `AR_PHI_MODE=on` | Implemented | tests/maya-port.test.ts "PHI gate: non-synthetic inventory…" |
| PHI04 | AES-256-GCM sealing of call text, hand-off packets, evidence content, write-back texts, notification payloads and settings | Implemented | tests/maya-port.test.ts "sealing…" |
| PHI05 | Sealing of note text inside the hash-bound proposed-action payload; key rotation | Implemented (ADR 0080, see PHI07/PHI08) | tests/maya-followups.test.ts |
| PHI06 | Real BAAs, hosting vendor, PHI mode in production | Blocked | docs/compliance/baa-tracker.md |
| GRD01 | Guard: inbound injection, agency, memory, identity, credential and payment-redirect flags; outbound identifier, human-claim, promise, disclosure and unsourced-figure checks; clinical rules kept disabled | Implemented | tests/maya-port.test.ts "Guard inbound…", "Guard outbound…" |
| GRD02 | Guard wired into the voice engine: rep turns become evidence warnings, a blocked agent utterance hands off, actions unchanged; transcript findings endpoint | Implemented | tests/maya-port.test.ts "Guard in the voice engine…" (sim script `guard_probe`) |
| TEL01 | Twilio request validation (documented vector), TwiML builders, call request builders, status-callback parsing and dedupe, signed webhook routes | Implemented (verified against Twilio docs 2026-10-12; no call placed) | tests/maya-port.test.ts "Twilio request validation…", "TwiML builders…", "status callbacks…" |
| TEL02 | Live telephony adapter as a real implementation behind an injected transport, refused by the deployment gate and the PHI gate | Implemented (refused) | tests/maya-port.test.ts "live telephony adapter…"; tests/voice.test.ts |
| TEL03 | Live call orchestration (relay socket, turn loop), Twilio account, BAA, counsel review | Blocked | ADR 0070 "Left open" |
| NOT01 | Notification connectors registry, audit-driven outbox, filters, retries and backoff, opaque payloads, simulated sink, settings UI | Implemented (real sends refused) | tests/maya-port.test.ts "notifications…" |
| NOT02 | Real Slack, Teams, email and SMS sends | Blocked (disabled; payload shapes ported, not re-verified) | ADR 0070 |
| FHIR01 | SMART discovery, safe base URLs, no redirects, timeouts, RS384 and ES384 with alg/key match | Implemented (against the local mock) | tests/maya-port.test.ts "SMART: discovery…"; tests/integrations.test.ts "FHIR R4 mock…" |
| DOC01 | Compliance documents (README, BAA tracker, SOC 2 roadmap, eight policies) | Implemented (DRAFT; no attestation) | docs/compliance/ |

## Follow-ups to the port (ADR 0080, migration 080)

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| KEY01 | Named API keys: own principal per client, token shown once and hashed, roles capped by the creator's current roles, human-only permissions never held, revocation final, every use audited; Access page | Implemented | tests/maya-followups.test.ts "API keys…"; web/src/pages/Access.tsx |
| PHI07 | `request.summary`, `note.text` and `note_draft` sealed inside the hash-bound payload; hash over plaintext; approval still binds; tampering detected | Implemented | tests/maya-followups.test.ts "sealed proposal…" |
| PHI08 | Keyring (`AR_PHI_KEYS`, key id bound as AAD), resumable audited re-encryption job, retirement refused while any client uses the key | Implemented | tests/maya-followups.test.ts "PHI key rotation…" |
| RET01 | Versioned retention policy per client with placeholder periods; batched purge to hash-keeping tombstones; worker job; dry run; audited | Implemented (periods are placeholders) | tests/maya-followups.test.ts "retention…" |
| RET02 | Retention periods from the customer contract and counsel | Blocked | docs/compliance/policies/data-retention.md |
| DEL01 | Two-person account deletion: request with reason, a different person approves, refused while in flight, tombstones free text, keeps audit/facts/ledger/hashes, approval binding still verifiable | Implemented | tests/maya-followups.test.ts "account deletion…" |
| DEL02 | Routing deletions to the system of record (PM/EHR) | Blocked | Needs a real PM integration; the simulated PM keeps its copy |
| GRD03 | Guard es/pt rules (accent-insensitive) for injection, agency, memory, identity, credential and payment redirect; spoken figures checked | Implemented (AR-authored es/pt rules; no native-speaker or counsel review) | tests/maya-followups.test.ts "Guard es/pt…" |
| REC01 | Call recording policy per client: consent mode configured by a person, counsel-review reference, disclosure line spoken first, deployment flag, PHI gate; simulated metadata with sealed storage reference; retention class; audited access | Mocked (simulated; off by default) | tests/maya-followups.test.ts "call recording…" |
| REC02 | Real recording (telephony account, storage, BAA, counsel review of consent law) | Blocked | ADR 0080 "Known gaps" |
| VAL01 | Value / operations card on Insights: measured counts and assumption-based estimates, each labelled, assumptions shown | Implemented (assumptions are placeholders) | tests/maya-followups.test.ts "value card…" |
| VOI01 | Spoken read-back of dollars, dates and references in words | Implemented | tests/maya-followups.test.ts "spoken read-back…" |
| UI | Access and Data governance pages, value card: browser check as supervisor, second reviewer and specialist with no console errors | Implemented | ADR 0080 |

## Production hardening (ADR 0090, migration 090)

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| ENV01 | `AR_ENV` synthetic/staging/production; non-synthetic fails closed on missing config (exit 78, every problem listed) | Implemented | tests/production.test.ts "production fails closed…" (each setting removed in turn) |
| ENV02 | Outside synthetic: no dev login or dev tokens, no simulator routes/executors/connectors, no draft baseline, no demo seed | Implemented | tests/production.test.ts "production app…", "outside synthetic, simulators never execute…", "production seed…" |
| SSO01 | OIDC authorization code + PKCE S256, state bound to browser, nonce, ID token signature/iss/aud/azp/exp/iat checks, JWKS rotation | Implemented (mock IdP) | tests/sso.test.ts; real Okta/Entra/Google tenant not tested (no credentials) |
| SSO02 | Admin-managed identity mapping, no auto-provisioning; email pre-link binds only when verified; disable revokes sessions | Implemented | tests/sso.test.ts "identity mapping…"; scripts/admin.ts |
| SSO03 | Server-side sessions (HMAC-stored, HttpOnly/Secure/SameSite), absolute + idle expiry, logout with end-session URL, CSRF token + Origin check | Implemented | tests/sso.test.ts |
| SSO04 | MFA | Blocked (customer IdP policy) | docs/SECURITY.md |
| HTTP01 | CSP, HSTS (production), frame-ancestors, nosniff, referrer policy, request ids | Implemented (CSP not browser-tested) | tests/production.test.ts "security headers…" |
| HTTP02 | CORS allowlist, rate limits per IP and credential, body limit, timeouts, error envelope without stacks | Implemented | tests/production.test.ts |
| OPS01 | JSON logs with request ids, no PHI (redaction test) | Implemented | tests/production.test.ts "log redaction…" |
| OPS02 | `/healthz`, `/readyz` (DB writable, migrations, keys, draining), `/metrics` behind a token | Implemented | tests/production.test.ts "/healthz, /readyz…" |
| OPS03 | Graceful shutdown (drain, worker finishes current item); worker as a separate process | Implemented | tests/production.test.ts "graceful shutdown…", "real processes…" |
| DATA01 | Online encrypted backups (node:sqlite backup API), schedule, restore with integrity check, tamper/wrong-key refusal | Implemented | tests/backup.test.ts; container restore verified |
| DATA02 | Off-site backup copies, restore drills, key escrow | Blocked (owner: storage, KMS, procedure) | docs/OPERATIONS.md §5-6 |
| PKG01 | Multi-stage Dockerfile, non-root, read-only root FS, healthcheck; compose for a single-node pilot | Implemented | Image built and run locally (ADR 0090 "Verification") |
| CI01 | GitHub Actions: typecheck, tests, build, eval, kb:verify, demo, fail-closed and container checks, no secrets | Implemented (not yet run on GitHub) | .github/workflows/ci.yml |
| SEC01 | Penetration test, SOC 2 readiness, BAAs, policies | Blocked (owner) | docs/SECURITY.md |
## Real integrations (ADR 0100, migration 100)

| Area | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| LIV01 | One config reader (`server/connectors/live/config.ts`): explicit mode per provider (off, sandbox, production), secrets from env or `<NAME>_FILE`, documented base URLs, vetted overrides | Implemented | tests/live-integrations.test.ts "config…" |
| LIV02 | Provider gate: mode + credentials + recorded, unrevoked authorization for the tenant/client; production also needs the ADR 0030/0070 live gate, `AR_PHI_MODE=on` and the connector switched to live; fails closed with reasons recorded as refused events | Implemented (mutation-tested) | tests/live-integrations.test.ts "gate…", "production gate…" |
| LIV03 | Sandbox sends synthetic or vendor-documented test data only (`sandbox_requires_synthetic`) | Implemented (mutation-tested) | tests/live-integrations.test.ts "sandbox…" |
| LIV04 | HTTP client: timeout, no redirects, 5 MB cap, retries with backoff only for idempotent reads on 429/503/network errors; circuit breaker reused | Implemented | tests/live-integrations.test.ts "retries and circuit", "timeouts" |
| LIV05 | Stedi raw X12 eligibility (270/271) and claim status (276/277) into the existing evidence/fact pipeline; 999 mapped to rejected | Implemented against documented payloads on a local mock; real sandbox call not run (no key in this environment) | tests/live-integrations.test.ts "Stedi…" |
| LIV06 | Stedi 835 ERA polling and report mapping with JSON path provenance; only matched claims attached, unmatched counted | Implemented against documented payloads on a local mock; ERA enrollment per payer Blocked | tests/live-integrations.test.ts "835…" |
| LIV07 | Optum eligibility v3 and claim status v2 (JSON) with OAuth client credentials | Implemented against documented sandbox values on a local mock; eligibility stored as events only | tests/live-integrations.test.ts "Optum…" |
| LIV08 | Availity Coverages with OAuth client credentials, polling, demo scenario header | Implemented against a local mock; stored as events only; Claim Statuses and Remittance NOT FOUND | tests/live-integrations.test.ts "Availity…" |
| LIV09 | Twilio test-credential call to documented magic numbers only | Implemented (sandbox); production calls Blocked (Conversation Relay not wired) | tests/live-integrations.test.ts "Twilio…" |
| LIV10 | Slack incoming webhook and Postmark email behind the gate; opaque summaries only | Implemented (Postmark has no BAA: never for PHI) | tests/live-integrations.test.ts "notifications…" |
| LIV11 | `npm run smoke:live -- <provider>`: documented test data only, refuses without keys or in production, results recorded | Implemented; PASS for all six with `--mock`; real sandbox runs not done (no keys here) | scripts/smoke-live.ts; tests/live-integrations.test.ts "overview/smoke" |
| LIV12 | Integrations page: per connector mode, env var presence (names only), authorization, gate reasons, last smoke, revoke | Implemented | web/src/pages/LiveConnectors.tsx |
| LIV13 | Member ID crosswalk, ERA reconciliation into the outcome ledger, Epic and athenahealth adapters | Blocked | ADR 0100 "Blocked" |
