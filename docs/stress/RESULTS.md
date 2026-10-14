# Stress, load and resilience results (ADR 0095)

Every number in this file was measured. Nothing is estimated. All data is synthetic, and every connector is a simulator.

## Machine

- 4 vCPU (Intel Xeon Processor @ 2.80GHz)
- 16,093 MB RAM
- Node v22.22.0
- Linux 6.18.44
- One shared container. Timings vary by a few tens of percent between runs.

## Commands

| What | Command | Raw output |
|---|---|---|
| Full run (all scenarios; 1k/10k/50k; 5-minute soak; real 30 s lease wait) | `npm run stress` | `runs/full.json`, `runs/full.md` |
| Soak re-run after the harness fix below (the soak in the full run hit that client-side reset; its other checks passed) | `npm run stress -- --only=soak` | `runs/full-soak.json`, `runs/full-soak.md` |
| CI-sized run (about 1.5 minutes) | `npm run stress:quick` | `runs/quick.json`, `runs/quick.md` |
| Mutation check of every fix | `npm run stress:mutate` | console |

Each scenario starts the real `server/main.ts`, and where needed real `server/worker.ts` processes, against a fresh temporary SQLite database. It drives the HTTP API with Node built-ins.

## Headline numbers (full run, after the fixes)

| Measure | 1k accounts | 10k accounts | 50k accounts |
|---|---|---|---|
| Import, chunked under the 1 MB body limit | 0.2 s (1 part) | 2.2 s, 4,512 rows/s (2 parts) | 12.1 s, 4,115 rows/s (7 parts) |
| Slowest import part (blocks the event loop) | 240 ms | 1,630 ms | 2,127 ms |
| Database file + WAL after import | 4.8 + 5.3 MB | 30.1 + 24.6 MB | 143.2 + 38.1 MB |
| Server RSS peak during import | 124 MB | 147 MB | 181 MB |
| Queue first page, 16 concurrent readers, p50 / p95 / p99 | 28 / 50 / 83 ms | 159 / 260 / 365 ms | 733 / 1,417 / 1,944 ms |
| Exact search, 16 readers, p50 / p95 | 26 / 48 ms | 156 / 288 ms | 718 / 1,496 ms |
| Account detail, 16 readers, p50 / p95 | 25 / 51 ms | 146 / 295 ms | 693 / 1,141 ms |
| Reads completed in the window (16 readers, no think time) | 2,000 in < 15 s | 2,000 | 880 in 45 s |
| 835 remittance, preview / ingest | 1,000 claims: 102 ms / 904 ms | 4,335 claims: 519 ms / 4,488 ms | 4,335 claims: 578 ms / 6,451 ms |
| `/api/ops/outbox`, first load (full audit-chain walk) / later loads | 31 / 1 ms | 395 / 1.7 ms | 2,374 / 1.6 ms |

How to read the 16-reader rows: they measure saturation, not users. Every reader fires its next request the moment the last returns. At 50k accounts one queue page costs about 37 ms of CPU (measured in process, single caller), and the server has one event loop. Sixteen requests in flight therefore queue behind each other, which is why detail reads take as long as list reads.

The 50k throughput was 880 reads in 45 s, about 20 reads/s. That is the measured ceiling for this read mix at that size.

### Correctness under load (full run)

