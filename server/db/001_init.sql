-- Phase 0 schema (SQLite). Composite tenant/client keys everywhere so a row can
-- never be joined across scope. Mirrors specs/schema.sql; see ADR 0001 for the
-- planned PostgreSQL move.
PRAGMA foreign_keys = ON;

CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE clients (
  tenant_id TEXT NOT NULL REFERENCES tenants, client_id TEXT NOT NULL, name TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id)
);
CREATE TABLE users (user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
CREATE TABLE grants (
  user_id TEXT NOT NULL REFERENCES users, tenant_id TEXT NOT NULL, client_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('specialist','reviewer','supervisor','auditor')),
  PRIMARY KEY (user_id, tenant_id, client_id, role),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);
CREATE TABLE sessions (
  token_sha256 TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);

CREATE TABLE import_batches (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, batch_id TEXT NOT NULL,
  source_name TEXT NOT NULL, source_sha256 TEXT NOT NULL, accepted INTEGER NOT NULL,
  rejected INTEGER NOT NULL, duplicates INTEGER NOT NULL, report TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, batch_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);

CREATE TABLE accounts (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, account_id TEXT NOT NULL,
  external_id TEXT NOT NULL, payer_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  patient_token TEXT NOT NULL, service_date TEXT NOT NULL, claim_reference TEXT NOT NULL,
  claim_type TEXT NOT NULL, balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD', scenario TEXT NOT NULL,
  state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  batch_id TEXT NOT NULL, source_row_sha256 TEXT NOT NULL,
  followup_due TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, account_id),
  UNIQUE (tenant_id, client_id, external_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);

CREATE TABLE evidence (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, account_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, content TEXT NOT NULL,
  sha256 TEXT NOT NULL, observed_at TEXT NOT NULL, effective_at TEXT, created_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, evidence_id),
  UNIQUE (tenant_id, client_id, account_id, evidence_id),
  FOREIGN KEY (tenant_id, client_id, account_id) REFERENCES accounts (tenant_id, client_id, account_id)
);

-- One statement by one source about one fact.
CREATE TABLE observations (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, account_id TEXT NOT NULL, observation_id TEXT NOT NULL,
  fact_key TEXT NOT NULL, value TEXT NOT NULL, unit TEXT, evidence_id TEXT NOT NULL, locator TEXT NOT NULL,
  source_class TEXT NOT NULL CHECK (source_class IN ('document','structured','transcript','reviewer')),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, observation_id),
  FOREIGN KEY (tenant_id, client_id, account_id, evidence_id) REFERENCES evidence (tenant_id, client_id, account_id, evidence_id)
);

-- Resolved fact versions. A new version is written only when the resolution changes.
CREATE TABLE facts (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, account_id TEXT NOT NULL,
  fact_key TEXT NOT NULL, version INTEGER NOT NULL, value TEXT, unit TEXT,
  status TEXT NOT NULL CHECK (status IN ('verified','reported','inferred','missing','conflicting','stale')),
  evidence_id TEXT, locator TEXT, candidates TEXT NOT NULL DEFAULT '[]',
  account_revision INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, account_id, fact_key, version),
  FOREIGN KEY (tenant_id, client_id, account_id) REFERENCES accounts (tenant_id, client_id, account_id),
  CHECK (status NOT IN ('verified','reported') OR evidence_id IS NOT NULL)
);

CREATE TABLE rule_versions (
  rule_id TEXT NOT NULL, version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft','approved','retired')),
  definition TEXT NOT NULL, sha256 TEXT NOT NULL, approved_by TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (rule_id, version), CHECK (state <> 'approved' OR approved_by IS NOT NULL)
);

CREATE TABLE interactions (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, account_id TEXT NOT NULL, interaction_id TEXT NOT NULL,
  channel TEXT NOT NULL, destination TEXT NOT NULL, state TEXT NOT NULL, transitions TEXT NOT NULL,
  transcript_evidence_id TEXT, call_reference TEXT, mocked INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, interaction_id),
  FOREIGN KEY (tenant_id, client_id, account_id) REFERENCES accounts (tenant_id, client_id, account_id)
);

