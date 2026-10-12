# ADR 0060: Cross-workstream glue: 835 reconciliation, one routing source, verbal-request guard

Status: accepted for the synthetic environment. Date: 2026-10-12. Migration range 060-069 (`server/db/060_glue.sql`).

## Context

Five workstreams (ADR 0010 knowledge base, 0020 rule packs, 0030 integrations, 0040 operations, 0050 voice) were built in parallel and merged. Each left a seam it could not close alone:

- The 835 parser (0030) and the outcome ledger's `RemittanceLine` contract (0040) were not connected, so reopen and attribution logic only ran on hand-made JSON.
- The KB routing table (`shared/kb/routing.ts`) and the rule-pack selection map (`shared/rules/select.ts`) both mapped CARCs to scenarios and disagreed: different pack ids (BUND01 vs BUN01) and different code sets (KB routed 133, 252, 150 and 151; the map did not).
- After a representative verbally accepted a request, a later re-investigation could produce a new `clarify_allocation` proposal that a reviewer could approve and the outbox could dispatch (0050 known limitation).

## Decisions

1. **835 → remittance reconciliation** (`server/connectors/remit-835.ts`).
   - Ingest reconciles before it attaches evidence, so the baseline is the account as it stood before the file. Accounts the remittance reopened or resolved are not re-evaluated by the same ingest; the reconciliation outcome stands and a human takes it from there.
   - Only identity-matched claims are reconciled (claim reference, patient token and DOS, the same gate as evidence). Reversal items, which carry no evidence, are identity-checked separately. The ledger's own claim+payer match must agree with the identity match, or the transaction aborts.
   - Mapping `x12-835-remittance-lines` v1: one `RemittanceLine` per SVC loop. Line paid is SVC03; allowed is AMT*B6; CAS triplets become adjustments in exact cents with their signs. Claim-level CAS is folded in only when there is one service line. A claim without SVC becomes one claim-level line. A non-reversal line without AMT*B6 is not mapped (reported). A reversal line without AMT*B6 carries `allowedReported: false`.
   - The adjudication date is DTM*405 (production date), else BPR16. This is a stated convention: the 835 has no single "adjudication date" element in the public examples.
   - CLP02=22 is a reversal. A claim that follows a reversal of the same claim id in the same file is `corrected`.
   - A reversal paired with a corrected line of the same claim, payer and line in the same batch is recorded but does not reopen. The corrected line is judged on its own (favourable, unchanged or unfavourable). A lone reversal still reopens (ADR 0040 decision 6). This applies to JSON remittance batches too.
   - Payer identity uses a per-client `payerCrosswalk` setting on `edi_upload`: the N1*PR N104 identifier if present, else the ISA06 sender, mapped to the internal payer id. The default is one synthetic row (`DEMOPAYER` → `demo-payer`). A payer that is not in the crosswalk is skipped and reported, never guessed.
   - The ingest report gains `remittance` (batch, results, skipped with reasons, reopened, resolved), and the Integrations toast summarizes it.
2. **One routing source.**
   - The selection map (`SCENARIO_MAP` v1) is the source of truth. `shared/kb/routing.ts` derives its CARC rows from it (`ROUTING_SOURCE_MAP`, routing version `kb-routing/draft-2+SCENARIO_MAP@1`) and adds only *guards*: a group restriction (DED01 under PR, DUP01 under OA/CO), a required RARC for a generic CARC (16 needs M127), and corroborating or competing RARCs.
   - A guard can only send an input to specialist review. `routeScenario` also calls `selectScenario` and refuses if they disagree.
   - The KB-only rows (133 → PEND01, 252 → DOC01, 150/151 → MN01) become `PROPOSED_ROUTES`. They never route; they wait for a new map version and sign-off.
   - The bundling playbook id is renamed BUND01 → BUN01 (dataset re-hashed; the loader versions it).
   - `kb:verify` now fails when a map CARC or RARC is unknown or deactivated in the KB code lists, when a map scenario has no playbook, or when a guard names a CARC the map does not route to that scenario. `tests/routing-consistency.test.ts` checks every mapped CARC under every group code.
   - Playbook route lists also show the map's claim-status rows (PEND01).
3. **Verbal-request guard** (`server/services/verbal-requests.ts`, `VERBAL01` v1).
   - A `reprocessingCommitment` answer with status `accepted_by_rep` is an open verbal request of class `clarify_allocation` until one of these happens:
     - an `action_receipt` evidence is recorded after it;
     - an `adjudication_changed` or `reversal` ledger entry is recorded after it (an unchanged adjudication does not count: the request may still be in process);
     - a later call's reconciliation reports no request on file;
     - a reviewer releases it with a reason of at least 15 characters (append-only `verbal_request_overrides`, one per acceptance, audited as `verbal_request_released`).
   - It is enforced in `approvalChecks` (check `no_open_verbal_request`, shown with the other prerequisites) and again at dispatch in the outbox. Dispatch covers a request approved before the call that accepted it.
   - Routes: `GET /api/accounts/:id/verbal-requests` (view) and `POST /api/verbal-requests/:answerId/release` (review permission). Both are scoped by tenant and client. An out-of-scope id is a 404.
4. **Account page.**
   - `<CodeExplain>` renders for each (group, CARC) in the `lineAdjustments` fact, and for the `adjustmentGroup` fact with CARC 1. Both the EOB and 835 extractors take that fact from the CARC 1 adjustment. Remark codes come from the `remarkCodes` fact.
   - Voice-engine calls are labelled "Simulated call" (the view exposes `engineCallId`).
   - Voice, integration and glue events have readable timeline labels.
   - A "Verbal payer requests" panel shows status and offers release to reviewers.
5. **Browser walkthrough.**
   - Playwright with Chromium, at 1400px and 390px, signed in as specialist, reviewer, supervisor and auditor.
   - It visited every page: three accounts (DED01, PEND01, DOC01), a pack detail with a new draft validated, a call started and advanced, and an EDI preview.
   - Found and fixed: the Operations page polled the supervisor-only outbox for every role (repeated 403 console errors).
   - No horizontal scroll was found at 390px.

## Shared-file edits

All edits are small:

- `outcomes.ts`: `importRemittance` split into a permission/transaction wrapper and `reconcileRemittance`; paired-reversal flag; optional `allowedReported`.
- `ingest.ts`: reconcile 835 before attaching; `attachItems` takes an optional settled-accounts map.
- `framework.ts`: `payerCrosswalk` default and validation.
- `review.ts`: one check.
- `outbox.ts`: one dispatch problem.
- `views.ts`: `engineCallId` on interactions.
- `kb.ts`: playbook routes include claim-status rows.
- `Account.tsx`, `Knowledge.tsx`, `Operations.tsx`, `Integrations.tsx`.
- `modules.ts`: one line.

## Blocked on real-world access

- A real payer crosswalk and payer IDs. The production meaning of the 835 dates, splits, interest and PLB handling needs the licensed 005010X221A1 TR3 and the trading partner's companion guide.
- Real ERA and cash feeds, and the customer's attribution methodology.
- Business sign-off of the selection map, the KB guards and the proposed routes. A verified RARC source is still missing.
- Whether a verbal acceptance is honoured by a given payer, and how a written receipt for it arrives, depends on payer-specific practice and a real telephony provider (ADR 0050).
