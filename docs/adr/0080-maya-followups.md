# ADR 0080: Follow-ups to the clinic-receptionist port (keys, retention, deletion, key rotation, sealed payloads, es/pt Guard, recording, value card, spoken read-back)

Status: accepted for the synthetic environment. Date: 2026-10-13. Migration range 080-089 (`server/db/080_maya_followups.sql`).

## Context

ADR 0070 ported the PHI gate, the Guard, Twilio telephony, notifications and SMART hardening from clinic-receptionist. It left several items open or marked "worth porting later":

- named API keys;
- the retention purge;
- sealing the note text inside the hash-bound proposal payload;
- `AR_PHI_KEY` rotation;
- English-only Guard rules;
- call recording;
- a value card.

This ADR closes them for the synthetic environment. Ported files name their origin in a header comment ("Ported from clinic-receptionist src/x.ts"). The origin repository was read, never modified.

Everything stays synthetic. Live integrations stay disabled. Every new period, price-like figure and assumption is a placeholder, labelled as one.

## Decisions

### 1. Named API keys (service accounts)

Files: `server/services/access.ts`, ported from `src/access.ts`. UI: `web/src/pages/Access.tsx` (supervisor).

- **What a key is.**
  - A key belongs to one tenant/client scope and acts as its own principal, `svc:<keyId>`.
  - The token has the form `ark_<random>`, is shown once, and only its SHA-256 is stored.
  - A key expires after 1-365 days (default 90).
- **Roles.**
  - A key's roles must be roles its creator holds in that scope.
  - Its effective roles are re-checked on every request: key roles ∩ the creator's current roles. A creator who loses a role takes it away from their keys too.
  - A key with no effective roles is refused with 403 `key_without_roles`.
- **Human-only permissions.** `HUMAN_ONLY` in `auth.ts` lists permissions that a key never holds, whatever its roles:
  - review/approve and write-back approval;
  - rule authoring and approval;
  - integration admin;
  - key management;
  - retention;
  - deletion request and approval;
  - PHI key management;
  - recording policy.
  Approvals therefore stay bound to a named person. A key is also never a reviewer: it has no grants rows.
- **Revocation and the table.** Revocation is final. Identity columns cannot change, and rows cannot be deleted (triggers).
- **Audit.** Every key request is audited (`api_key_request`), with `last_used_at` and `use_count` updated. Revoked or expired keys are refused with 401 and audited (`api_key_refused`).

### 2. Retention purge and two-person account deletion

File: `server/services/retention.ts`, ported from `src/governance.ts` `purgeExpired` and `deletePatientData`.

- **Placeholder policy.** The policy is versioned data per client (`retention_policies`, immutable). Every class defaults to a **placeholder** period, labelled "Placeholder pending customer contract/counsel. Not a legal requirement":

  | Class | Default days |
  |---|---|
  | transcripts | 90 |
  | call_events | 90 |
  | evidence_raw | 365 |
  | notifications | 30 |
  | sessions | 7 |
  | recordings | 30 |

  Sessions are deployment-wide; the shortest period of any client applies.
- **Purge.** The purge (dry run by default from the API) replaces content with a tombstone, `tombstone:v1:<reason>:<plaintext|stored>:<sha256>:<at>`, which keeps the SHA-256 of what was removed.
  - It is batched and audited (`retention_purge_run`, or `retention_purge_previewed` for a dry run), and records a `retention_runs` row.
  - It runs from the worker hourly (`AR_RETENTION_INTERVAL_MS`).
  - Rows, hashes, observations, the audit chain and the outcome ledger are kept.
- **Deletion.** A supervisor requests deletion of an account with a reason. A **different** person (supervisor or reviewer) approves or rejects it. A database CHECK enforces `decided_by <> requested_by`, and there is one open request per account.
  - **Approval** is refused while an action is in flight or a call is active. Otherwise it cancels open proposals and tombstones:
    - evidence content;
    - call event text and answer values;
    - hand-off packets;
    - write-back texts;
    - proposal note text and summary;
    - review rationale;
    - work item summaries;
    - notification payloads (sink copies deleted);
    - recordings.
  - It also replaces the patient token with `PT-DELETED` and sets `accounts.deleted_at`.
  - A deleted account refuses new evidence (and so new investigations) and new calls (409 `account_deleted`); its open proposals were cancelled at approval.
  - The request stores a summary with counts, a digest of every tombstone and the list of what was kept.

**Decision: immutability holds through permits, not exceptions.** The existing no-update triggers on evidence, call events, write-backs, decisions, proposal payloads and raw EDI files were re-created so that one kind of UPDATE is allowed: one column, from an exact old value to an exact new value, and only when a matching row is in `immutable_rewrite_permits`.

- The permit is inserted, used and deleted inside one transaction (`sealed-store.ts` `rewrite`).
- There are two purposes:
  - `reseal`: same plaintext, new key;
  - `tombstone`: one way.
- A tombstone can never be rewritten.
- Hash columns, revisions and kinds stay fixed.
- `audit_events`, `outcome_ledger` and `analytics_events` are untouched: they stay strictly append-only.
- **Cost.** These tables are no longer "never changes". They are "changes only in these two audited ways". An operator with raw database access could still insert a permit, as they could always drop a trigger. The audit chain records every legitimate rewrite.

**Approvals after redaction.** `GET /api/governance/actions/:id/binding` shows, per decision, that it is still bound to the recorded payload hash and account revision.

