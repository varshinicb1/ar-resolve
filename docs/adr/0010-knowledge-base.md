# ADR 0010: Knowledge base

Status: accepted for the synthetic environment. Date: 2026-10-12.

## Context

Scenario selection (FR05), specialist review, call playbooks and notes all need shared reference data: X12 code lists, adjustment group codes, regulatory facts, structured scenario playbooks, a glossary and payer contact data. CLAUDE.md requires provenance on every material fact. Build pack doc 04 says code lists and implementation guides carry licensing terms and must not be bundled without authorized access.

## Decision

1. **Datasets are files under `knowledge/`** with a header `{dataset, title, source, sourceUrl, retrievedAt, method, count, coverage, license, sha256}` and an `entries` array. `sha256` is the canonical-JSON hash of `entries` (`hashJson` in `server/util.ts`).
2. **The loader (`server/services/kb.ts`) loads by hash.** When a file's hash differs from the active `kb_sources` row, it adds a new version, deactivates the old one and replaces that dataset's rows. Every row records its `dataset_version`. If a header hash or count does not match, loading is refused (`KbIntegrityError`). The loader runs once when the KB route module registers.
3. **Scope.** Codes, articles, playbooks and the glossary are global reference data, but reading them still needs an authenticated user with a granted scope (`view`, which every role holds). The payer directory (`kb_payers`) is keyed by tenant and client and always filtered by the resolved scope. It is also kept out of the global search index, so search cannot leak it across scopes.
4. **X12 content is limited to what we may store and what we actually read.** We store code identifiers, the published start/last-modified/stop dates and status for every code we read. Descriptions are short excerpts, and only for the codes the product routes on or shows in playbooks (about 50 CARCs and 25 RARCs). Every other description is `licensed_import_required`. 20 backlog codes carry the build pack's own labels, marked `build_pack_label_unverified`.
5. **Routing is a pure, shared function** (`shared/kb/routing.ts`, `routeScenario(group, carc, rarcs)`). A versioned table (`kb-routing/draft-1`) maps codes to scenarios, and every mapping is `draft_requires_business_signoff`. The function returns `specialist_review` when the group is unknown, no route exists, a generic CARC lacks its required RARC, the group does not fit the code, or several scenarios compete. `explainAdjustment` also forces review when a code is not in the loaded list or is deactivated or unverified. Superseded in part by ADR 0060: since `kb-routing/draft-2` the CARC rows derive from the rule-pack selection map and the KB adds only stricter guards.
6. **Search uses SQLite FTS5**, which node:sqlite 22 ships with (verified; reported by `/api/kb/sources`). A `kb_search` table with a LIKE fallback is kept and tested.
7. **`npm run kb:verify`** checks:
   - header provenance, hashes and counts
   - duplicate keys
   - code entries without a source, and article facts without a full citation
   - routing references to unknown or deactivated codes, routes to scenarios that have no playbook, and one CARC/group pair mapped to several scenarios
   - payers that are not synthetic, and phone numbers outside the fictional 555-01xx range

## How the data was obtained and checked

- Public pages were fetched on 2026-10-12. Long pages were read in two offsets, and the model extracted `CODE|START|LAST_MODIFIED|STOP` rows.
- Spot checks: 38 rows were fetched again with a different prompt and compared. All 37 that could be fully read matched (13 CARC, 9 RARC, 15 claim status). The 38th, claim status 360, sits at a truncation boundary and is stored as `unverified`.
- Anomalies in the source, such as a last-modified date after the stop date (CARC 38, claim status 253), are kept as published and reported as warnings by `kb:verify`.
- Coverage is partial and declared in each header. The fetch tool reads roughly 115 to 140 thousand characters of page text, so:
  - CARC stops at P7. The rest of the P series and the W and Y series are missing.
  - RARC stops at N138. Most of the N series is missing.
  - Claim status codes stop at 555.
  - Claim status categories are complete.
- Group codes come from the CMS Blue Button `ANSI_GRP_CD` code system and Medicare Claims Processing Manual Ch. 22 §60.1.
- The seven regulatory articles cite eCFR 42 CFR 424.44, the CMS appeals pages and FFS appeals flowchart, the CMS claim status page, Manual Ch. 24, the CMS No Surprises Act provider page and the CMS-0057-F fact sheet. Each fact has its own citation, and every article is `reviewStatus: "draft"`.

## Consequences and what remains blocked

- **Blocked, licensing:** full CARC/RARC/277 descriptions and usage notes. Production needs a licensed X12 code-list feed or file and an importer. Until then the UI says "Full text needs licensed X12 import".
- **Blocked, access:** the missing tails of the code lists. They need either the licensed feed or a fetcher that can read the full public page.
- **Needs business sign-off:** every routing mapping, playbook and article. Nothing here makes a rule executable.
- **Mocked:** the payer directory is synthetic only. Real payer channels, IVR trees and turnaround commitments need a contracted source per payer.
- Unknown codes are safe by construction: they route to specialist review.
