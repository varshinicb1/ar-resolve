# ADR 0020: Scenario rule packs, FR05 selection and the rule studio lifecycle

Status: accepted for Phase 0 (synthetic). Date: 2026-10-12. Supersedes ADR 0001 decision 4 ("one rule engine") in scope only. DED01 is unchanged: same definition, sha256 `173dec81…6d045`, same 40 fixtures and same tests.

## Context

Phase 0 shipped a single deductible rule (DED01) and a read-only rule studio. FR05 asks for scenario selection and FR06 asks for versioned rules with an approval workflow. The scenario backlog lists pending, documentation, duplicate, COB, timely filing, authorization, medical necessity and bundling scenarios. Real payer policy for those scenarios is not available to us, so only scenarios whose next step is evidence-gathering or a payer question can be executable. The rest must abstain and route to a specialist.

## Decision

1. **Registry of logic modules** (`shared/rules/registry.ts`). A pack is versioned definition data (`RuleDefinition`, hashed into `rule_versions`) plus a reviewed deterministic `LogicModule` named by `definition.logicModule`. Rule text is never evaluated. The same modules run in the API, the worker, the browser fixture runner and `scripts/evaluate.ts`.
2. **Packs.**
   - Executable: DED01, PEND01, DOC01 and DUP01.
   - Specialist routes, which abstain and return an evidence checklist: COB01, TF01, AUTH01, MN01 and BUN01.
   - Router: ROUTE00, which always abstains with the selection reasons.
   - All packs are `draft`, with labels `synthetic_proposed_not_customer_approved`.
3. **FR05 selection** (`shared/rules/select.ts`) is a pure function over a versioned mapping table, `SCENARIO_MAP_V1`. It uses no free text and does not depend on `shared/kb/routing.ts`. Selection works in this order:
   1. Verified EOB line adjustments and remark codes, by CARC. An unmapped code is ignored when another code maps.
   2. Payer claim status.
   3. The inventory scenario hint.
   - More than one pack matching gives `ambiguous`. No match gives `unknown`. Conflicting signals give `conflict`. Each of these sends the account to ROUTE00 (specialist review) with reasons.
   - The CARC rows cite the X12 CARC list, retrieved 2026-10-12.
   - The RARC table is empty because no RARC source was verified this session.
4. **Version resolution** (`server/services/scenario.ts`) per (tenant, client), in this order:
   1. The version pinned by an in-flight action (states awaiting_review, approved, dispatching, uncertain or accepted). A run keeps the version it started with.
   2. The latest activation whose `active_from` has passed.
   3. Only while `draftsMayRun()` is true, the synthetic draft baseline. This holds only in the `synthetic` environment, and the check is explicit and tested. Any other environment requires an activated, approved version.
   - A retired version is not runnable: the account routes to ROUTE00 with `not_runnable`, and approval checks fail.
5. **Lifecycle** (migration `020_rule_studio.sql`, service `rule-studio.ts`).
   - Flow: draft → validate → submit → review → publish (activation time) → retire.
   - Drafts are working copies. Only the data fields in `EDITABLE_FIELDS` can be edited; logic, actions and identity are code.
   - Validation runs the `rule.schema.json` projection, module compatibility and every fixture of the pack. A successful validation freezes the draft into a new immutable `rule_versions` row.
   - Review requires `rule_approver` and a reviewer different from the author and the submitter. This is enforced in code and by a DB CHECK.
   - Review and publish re-validate before they proceed.
   - Publish may not be backdated more than 5 minutes.
   - Rollback is a new `rollback` activation of an earlier approved, previously activated, compatible version.
   - Retirement is final.
   - Activations and retirements are append-only (triggers).
   - Every transition is audited (`rule_version` and `rule_draft` object types).
   - Editing uses optimistic concurrency (`expectedEditSeq`, 409 when stale).
6. **Facts.**
   - New fact keys live in `shared/rules/fact-catalog.ts` and are sparse: a row exists only once a source has observed the key, so DED01 accounts keep their Phase 0 fact set.
   - A required fact may be `optional`, and optional facts never block the approval `facts` check.
   - Transcript and letter text is a value at a fixed path and is never treated as an instruction. The adversarial fixtures cover injection.
7. **Permissions.**
   - `rule_author` is granted to reviewer and supervisor.
   - `rule_approve` is granted to `rule_approver`. Because the core grants CHECK constraint is fixed, this role lives in `extra_role_grants`. It is seeded for u_sam and u_lee on cl_ortho, cl_derm and cl_multi.

## Interfaces for other workstreams

| Need | Use |
| --- | --- |
| Add a pack | Implement `LogicModule` (`shared/rules/types.ts`), add it to `MODULES`, add `evaluation/<pack>-fixtures.json` with positive/negative/ambiguous/adversarial cases, and add a map entry in a new `SCENARIO_MAP` version |
| Label an outcome or reason | `outcomeLabel(kind, ruleId?)` and `reasonText(code, ruleId?)` from the registry; never import `ded01.ts` labels directly |
| Which pack/version runs for an account | `selectForAccount(db, scope, account, facts)`. Returns `{rule, selection, resolution, map}` |
| Is a version approvable/dispatchable | `ruleRunnableForApproval(db, scope, ruleId, version)` |
| Account view | `accountView().scenario = {current, lastRun, pack}` |
| Run inputs | `rule_runs.inputs` now also records `selection`, `resolution` and `scenarioMap` (id, version, sha256) |
| New fact keys | Add to `EXTENDED_FACTS` and `EXTENDED_EXTRACTORS`; corrections are validated against the declared type |
| Evaluate | `scripts/evaluate.ts` reports every pack, selection fixtures and the 3-client cohort at the cohort's `evaluationClock` |

## Known limitations

- `rule_versions.version` numbers are allocated per rule_id across all tenants, because the core table has no scope column. Gaps in a client's version list can reveal that another tenant has versions, but they reveal no content. A scoped key is the fix when moving to PostgreSQL.
- The mapping table itself is code-versioned and is not edited in the studio.
- The impact view on current accounts re-evaluates their current facts. It does not replay historical runs.
- Pack parameters (for example `statusMaxAgeDays`) are synthetic defaults, not payer policy.

## Blocked on the real world

- Customer sign-off of each pack and of the CARC-to-pack mapping.
- A verified RARC source.
- Payer-specific timely-filing, authorization, medical-necessity and bundling policy.
- Shadow-mode accuracy on labeled real cases (Gate B).
- Until these exist, specialist packs stay abstain-only and every pack stays `draft`.