CREATE TABLE workflow_runs (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, account_id TEXT NOT NULL, run_id TEXT NOT NULL,
  account_revision INTEGER NOT NULL, rule_id TEXT NOT NULL, rule_version INTEGER NOT NULL, rule_sha256 TEXT NOT NULL,
  state TEXT NOT NULL, result TEXT NOT NULL, inputs TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, run_id),
  UNIQUE (tenant_id, client_id, account_id, run_id),
  FOREIGN KEY (tenant_id, client_id, account_id) REFERENCES accounts (tenant_id, client_id, account_id),
  FOREIGN KEY (rule_id, rule_version) REFERENCES rule_versions (rule_id, version)
);

CREATE TABLE proposed_actions (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, action_id TEXT NOT NULL,
  account_id TEXT NOT NULL, run_id TEXT NOT NULL, expected_revision INTEGER NOT NULL,
  kind TEXT NOT NULL, risk_class TEXT NOT NULL, connector TEXT NOT NULL,
  payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL, note_draft TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting_review','approved','rejected','needs_evidence','superseded','expired','cancelled','stale_blocked','dispatching','uncertain','accepted','confirmed')),
  expires_at TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, action_id),
  FOREIGN KEY (tenant_id, client_id, account_id, run_id) REFERENCES workflow_runs (tenant_id, client_id, account_id, run_id)
);

CREATE TABLE review_decisions (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, decision_id TEXT NOT NULL, action_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','needs_evidence')),
  actor_id TEXT NOT NULL, rationale TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  account_revision INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, decision_id),
  FOREIGN KEY (tenant_id, client_id, action_id) REFERENCES proposed_actions (tenant_id, client_id, action_id)
);

CREATE TABLE action_outbox (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, action_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, connector TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','dispatching','uncertain','accepted','confirmed','blocked','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, last_error TEXT,
  external_reference TEXT, receipt_evidence_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, action_id),
  UNIQUE (idempotency_key),
  FOREIGN KEY (tenant_id, client_id, action_id) REFERENCES proposed_actions (tenant_id, client_id, action_id)
);

CREATE TABLE receipt_events (
  event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, action_id TEXT NOT NULL,
  external_reference TEXT NOT NULL, status TEXT NOT NULL, received_at TEXT NOT NULL
);

CREATE TABLE work_items (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, work_item_id TEXT NOT NULL, account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, summary TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, work_item_id)
);

CREATE TABLE controls (
  scope_key TEXT PRIMARY KEY, paused INTEGER NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- Stands in for the payer's own system. It survives restarts and dedupes by
-- idempotency key exactly as a well-behaved external API would.
CREATE TABLE sim_payer_requests (
  idempotency_key TEXT PRIMARY KEY, external_reference TEXT NOT NULL UNIQUE, payload_sha256 TEXT NOT NULL,
  kind TEXT NOT NULL, received_at TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE sim_faults (fault TEXT PRIMARY KEY, remaining INTEGER NOT NULL);

CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, client_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT NOT NULL,
  account_id TEXT, event_type TEXT NOT NULL, event_at TEXT NOT NULL, details TEXT NOT NULL,
  prev_hash TEXT NOT NULL, event_hash TEXT NOT NULL
);
CREATE INDEX audit_account ON audit_events (tenant_id, client_id, account_id, seq);

-- Append-only and immutable records.
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON review_decisions BEGIN SELECT RAISE(ABORT, 'review_decisions are immutable'); END;
CREATE TRIGGER decisions_no_delete BEFORE DELETE ON review_decisions BEGIN SELECT RAISE(ABORT, 'review_decisions are immutable'); END;
CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;
CREATE TRIGGER facts_no_update BEFORE UPDATE ON facts BEGIN SELECT RAISE(ABORT, 'fact versions are immutable'); END;
CREATE TRIGGER payload_immutable BEFORE UPDATE OF payload, payload_sha256, expected_revision, kind ON proposed_actions
  BEGIN SELECT RAISE(ABORT, 'proposed action payload is immutable'); END;
CREATE TRIGGER rule_def_immutable BEFORE UPDATE OF definition, sha256 ON rule_versions
  BEGIN SELECT RAISE(ABORT, 'rule version definitions are immutable'); END;
