# ADR 0001: Phase 0 architecture

Status: accepted for Phase 0 (synthetic). Date: 2026-10-08.

## Context

The build pack (docs/06, docs/15) asks for a synthetic-data vertical slice with durable storage, server-enforced scope, one rule engine, hash-bound review, an outbox with a disabled live executor, receipt reconciliation and audit export. It recommends a TypeScript UI, a typed API, PostgreSQL and a durable workflow runtime such as Temporal, while warning against unnecessary infrastructure.

## Decision

1. **Modular monolith in TypeScript on Node 22.** Node runs `.ts` directly (type stripping), so the API and worker have no build step. Plain `node:http` with a small router; no framework.
2. **SQLite (`node:sqlite`) for Phase 0 persistence**, WAL mode, `BEGIN IMMEDIATE` transactions, composite tenant/client keys and triggers that make audit events, review decisions, evidence, fact versions and action payloads immutable. A developer can reproduce the whole journey with `npm install` and no credentials or services.
3. **Outbox pattern instead of Temporal.** Approval and the outbox row commit in one transaction. The worker claims rows with a conditional update and a lease, re-checks authority at dispatch, calls the connector outside any transaction, and turns timeouts and expired leases into `uncertain`, which only read-back reconciliation can clear.
4. **One rule engine** (`shared/rules/ded01.ts`) imported by API, worker and browser. Rule definitions are versioned data with a sha256; branch logic is a reviewed deterministic function named by `logicModule`. Rule text is never evaluated.
5. **Facts are resolved from observations.** Each source statement is an observation with a locator. Resolution yields verified, reported, missing or conflicting; disagreement is conflicting even when one source is newer; a reviewer correction is evidence with a reason and can be reopened by a later disagreeing source.
6. **Draft rules may run only because every environment is synthetic.** The verifier states this; an assisted-live environment must require an approved rule version.
7. **Development identity** is a named-user picker with server-side grants. No passwords, clearly labeled; replaced by SSO with MFA before any real data.
8. **React + Vite** for the workspace UI, tokens from design/tokens.json, no component library yet.

## Alternatives considered

- PostgreSQL now: closer to production but adds a service for every developer and demo. Rejected for Phase 0 only; the schema already mirrors specs/schema.sql composite keys.
- Temporal now: valuable for long waits and multi-step calls (Phase 2), but Phase 0 has no long-running external work. The outbox remains necessary with Temporal anyway, because durable replay does not make duplicate payer submissions harmless.
- An LLM extractor over transcripts: out of scope. Phase 0 transcripts are pre-scripted with structured extracts and are labeled mocked.

## What would change this decision

Move to PostgreSQL (with RLS as defense in depth) before Phase 1 shadow data, or as soon as more than one API process must write concurrently. Introduce Temporal (or equivalent) when real calls with holds, transfers and multi-day follow-ups arrive in Phase 2. Both moves keep the service boundaries in `server/services`.
