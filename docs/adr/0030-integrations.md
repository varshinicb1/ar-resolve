# ADR 0030: Integrations: connector framework, X12 toolkit, FHIR read, simulators and webhooks

Status: Accepted for Phase 0 (synthetic data only). Date: 2026-10-12. Migration: `server/db/030_integrations.sql`.

## Context

Phase 0 needs every integration boundary in place, in the same shape as production, before any real data or vendor access exists (docs/07). Connectors may run only against synthetic data and local simulators. Live modes must refuse, with `LiveExecutionDisabled`, until authorization, covered-service verification, a BAA and onboarding are on record. Retrieved files are untrusted evidence. They feed observations, never instructions, and every fact keeps its provenance.

## Decisions

1. **Connector framework** (`server/connectors/framework.ts`)
   - One adapter contract:
     - Request: `requestId`, `scope`, `accountRevision`, `idempotencyKey`, `actionClass`, `timeBudgetMs`.
     - Response: `connectorEventId`, `outcome` (success, not_found, uncertain, partially_completed, error, timeout, refused), `externalRefs`, `evidenceLocator`, `sourceTime`, `receivedTime`, `rawSha256`, `normalized`.
   - Every call is persisted to `connector_events` and scoped by tenant/client.
   - Per-scope config (`connector_configs`) holds the mode (`local | simulated | disabled_live | live`), enabled and validated settings.
   - Onboarding records (`connector_onboarding`, 18 fields from docs/07) are versioned and immutable (the hash is stored and DB triggers block updates).
   - Authorization records (`connector_authorizations`) are append-only.
   - Live gate. `setMode('live')` returns 409 `live_gate_closed` unless all of these hold:
     - an authorization exists with covered-service verification and a BAA reference;
     - onboarding is complete;
     - `AR_ENVIRONMENT` is non-synthetic.

     Even with the gate open, the live adapters in this codebase still throw `LiveExecutionDisabled`.
   - Circuit breaker per scope and connector: opens after 3 consecutive failures, with a 60 s cooldown and a manual reset.
   - Health (status, last success, error rate, average and p95 latency) is derived from events. Refused calls are excluded from it.
   - Field mappings are versioned with a sha256 (`field_mapping_versions`, `server/connectors/mappings.ts`). Every ingested item records the mapping id, version and hash.
2. **X12 5010 toolkit** (`server/connectors/x12/`)
   - Strict envelope parsing:
     - Delimiters come from the fixed-width 106-character ISA: element at position 4, repetition at ISA11, component at ISA16, segment terminator at 106.
     - Control and count pairing is checked: SE01 against the actual count, ST02=SE02, GS06=GE02, GE01, ISA13=IEA02 and IEA01.
     - Malformed input is rejected with specific codes (`no_isa`, `truncated_isa`, `bad_isa`, `bad_delimiter`, `bad_segment`, `truncated`, `count_mismatch`, `control_mismatch`, `missing_iea`, `bad_amount`, `bad_date`, `bad_cas`, `unsupported_transaction`).
   - Money is parsed to integer cents exactly; there is no float rounding, and more than 2 decimals is rejected.
   - Mappers: 835, 277 (with the 277CA variant), 271 and 999. Generators: 276 and 270, plus simulator responses for 277, 271, 835 and 999.
   - Parse then re-serialize is byte-identical for all fixtures.
3. **Ingestion**
   - New evidence kinds: `edi_835`, `edi_277`, `edi_271`, `fhir_eob`, `fhir_coverage`. `evidence.ts` gained one import, one union member and a `default:` branch.
   - Observations are produced only from an allowlisted `content.extracted` per kind (`server/connectors/observations.ts`), so arbitrary file content cannot assert facts.
   - Upload goes through `preview` first. It parses the file and matches each item by claim reference, patient token and DOS (271: patient token plus a DTP*291 period covering the DOS).
   - The match result is matched, unmatched, ambiguous, identity_mismatch or insufficient_identity. Only matched items are ingested. Mismatches are reported and audited (`integration_identity_mismatch`) and never guessed.
   - `ingest` requires `expectedSha256` from the preview (409 `preview_mismatch` otherwise) and is idempotent per scope and sha256.
   - After ingest, facts are re-resolved. An account already under evaluation is re-evaluated (trigger `integration_evidence`) unless it is paused or has an action in flight.
   - 835 reversals (CLP02=22) produce no observations. A corrected claim that follows conflicts with the original EOB, so the fact becomes `conflicting` rather than silently replaced.
   - A 277CA is an acknowledgment only: it produces `claimAcknowledgment` and never a status, payment or adjudication fact.
   - Four new fact keys (`claimStatusCategory`, `deductibleRemainingCents`, `claimPaidCents`, `processedDate`) are resolved like any other fact. DED01 does not consume them.