| Scenario | Result |
|---|---|
| Investigations | 1,000 accounts at concurrency 16: p50 32 ms, p95 65 ms. 40 concurrent investigations of one account: all 200. 30 corrections on the same revision: exactly 1 accepted, 29 refused with 409 |
| Approval storm | 3 worker processes plus 40 API ticks. 20 actions × 17 conflicting requests each (valid, double-submit, stale revision, wrong hash, reject, wrong role) = 340 requests: 20 × 200, 20 × 403, 300 × 409. Exactly one approval and one dispatch per action. Invariants hold; no SQLITE_BUSY in any worker log |
| Webhook replay | 6 replays of the same event id per action: exactly one applied |
| Approve while the account changes | 30 rounds of approve + correct + tick at once: no dispatch of a superseded proposal |
| Crash | 8 worker SIGKILLs and 1 API-process SIGKILL, each while a dispatch was in flight (3 already sent, 6 not yet sent), then a 31 s real lease wait and a restart. All 3 sent requests were found by read-back with no resubmit; all 6 unsent ones were proven absent and sent once more. All 20 rows ended accepted or confirmed |
| Voice | 105 start-call requests in a storm. Observed concurrency 2 against a limit of 2; 4 calls per tenant-hour against a limit of 6. Duplicate keyed starts created one call |
| Isolation | 15,000 requests at concurrency 32 across 14 cross-tenant, cross-client, auditor-grant and no-token probe kinds. 0 leaks; every probe got the expected 401, 403 or 404 (a cross-tenant search returns an empty list). p50 12.5 ms, p95 23 ms |
| Hostile input | 3,182 requests: oversized declared and chunked bodies up to 95 MB (413 in ≤ 17 ms, connection kept); JSON nested 400,000 deep; malformed bodies, queries and paths; 1,000 fuzzed CSVs; 2,000 fuzzed X12 previews and 60 ingests. 0 × 5xx, 0 stack traces; health answered in 1 ms afterwards. Slowest request 161 ms |
| Soak (5 min, `runs/full-soak.*`) | 302 s of mixed load: 8 readers, investigators, a correct/approve loop, 200-row imports every 1.5 s, EDI previews, call starts, ops page and ticks. Embedded worker every 250 ms. The book grew from 10k to 43,435 accounts.<br>27,374 requests (91/s): 26,786 × 200, 587 × 422 (call-policy refusals), 1 × 409, 0 × 5xx, 0 transport errors.<br>p50/p95: queue 117/266 ms, search 119/272 ms, detail 103/237 ms, investigate 122/287 ms, approve 129/300 ms, import 286/463 ms.<br>312 approvals, each dispatched once; invariants hold over 96,076 audit events.<br>Server RSS 158 → 172 MB (peak 265 MB). Heap at the 25% mark 109.7 MB, at the end 15.1 MB. Event-loop max 497 ms. DB 155.6 MB + 24.6 MB WAL |

## Before and after the fixes

These "before" figures were measured on the base commit, or with the fix removed, during this workstream. They come from the first harness runs and in-process micro-benchmarks, as stated in each row.

| What | Before | After | How measured |
|---|---|---|---|
| Import of 5k accounts over HTTP | 6.8 s (734 rows/s) | 50k in 12.1 s (4,115 rows/s) | quick run on base code vs full run |
| Queue list, 5k accounts, 8 readers | p50 about 1.7 s | 10k with 16 readers: p50 159 ms | quick run on base code vs full run |
| Queue list, 20k accounts, one caller | 462 ms | 19-25 ms | in process |
| Queue list, 50k accounts, one caller | 54 ms (first SQL version) | 37 ms | in process |
| 835 ingest, 4,335 claims at 10k accounts | 293.8 s | 4.5 s | HTTP, full scale scenario |
| 835, 1,000 claims, one caller | 4.8 s | 0.94 s | in process |
| 835, 4,000 claims, preview / ingest | 1,244 ms / 10.9 s | 160 ms / 4.4 s | in process |
| 835 with more than 500 service lines | preview 200, ingest **400** | ingest 200 | regression test |
| `/api/ops/outbox` at 50k | 2,288 ms on every load | first load 2.4 s, then about 2 ms | HTTP |
| Oversized body | ECONNRESET / EPIPE | 413 with a message, socket reusable | regression test |
| `%E0%A4%A` in a path | 500 | 400 | regression test |
| Two dispatchers on one outbox row | connector received the action while the outbox said `blocked`; false `dispatch_blocked` events | exactly one claim; raced rows skipped | approvals scenario + regression test |
| `audit()` from two processes | chain fork (two events with the same `prev_hash`) | intact (3,000 events, 2 processes) | regression test |
| Server start while another process holds the lock (after a SIGKILL) | exit with "database is locked" | waits (busy_timeout) | crash scenario + regression test |

## Harness findings that were not server bugs

- **Health check reset after the soak** (`ECONNRESET` in 7 ms; the server was alive and answering). The harness reused a keep-alive socket at the instant the server's idle timeout closed it. It happened because a synchronous step in the harness (the invariant check) held the client's event loop past the server's 5 s keep-alive timeout. The client agent now drops idle sockets after 4 s, and retries a GET (never a write) when a *reused* socket resets before any response.
- **Crash scenario flakiness.** An embedded worker tick with 400 ms of injected connector latency held the API event loop until all 16 pending rows had been sent, so the harness could not reach the health check in time to kill mid-dispatch. The harness now polls the database instead of waiting for health. The underlying behaviour is recorded as a known gap in ADR 0095: outbox ticks are unbounded and synchronous.

## Not measured

- Real payer or clearinghouse latency.
- Real 835 files.
- Real user think time.
- Books above 50k accounts.
- More than one API process.
- PostgreSQL.
- Backup and restore at volume.
- Machines other than the one above.