- Redacted fields are listed with their tombstone hash.
- `contentMatches` is null when content was redacted. It is not claimed true.

### 3. PHI key rotation

Files: `server/services/phi.ts`, `server/services/phi-keys.ts`.

- **Keyring.** `AR_PHI_KEYS="id:base64,…"` plus `AR_PHI_ACTIVE_KEY_ID` define the keyring. `AR_PHI_KEY` remains as the key id `legacy`.
- **Blob formats.** New blobs are `enc:v2:<kid>:iv:ct`, with the key id bound as AES-GCM additional data, so relabelling a blob fails. Old `enc:v1` blobs open with `legacy`.
- **Re-encryption job** (`phi_rekey_jobs`, one running job per client):
  - walks every sealed column in rowid batches with a stored cursor, so it is resumable;
  - verifies each reseal;
  - is audited;
  - is driven by the worker every tick, or run from the API.
- **Retirement.** Retiring a key is refused while any sealed value in **any** client still names it (409 `key_in_use`, with usage, audited). The active key cannot be retired.

### 4. Sealed note text inside hash-bound payloads

`request.summary` and `note.text` inside `proposed_actions.payload`, and `note_draft`, are sealed at rest. The payload hash stays over the canonical **plaintext**, so review, execution, write-back and the integrity check behave as before.

- `openPayload` is used at every read site.
- Tests prove two things:
  - an approval still binds;
  - a tampered sealed payload (trigger dropped in the test) fails the integrity check and blocks execution.

### 5. Guard in Spanish and Portuguese

`server/services/guard.ts`, `GUARD_VERSION` `guard.v2`.

- es/pt rules were added across injection, agency, memory, identity, credential, payment-redirect and output checks. They match on accent- and case-folded text.
- **What was ported versus authored.** The folding approach and the crisis wording come from the origin. The origin had **no** es/pt injection rules, so those rules are AR-authored and labelled as such.
- Spoken digits and dates are converted back to digits before the identifier and figure checks, so a read-back in words is still checked.

### 6. Call recording

Files: `server/services/recording.ts`, ported from `src/recording.ts`.

- **Off by default.** Recording happens only when every check holds:
  1. the deployment flag `AR_RECORDING=on`;
  2. the client policy is enabled;
  3. a consent mode (`one_party` or `all_party`) was **configured by a person**, with a source. It is never inferred;
  4. a counsel review is recorded with a reference;
  5. a disclosure line is set;
  6. the PHI gate passes. It passes for the simulated engine only; any other adapter needs the full PHI gate.
- **When recorded.** The call plan carries the disclosure line, the opening speaks it, and recording starts at that turn.
- **What is stored.** Only simulated metadata: a sealed storage reference, the policy version and hash, the consent mode and the disclosure turn. No audio exists. Recordings are under the `recordings` retention class.
- **Access.** Access is limited to supervisor, reviewer and auditor, and is audited (`recording_accessed`).

### 7. Value / operations card

Files: `server/services/value.ts`, ported from `src/value.ts`; the card is on Insights.

- Every figure says whether it is **measured** (counts from activity tables) or an **estimate**, and states its basis.
- Estimates are arithmetic on stated placeholder assumptions (20 minutes per manual call, 3 per review decision, 10 per hand-off). The assumptions can be overridden by query or environment.
- No figure is a productivity, accuracy or recovery result.

### 8. Spoken read-back

File: `server/services/voice/spoken.ts`.

- **What the agent says.** Dollars, dates and references are spoken in words:
  - "$425.00" → "four hundred twenty-five dollars and zero cents";
  - "RQ-88" → "R, Q, dash, eight, eight".
- **Ported versus built.** The origin had word tables and `spokenDatesToDigits` (ported) but no number-to-words. The forward direction was built here from those tables.

## Shared core files touched (small edits)

| File | Change |
|---|---|
| `auth.ts` | Permissions; `HUMAN_ONLY`; `serviceKeyId` |
| `http/app.ts` | Key authentication and key scope |
| `modules.ts` | One line |
| `phi.ts` | Keyring |
| `guard.ts` | es/pt rules |
| `voice/engine.ts`, `voice/plan.ts` | Read-back words; recording hooks |
| `workflow.ts`, `writeback.ts`, `review.ts`, `outbox.ts`, `holds.ts`, `outcomes.ts`, `views.ts`, `connectors/sim-pm.ts`, `routes/operations.ts` | `sealPayload` / `openPayload` |
| `evidence.ts`, `followup.ts` | Sealed reads; deleted-account refusal |
| `governance.ts` | Readiness wording |
| `worker.ts`, `main.ts` | Governance tick |
| `App.tsx`, `Insights.tsx` | Nav and value card |

## Known gaps

- **Audit details** keep reviewer rationale text and other free text written into audit events. The audit chain is append-only and is not tombstoned.
- **Facts and observations** (structured values) are kept on deletion. The simulated PM keeps its own copy of notes; a real deployment must route a deletion to the system of record.
- **Work item summaries** are stored unsealed at creation. Deletion tombstones them; retention does not.
- **Retention periods** are placeholders. Real periods come from the customer contract and counsel (`docs/compliance/policies/data-retention.md`).
- **Recording** is simulated metadata only. Real recording needs a telephony account, a BAA, counsel review of consent law per jurisdiction, and storage. It is Blocked.
- **The es/pt Guard rules** are not reviewed by a native speaker or by counsel. They are a floor, not coverage.
- **Value-card assumptions** are placeholders until replaced by customer time studies.