4. **Simulated clearinghouse** (`sim-clearinghouse.ts`)
   - It answers real 276/270 X12 built by the generators with 277/271 X12 derived from the synthetic cohort:
     - A4/35: claim not found.
     - A4/33: member mismatch.
     - P1/20: no EOB yet.
     - F4/1 or F1/65: finalized.
   - Latency and per-scope fault injection are supported: timeout, error, malformed and partial. A malformed response is rejected inside the adapter and reported as an error.
   - `structuredStatusFirst` runs a 276/277 before any call and records the 277 as evidence. It is wired into `investigate` behind the per-client setting `sim_clearinghouse.settings.structuredStatusFirst`, which defaults to **off**, so the existing workflow and evaluation are unchanged.
5. **FHIR R4 read** (`server/connectors/fhir/`)
   - SMART Backend Services client:
     - Signed ES384 JWT client assertion: `iss = sub = client_id`, `aud =` token URL, `exp` at most 5 minutes out, unique `jti`, and a `kid` header.
     - `client_credentials` grant with `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`.
     - System scopes.
   - A local mock server validates the assertion signature, audience, expiry and jti replay, enforces scopes, and serves synthetic EOB, Coverage and Patient resources.
   - The read client allowlists resource types. A Patient is reduced to a token, and demographics are discarded before anything is stored.
6. **Disabled live adapters** (`live-adapters.ts`)
   - Covered: Availity, Optum/Change Healthcare, Epic, athenahealth, SFTP EDI and Twilio voice.
   - Each carries an enablement checklist, sources and a health stub. `execute` always throws `LiveExecutionDisabled`.
   - Endpoint paths appear only where a public page was read (Availity `/v1/coverages`; Optum `/apip/auth/v2/token` and `claimstatus/v2/`). Every base URL and credential is left as configuration.
7. **Webhooks** (`webhooks.ts`)
   - A generic provider registry.
   - Inbound requests are HMAC-SHA256 signed over `timestamp.rawBody`, compared in constant time, and must fall within ±5 minutes.
   - The provider account maps to tenant/client on the server. Scope claims in the payload are ignored.
   - Events are deduplicated by event id and persisted before processing. A failed apply is marked `failed`, not lost.
   - Claim status state is monotonic by category rank and occurrence time. Only an explicit `correction` may move it backward.
   - Notifications update tracked status only and never create facts.
8. **UI**: `web/src/pages/Integrations.tsx`, shown in the nav for supervisors and guarded on the server by the new `integration_admin` permission (granted to the supervisor role, so u_sam has it).

## Sources per mapping (all read in this session; retrieved 2026-10-12)

