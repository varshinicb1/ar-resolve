# ADR 0095: Stress, load and resilience testing; can single-node SQLite carry a pilot?

Status: accepted for the synthetic environment. Date: 2026-10-14. Migration range 095-099 (`server/db/095_stress_indexes.sql`, indexes only).

## Context

Nothing so far measured how the server behaves under volume, concurrency, crashes or hostile input. A pilot customer could plausibly be a billing company with about 50,000 open accounts and 20 users. We need to know two things:

- whether the current single-node design (one Node process, `node:sqlite` in WAL mode, optional separate worker processes) carries that load;
- where it stops doing so.

All data is synthetic. No external service is called.

Every number in this ADR was measured on one machine and is reproduced in `docs/stress/RESULTS.md`, together with the command that produced it:

- 4 vCPU (Intel Xeon @ 2.80GHz)
- 16 GB RAM
- Node v22.22.0
- Linux

These are not production benchmarks.

## Decisions

### 1. A repeatable harness, not a one-off

`scripts/stress/` holds the harness.

- **What it runs.** It starts the real `server/main.ts` (and, where a scenario needs them, real `server/worker.ts` processes) against a temporary database. It drives the real HTTP API with Node built-ins only.
- **Two modes.**
  - `npm run stress:quick` is the CI-sized run, about 1.5 minutes.
  - `npm run stress` is the full run: 1k/10k/50k accounts, a 5-minute soak and a real 30-second lease wait.
- **Selecting scenarios.** `--only=a,b` runs a subset.
- **Outputs.** Each run writes `docs/stress/runs/<mode>.{json,md}` and exits non-zero on any failed check.
- **Probe.** A preload, `scripts/stress/lib/probe.ts`, samples memory and event-loop delay inside the process under test. It can also add synthetic latency around the simulated connectors' `submit()` so that a SIGKILL can land mid-dispatch.
- **Invariant checker.** `scripts/stress/lib/invariants.ts` reads the database after each scenario and checks that:
  - each action has exactly one decision;
  - nothing was resent blindly: a send is repeated only after the connector proved it never received it;
  - every send is bound to its approval;
  - the outbox agrees with what the connector actually received;
  - no dispatch is stuck;
  - nothing was dispatched after it was superseded;
  - no "blocked" event follows a dispatch;
  - the per-tenant audit hash chain is intact.

### 2. Synthetic data at volume

`scripts/synthetic-inventory.ts` extends the generator. Every identifier is plainly synthetic:

- account: `SYNS-<batch>-<n>`
- claim: `SYNS-C…`
- patient token: `PT-S…`

The same accounts can be emitted as an 835 through the existing builder.

### 3. Fixes for what the harness found

Each fix is surgical, has a regression test in `tests/stress-fixes.test.ts`, and is mutation-tested by `npm run stress:mutate` (13 mutations, all caught).

| # | Defect (how found) | Fix |
|---|---|---|
| 1 | Import cost grew with the size of the audit table: the audit-chain head lookup sorted `audit_events` per event. 5k accounts took 6.8 s over HTTP. | Migration 095 index `audit_tenant_seq`; a bounded prepared-statement cache in `db.ts`; pooled random bytes for `newId` |
| 2 | The queue list loaded and scored every account in JavaScript, with three queries per row. p50 was about 1.7 s at 5k accounts with 8 readers. | Rank, filter, count and page in SQL with the same priority formula; enrich only the page. The test proves SQL order equals `priorityOf` order. |
| 3 | 835 ingest at 10k accounts: 4,335 claims took 293.8 s (per-claim observation lookups were unindexed, plus an O(n²) reversal scan). | Indexes `observations_account`, `remittance_lines_account` and others; a set for reversed claims; the `corrected` computation is limited to reversal claims |
| 4 | An 835 with more than 500 service lines previewed fine, then failed ingest with a 400 (a hidden 500-line cap). | The 835 path passes `MAX_835_LINES` (50,000). The EDI size limit still bounds the file. |
| 5 | An oversized body reset the connection (ECONNRESET/EPIPE) instead of returning a readable error. | `refuseBody`: drain up to 128 MB, answer 413 `too_large` ("split the upload into smaller parts"), keep the socket usable |
| 6 | Malformed percent-encoding in a path (`/api/accounts/%E0%A4%A`) returned a 500. | `decodeParam` returns a 400 |
| 7 | **Outbox stale snapshot.** Two dispatchers (worker processes, or a worker plus an API tick) both read a row as 'pending'; the second claimed and overwrote a row the first had already sent. The harness saw an action received by the connector while the outbox said `blocked`, plus false `dispatch_blocked` events. | `stillIn()` re-reads the row inside the claim/recovery/reconcile transaction; a raced row is skipped |
| 8 | **Audit chain fork across processes.** `audit()` outside a transaction (setPause, export, recording access, ingest checks, key authentication) could append two events with the same `prev_hash` from two processes. | `audit()` appends inside `tx()` (BEGIN IMMEDIATE) |
| 9 | `/api/ops/outbox` re-walked the whole audit chain on every load (2.3 s at 50k accounts) and returned unbounded lists. | `verifyChainIncremental`: verify new rows on each load, with a full walk at least every 10 minutes; 500-row page limits |
| 10 | **Restart after a crash failed.** `openDb` ran `PRAGMA journal_mode` before setting `busy_timeout`, so a process starting while another held the lock (here, during recovery after a SIGKILL) died with "database is locked". | Set `busy_timeout` first |
| 11 | Unclamped `page`/`pageSize` and unbounded search text | Clamped; the query is truncated to 100 characters |

