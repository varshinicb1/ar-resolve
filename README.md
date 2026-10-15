# AR Resolve: synthetic platform build

An evidence-backed payer follow-up workspace for US medical AR (accounts receivable) teams. It investigates an open claim balance, resolves every material fact from a source with provenance, selects a versioned scenario pack, proposes the next action, and sends nothing until a human reviewer approves the exact payload. Approved actions go through an idempotent outbox to (simulated) connectors. Calls, remittances, follow-ups and outcomes feed back into the same evidence, fact and audit pipeline.

This is not production software. Every account, payer, amount, transcript and file is synthetic. It holds no PHI. Live integrations are off by default: Stedi, Availity, Optum, Twilio, Slack and Postmark have real adapters (ADR 0100) that refuse with `LiveExecutionDisabled` until a mode, keys and a recorded authorization are present, and production also needs the PHI gate; the rest are typed adapters that always refuse. Keys and modes can be entered in the app on **Integrations > Connect providers** (ADR 0110; secrets sealed at rest, environment variables still win), with a "Test sandbox" button per provider. Setup: [docs/INTEGRATIONS_SETUP.md](docs/INTEGRATIONS_SETUP.md). Every rule, routing map, playbook and attribution method is a draft that needs business sign-off.

## Run it

Requires Node 22.18 or newer.

```bash
npm install
npm run build          # build the web UI
npm start              # API + UI + embedded outbox worker on http://localhost:8080
```