| Mapping / layout | Source |
| --- | --- |
| ISA/GS/ST/SE/GE/IEA envelope, delimiter positions | x12.org public examples (https://x12.org/examples); ecosio "The structure of an ANSI ASC X12 file" (https://ecosio.com/en/blog/the-structure-of-an-ansi-asc-x12-file/); IBX inbound/outbound envelope guides (https://www.ibx.com/pdfs/providers/claims_and_billing/edi/inbound_env_ibx.pdf, …/outbound_env_ibx.pdf) for ISA element names and GS01 `HR` |
| 835 BPR, TRN, N1, CLP, NM1, SVC, CAS, AMT*B6, LQ*HE, DTM, PLB | x12.org 005010X221 Examples 01–08 (https://x12.org/examples/005010x221); CMS 835 companion guide 5010A1 v3.0 (https://www.cms.gov/medicare/billing/electronicbillingeditrans/downloads/5010a1835cg.pdf); Nevada Medicaid 835 companion guide (https://www.medicaid.nv.gov/Downloads/provider/companionguide835.pdf) for BPR01 `H`/BPR04 `NON` on zero payment and DTM*405 |
| CLP02 = 22 reversal; reversal + correction pattern | Minnesota Uniform Companion Guide 835 (https://www.health.state.mn.us/facilities/ehealth/auc/guides/docs/cg835.pdf); x12.org RFI 2365 (CLP02 1 vs 19) |
| CAS group codes, CARC 1/2/3/45 | x12.org code lists (https://x12.org/codes/claim-adjustment-group-codes, https://x12.org/codes/claim-adjustment-reason-codes) |
| 276/277 HL hierarchy, TRN, REF*EJ, STC | x12.org 005010X212 Examples 1a/1b and 01/02 (https://x12.org/examples/005010x212) |
| 277CA (X214) receiver and claim STC | x12.org 005010X214 Examples 01/02 (https://x12.org/examples/005010x214) |
| STC category and status codes used | x12.org claim status category codes and claim status codes (https://x12.org/codes/claim-status-category-codes, https://x12.org/codes/claim-status-codes) |
| 270/271 HL, NM1, DTP*291, EB (C/IND/FAM, EB06 23/29, EB01 R) | x12.org 005010X279A1 examples (https://x12.org/examples); CMS HETS 270/271 companion guide v14.0 (https://www.cms.gov/files/document/hets2025-4-hets-270-271-companion-guide-v14-0.pdf); UHC 270/271 companion guide (https://preview-gateway.uhcprovider.com/content/dam/provider/docs/public/resources/edi/EDI-270-271-Companion-Guide-005010X279A1.pdf); Minnesota best practice on EB01 R (https://www.health.mn.gov/facilities/ehealth/auc/bestpractices/docs/bpelige9.pdf) |
| 999 AK1/AK2/IK3/IK4/IK5/AK9 | x12.org 005010X231 Example 01 (https://x12.org/examples) |
| FHIR EOB, Coverage, adjudication categories | https://hl7.org/fhir/R4/explanationofbenefit.html, https://hl7.org/fhir/R4/coverage.html, https://hl7.org/fhir/R4/codesystem-adjudication.html |
| SMART Backend Services | https://hl7.org/fhir/smart-app-launch/backend-services.html (v2.2.0) |
| Vendor descriptors | Availity HIPAA transactions blog (2025-03-25); Optum Claim Status V2 getting started; open.epic.com Claims; Twilio HIPAA page (URLs in each descriptor's `sources`) |

## Unverified or assumed (marked in code)

- GS01 functional identifiers: only `HP` (835) and `HR` (276) are confirmed by sources I read. `HN` (277), `HS` (270), `HB` (271) and `FA` (999) are flagged `unverified` in `FUNCTIONAL_IDS`.
- The 835 balancing formula (claim and line `charge − paid = Σ CAS`; BPR02 = Σ CLP04 − Σ PLB) and the PLB sign convention are implemented as informational checks, marked unverified. The full TR3 balancing rules are in the licensed guide.
- 270 `EQ` usage and the omission of DMG in the generated 276/270 follow the public examples only.
- Carrying the synthetic patient token as NM1 `MI` is a synthetic convention. Real files need a client crosswalk.
- The 277CA trace is used as the claim reference only when REF*EJ is absent.
- 271 "met before" is not a payer statement. It is derived from limit minus remaining only when a client opts in (`deriveMetBeforeFromRemaining`, default off), because "remaining" reflects the inquiry date.
- athenahealth documentation was client-rendered and could not be read. Its descriptor lists no endpoint paths and is marked unverified.

## Where the licensed X12 TR3 implementation guides are required

Before any production 835, 277, 277CA, 271, 999, 276 or 270 exchange, the complete situational rules, loop repeat limits, element min/max lengths, code-value usage notes, balancing requirements and acknowledgment semantics must be checked against the licensed TR3s (005010X221A1, X212, X214, X279A1, X231A1) and the trading partner's companion guide. The public examples cover only a subset of each layout.

## Blocked

- Every live adapter is blocked on a signed agreement, BAA, covered-service verification, trading partner enrollment, credentials in a secrets manager, a non-synthetic environment and security review (docs/08).
- Real patient identity crosswalks and payer IDs are blocked on a design partner. Only "Demo Payer A" / `DEMOPAYER` appears.
- The FHIR endpoints of real EHRs need app registration with each vendor.

## Consequences

- Integration evidence uses the existing evidence, fact and audit pipeline. No rule or verifier change was needed, and the existing tests and the 40/40 evaluation are unchanged.
- The structured-status step is opt-in per client, so behavior changes only when a supervisor turns it on.