### 4. Verdict: can single-node SQLite carry the pilot?

**Yes, for a pilot of 50k open accounts and 20 users on the measured hardware**, with these measured limits and the operating rules below.

**Evidence: full run, 50k accounts**

- **Import.**
  - 50,000 accounts arrive in 7 chunks under 1 MB and take 12.1 s (4,115 rows/s).
  - The database is 143 MB plus a 38 MB WAL.
  - RSS peaks at 181 MB.
  - The slowest chunk blocks the event loop for 2.1 s.
- **Queue, search and detail with 16 concurrent readers** (no think time): p50 about 0.7 s and p95 about 1.4 s.
  - One queue page costs about 37 ms of CPU at 50k in process.
  - The single event loop therefore serves roughly 20-25 list requests per second.
  - 20 users each loading a page every few seconds generate a small fraction of that.
  - The 16-reader figure is a saturation test, not a user model.
- **835 remittance.**
  - A 4,335-claim 835 against the 50k book previews in 0.6 s and ingests in 6.5 s.
  - The ingest is one transaction, so it blocks other writes for that time.
- **Mixed soak.**
  - 5 minutes over 10k-43k accounts.
  - Readers, investigators, corrections and approvals, imports, EDI previews, call starts, ops page and ticks.
  - 91 requests/s (27,374 requests), no 5xx.
  - Heap at the end (15 MB) below the 25% mark (110 MB).
  - Event-loop max 497 ms.
- **Correctness under contention.**
  - Approval storms with three worker processes produced exactly one dispatch per approval.
  - Nine SIGKILLs mid-dispatch (eight workers and the API process) recovered by read-back with no duplicate send.
  - 15,000 cross-scope probes leaked nothing.

**Operating rules this verdict depends on**

- Large imports and 835 ingests run outside peak hours, or users accept a few seconds of stall.
- One API process. Workers may be separate processes on the same host and the same disk.
- The database lives on local disk, not a network filesystem.

### 5. When PostgreSQL (or another server database) becomes necessary: the reversal condition

Move off single-node SQLite when any one of these is measured in a pilot or a load test:

1. **Read saturation.** Sustained list/search demand approaches the ~20 requests/s ceiling measured at 50k accounts, or p95 for a single user's queue page exceeds 1 s in normal use. Page cost grew roughly linearly with the book in our measurements, but 150k accounts was not measured. Treat larger books as untested until they are run through `npm run stress`. A first mitigation inside SQLite is read replicas via worker threads; past that, a server database.
2. **Write stalls.** Single-writer blocking becomes user-visible: an import or 835 ingest blocks other writes for more than about 5 s. Measured: 6.5 s for a 4,335-claim 835 at 50k. A client whose daily 835s exceed about 4,000 claims reaches this now.
3. **More than one host.** Availability or deployment needs a second API node, rolling restarts without downtime, or point-in-time recovery beyond file backups. SQLite cannot be shared across hosts safely.
4. **Audit volume.** The full audit-chain walk (2.3 s at about 50k accounts' history) can no longer finish inside the 10-minute full-walk window without hurting latency, or audit export of a tenant takes more than tens of seconds.

## Costs

- Migration 095 adds 11 indexes. They cost write time on import (included in the measured 4,115 rows/s) and disk space (included in the 143 MB).
- Incremental chain verification means an out-of-band edit to an *old* audit row is reported only by the next full walk, up to 10 minutes later, not on the next page load. New tampering is still caught at once. `verifyChain` (full) is unchanged for audit export.
- The statement cache keeps up to 1,000 prepared statements per connection.
- The harness adds about 1.5 minutes to CI in quick mode. Full mode takes about 9 minutes and is not meant for every commit.

## Shared core files touched (small edits)

| File | Change |
|---|---|
| `server/http/app.ts` | Oversized-body refusal and drain (`refuseBody`); `decodeParam` returns a 400; 500-row limits and the incremental chain check on `/api/ops/outbox` |
| `server/services/workflow.ts` | `listAccounts` ranks and pages in SQL; page clamps |
| `server/services/outbox.ts` | `stillIn` re-check inside claim, recovery and reconcile transactions |
| `server/db/db.ts` | `busy_timeout` before `journal_mode`; prepared-statement cache |
| `server/services/audit.ts` | `audit()` in a transaction; `verifyChainIncremental` |
| `server/util.ts` | Pooled `newId` |
| `server/services/outcomes.ts`, `server/connectors/remit-835.ts`, `server/connectors/ingest.ts` | 835 line cap; O(n²) scans removed |
| `package.json` | `stress`, `stress:quick` and `stress:mutate` scripts |

No new routes, no new tables, no new runtime settings. The harness-only environment variables are listed in `.env.example`.

## Known gaps (stay blocked or open)

- **Outbox ticks are unbounded and synchronous.** A tick dispatches every pending row in one pass. With a slow *synchronous* connector, the embedded worker holds the API event loop for the whole batch: with 400 ms injected latency, the API stopped answering health checks while 16 rows dispatched. The simulated connectors are fast and live adapters are disabled, so this is not reachable today. A live connector must be asynchronous, or ticks bounded, before it ships.
- Audit export still does the full chain walk (2.3 s at 50k).
- Results come from one 4-vCPU machine with synthetic data and simulated connectors. Real payer latency, real 835 shapes and real user behaviour are not measured.
- Multi-node, PostgreSQL and backup/restore at volume were not tested.