Development with hot reload: `npm run dev` (API on 8080, UI on http://localhost:5173). Data lives in `data/ar-resolve.db` (override with `AR_DB`); delete it to start fresh. The simulated payer line keeps synthetic business hours (America/Chicago, weekdays); set `AR_SIM_PAYER_ALWAYS_OPEN=1` to call it at any time during a demo.

| Command | What it does |
| --- | --- |
| `npm test` | 207 tests in 26 suites over the real HTTP API (see below) |
| `npm run smoke:live -- <provider>` | Calls a vendor sandbox with documented test data only; refuses without keys or in production mode (`--mock` rehearses against a local mock) |
| `npm run demo` | The Phase 0 acceptance journey end to end through the API, including a restart |
| `npm run eval` | Regenerates `evaluation/REPORT.md`: DED01 40/40, all packs 141/141, selection 17/17, 3-client cohort 35/35 |
| `npm run kb:verify` | Knowledge base integrity: provenance, hashes, duplicates, citations, and that every code the routing and the selection map use exists and is active |
| `npm run worker` | Standalone outbox worker (start the API with `AR_WORKER=off` to use it) |
| `npm run backup` / `npm run restore` / `npm run admin` | Encrypted online backup, verified restore, operator provisioning of users, grants and SSO links (ADR 0090, docs/OPERATIONS.md) |
| `npm run typecheck` | TypeScript check |

Test suites: workflow 5, review/execution 11, scope 2, rule engine 3, scenario packs 6, rule studio 4, knowledge base 6, routing consistency 3, X12 7, integrations 9, 835 remittance 4, follow-ups 5, outcomes 4, write-back 5, controls/analytics 4, voice 16, verbal-request guard 3, clinic-receptionist port (PHI gate, Guard, telephony, notifications, SMART) 13, port follow-ups (keys, sealing, rotation, retention, deletion, es/pt Guard, read-back, recording, value) 9, production hardening 13, single sign-on 11, backups 4, connect providers 12.

Deploying a pilot (staging/production, SSO, Docker, backups): see [docs/OPERATIONS.md](docs/OPERATIONS.md) and [docs/SECURITY.md](docs/SECURITY.md).

## What each page does

| Page | Who | What |
| --- | --- | --- |
| Work queue | everyone | Saved views, explained priority, server pagination and scoped search over accounts |
| Account | everyone (actions by role) | Identity, facts with status and source (click a badge to open the exact field), **adjustment codes explained** from the knowledge base, evidence with hashes, scenario selection, the rule's arithmetic and proposal, review prerequisites, the call panel, verbal payer requests, payer interactions, follow-up, write-back, outcome ledger and timeline |
| Reviews | reviewers | Proposals awaiting review |
| Calls | everyone (start: specialist) | Active and recent simulated payer calls, call policy, payer lines, live telephony checklist |
| Import | specialist | Inventory CSV with mapping preview, row validation, ambiguous-row rejection and idempotent re-import |
| Rule studio | everyone (edit: reviewer/supervisor; approve: rule approver) | Nine scenario packs, versions, draft → validate → review → publish → retire, fixture runner in the browser, before/after impact, the versioned selection map |
| Follow-ups | specialist, supervisor | Due/overdue/upcoming/snoozed queue, review-interval policy, business calendars |
| Insights | everyone | Value and operations card (measured counts and labelled estimates), KPIs with definitions, outcome ledger (export for auditors), analytics events, synthetic remittance import, capacity and unit-economics calculator |
| Operations | supervisor | Outbox, halt controls (client, payer, workflow), held dispatches, simulated faults, audit chain health |
| Knowledge | everyone | Search, explain an adjustment, playbooks, regulatory articles, glossary, X12 code lists, synthetic payer directory, dataset provenance |
| Integrations | supervisor | Connector health and modes, EDI preview/ingest (835, 277, 277CA, 271, 999), simulated clearinghouse, signed webhooks, mapping versions, connector events, PHI readiness, vendor/BAA register, notification channels with the simulated sink |
| Data governance | everyone (changes: supervisor; deletion approval: a second supervisor or reviewer) | Retention policy (placeholder periods) and purge, two-person account deletion, PHI key status, re-encryption and retirement, call recording policy and its gate |
| API keys | supervisor | Named service-account keys: create (token shown once), roles capped by yours, revoke, last use |

## Demo walkthrough (about 15 minutes)

Sign-in is a development identity picker. Each person has server-side grants.

| User | Role | Scope |
| --- | --- | --- |
| Ana | AR specialist | Orthopedics, Dermatology, Multispecialty |
| Rui | Reviewer | Orthopedics, Dermatology, Multispecialty |
| Lee | Second reviewer, rule approver | Orthopedics, Dermatology, Multispecialty |
| Sam | Supervisor, rule approver | Orthopedics, Dermatology, Multispecialty |
| Ada | Auditor | Orthopedics |
| Bea | Specialist + reviewer | Other tenant only |

Start with `AR_SIM_PAYER_ALWAYS_OPEN=1 npm start` and a fresh database.

1. **Ana → Import.** Load the file with ambiguous rows and preview it: every bad row is rejected with a reason. Then load the Orthopedics inventory and commit 10 accounts. Switch the client selector to Multispecialty and import that inventory too.
2. **Ana → SYN-1042 → Run investigation.** Facts resolve to Verified and DED01 shows the arithmetic: the deductible was already met, but $425.00 was applied. It proposes a payer clarification request. Under the facts, **Adjustment codes explained** shows PR-1 from the knowledge base and the draft route to DED01.
3. **Rui → SYN-1042.** Approve with a rationale. The worker dispatches to the simulated payer and records the receipt; the UI says "request accepted", never "paid".
4. **SYN-1046 and SYN-1045 (Ana):** the legacy pre-scripted calls show a contradiction (the fact turns Conflicting and the proposal is superseded) and a transcript injection that has no effect. Lee approves the corrected proposal because Rui generated it.
5. **Multispecialty (Ana):** investigate SYN-3101 (PEND01, claim status follow-up) and SYN-3201 (DOC01, documentation request). The Scenario panel explains why each pack was selected; SYN-3501 (codes not in the map) routes to specialist review.
6. **Simulated payer call (Sam, then Ana).** Sam opens Calls and enables pre-authorized verbal reprocessing in the client call policy (a reason is required). Ana opens a fresh DED01 account, investigates, and presses **Start call**. Watch IVR, hold, the representative, read-back of amounts and references, and the verbal acceptance. The open proposal is superseded, the account waits for receipt, and **Verbal payer requests** shows the commitment as open. Payer interactions labels the call **Simulated call**.
7. **Duplicate guard.** Re-run the investigation on that account. The new clarify-allocation proposal shows a failed prerequisite: the payer already accepted this request verbally. A reviewer can release it only with a reason; a receipt or an adjudication change on a remittance releases it automatically.
8. **Sam → Integrations → EDI intake.** Load the `835-cl_ortho-era.edi` sample and preview: eight claims match by claim reference, patient token and date of service; SYN-1044's patient token does not and is reported, never attached. Ingest: facts become Verified from the 835 and every matched claim line is reconciled into the outcome ledger. Then ingest `835-cl_ortho-corrected-after-request.edi`: the reversal is paired with its correction, the favourable change after SYN-1042's accepted request is attributable under the draft ATTR01 rule, and the account resolves. A reversal without a correction reopens the account instead.
9. **Rule studio (Sam, Lee).** Open PEND01, create a draft, edit a parameter, validate (schema plus all fixtures), submit, approve as Lee (a different person), publish with an activation time.
10. **Follow-ups and Insights.** Follow-ups come only from a captured payer commitment or a labelled policy interval. Insights shows KPIs with definitions and the hash-chained outcome ledger.
11. **Knowledge.** Search "deductible", explain CO-16 with and without RARC M127, open the playbooks and the sourced code lists.
12. **Sam → Operations:** arm "Timeout after success", approve another proposal and watch Receipt uncertain resolve by read-back without a second submission. Pause a payer or workflow; pending dispatches are held and re-checked on resume.
13. **Ada → account → Export audit packet:** a scoped JSON packet with evidence hashes, fact history, runs, decisions, outbox state and a verified hash chain; the export itself is audited. Ada can read but not act.

Screenshots of the newer screens are in `docs/screenshots/`.

## Layout

```
server/
  db/              SQLite migrations: 001 core, 010 KB, 020 rule studio, 030 integrations, 040 operations, 050 voice, 060 glue, 070 port
  services/        auth/scope, evidence, facts, rules, scenario, workflow, review, outbox, audit, controls, views,
                   kb, rule-studio, followup, calendar, outcomes, writeback, analytics, kpis, verbal-requests, voice/,
                   governance (PHI gate), phi (sealing), guard, notifications
  connectors/      framework, X12 toolkit (x12/), FHIR (fhir/), EDI ingest, 835 -> remittance, simulators
                   (payer, clearinghouse, PM, voice), webhooks, disabled live adapters, telephony/ (Twilio contract)
  http/            app.ts core routes, routes/<area>.ts per workstream, modules.ts registry
shared/rules/      scenario packs, registry, selection map (routing source of truth), fact catalog
shared/kb/         KB routing derived from the selection map
knowledge/         sourced, hashed datasets (X12 code lists, groups, playbooks, articles, glossary, synthetic payers)
web/               React workspace
fixtures/          synthetic cohort and synthetic X12 files
evaluation/        fixtures and the generated REPORT.md
docs/              ADRs 0001-0080, completion matrix, compliance drafts, screenshots
tests/             node:test suites over the real HTTP API
```

## Design decisions

ADRs: [0001 architecture](docs/adr/0001-phase0-architecture.md), [0010 knowledge base](docs/adr/0010-knowledge-base.md), [0020 scenario packs and rule studio](docs/adr/0020-scenario-rule-packs.md), [0030 integrations](docs/adr/0030-integrations.md), [0040 operations and outcomes](docs/adr/0040-operations.md), [0050 voice calls](docs/adr/0050-voice-calls.md), [0060 cross-workstream glue](docs/adr/0060-cross-workstream-glue.md), [0070 clinic-receptionist port](docs/adr/0070-clinic-receptionist-port.md), [0080 port follow-ups](docs/adr/0080-maya-followups.md). In short:

- Facts are resolved from source observations. Unknown stays missing and disagreement is conflicting. Transcripts and files are untrusted evidence, never instructions.
- Approval binds to the payload hash and account revision. The executor re-checks state, hash, revision, the approver's current role, pauses and open verbal requests before dispatch.
- A timeout produces `uncertain`. Only a connector read-back resolves it; nothing is resubmitted blindly.
- Scenario selection uses one versioned map; the knowledge base derives its routing from it and can only be stricter.
- A payer promise, an accepted request, an adjudication change and cash are separate ledger entries. Recovery is attributable only under an explicit, versioned draft rule.

## Hosted demo on Cloudflare (ADR 0120)

`deploy/cloudflare/` runs the synthetic app on Cloudflare Containers behind a password page. Needs the Workers Paid plan and Docker on the machine that deploys:

```bash
cd deploy/cloudflare
npm ci
npx wrangler login
npx wrangler secret put DEMO_PASSWORD   # at least 12 characters
npx wrangler deploy                     # first deploy can take several minutes to provision
```

Or run `node deploy/cloudflare/setup.mjs` (Docker running): it opens a local page where you enter only the Cloudflare API token, account ID and demo password, and it runs the deploy for you. Add `--dry-run` to build without uploading.

The demo resets after 30 idle minutes (container disk is ephemeral). Use vendor sandbox/test keys only.

## Limitations

- Everything is synthetic. All packs, the selection map, the attribution rule and every playbook are **drafts** with synthetic labels; evaluation checks mechanics, not payer policy or accuracy.
- Calls run against a scripted simulated payer line with deterministic extraction. There is no telephony, speech or model.
- X12 handling follows public examples only; full TR3 conformance is not verified. The 835 payer crosswalk is a synthetic one-row default. Balancing checks are informational.
- The PM/EHR, clearinghouse, payer and FHIR endpoints are simulators or local mocks.
- Sign-in is development-only: no SSO, MFA or secrets management. Free text, including note text inside approved payloads, is sealed at rest only when `AR_PHI_KEY` or `AR_PHI_KEYS` is set (ADRs 0070, 0080). Retention periods are placeholders; call recording is simulated metadata and off by default. SQLite with a single writer process.
- The PHI gate refuses non-synthetic data; nothing here is HIPAA compliant or SOC 2 attested (docs/compliance/, all drafts).
- Accessibility was checked automatically (semantic tables, labels, focus, Escape, no horizontal scroll at 390px in a browser walkthrough of every page) but not with a screen reader or at 200% zoom.

Full status per requirement: [docs/COMPLETION_MATRIX.md](docs/COMPLETION_MATRIX.md).

## Blocked on real-world access

Nothing below can be built or verified from inside this repository. Each item needs a person or an agreement.

1. **Design partner:** one RCM organization, client portfolio, PM/EHR system and version, payer mix, patient identity crosswalk, payer IDs, and a named business owner for each pack.
2. **BAA and data access agreement** before any real data (Gate B shadow mode, read-only), then expert-labelled cases for evaluation.
3. **Business sign-off** of every pack, the CARC-to-pack selection map, the KB playbooks and articles, and the attribution methodology (contract definition of resolution).
4. **Vendor accounts and contracts** (what each needs: [docs/INTEGRATIONS_SETUP.md](docs/INTEGRATIONS_SETUP.md)): Stedi, Availity and Optum/Change Healthcare (clearinghouse, trading-partner enrollment), Epic and athenahealth (app registration, FHIR endpoints), Twilio or another HIPAA-eligible telephony provider (BAA, number registration, counsel review of call law, recording and disclosure).
5. **X12 license** for the TR3 implementation guides and the full CARC/RARC/claim-status code text; a verified RARC source for RARC routing.
6. **Payer-specific policy:** timely filing, authorization, medical necessity, bundling, business calendars and turnaround commitments.
7. **Production infrastructure:** identity provider (SSO + MFA), managed keys, secrets manager, PostgreSQL and a workflow runtime, security review.
