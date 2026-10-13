-- ADR 0080: follow-ups to the clinic-receptionist port (ADR 0070). Named API keys, retention
-- purge and account deletion with tombstones, PHI key rotation, sealed proposal free text,
-- call recording (disabled by default, simulated only).

-- ---------------------------------------------------------------- named API keys (service accounts)
-- Only the SHA-256 of the key is stored. A key is bound to one tenant/client and carries a subset of
-- its creator's roles there; at use time its roles are intersected with the creator's current grants.
CREATE TABLE api_keys (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, key_id TEXT NOT NULL, name TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL, roles TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT,
  revoked_at TEXT, revoked_by TEXT, revoke_reason TEXT,
  last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, client_id, key_id),
  UNIQUE (key_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id),
  CHECK (revoked_at IS NULL OR (revoked_by IS NOT NULL AND revoke_reason IS NOT NULL))
);
-- Identity, scope, roles and the hash never change; a revocation is final.
CREATE TRIGGER api_keys_identity_immutable BEFORE UPDATE OF tenant_id, client_id, key_id, name, token_sha256, token_prefix, roles, created_by, created_at, expires_at ON api_keys
  BEGIN SELECT RAISE(ABORT, 'api key identity is immutable'); END;
CREATE TRIGGER api_keys_revocation_final BEFORE UPDATE OF revoked_at, revoked_by, revoke_reason ON api_keys WHEN OLD.revoked_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'api key revocation is final'); END;
CREATE TRIGGER api_keys_no_delete BEFORE DELETE ON api_keys BEGIN SELECT RAISE(ABORT, 'api keys are revoked, never deleted'); END;

-- ---------------------------------------------------------------- one-way rewrites of immutable rows
-- The immutability triggers below allow exactly two kinds of change to an otherwise immutable row,
-- and only while the application holds a permit for that exact row, column, old value and new value
-- inside the same transaction (sealed-store.ts inserts the permit, updates, deletes the permit):
--   reseal     the same plaintext re-encrypted under the active PHI key (checked by the caller);
--   tombstone  the value replaced by "tombstone:v1:..." carrying the SHA-256 of what was removed.
-- Every other column must stay identical, and a tombstone can never be rewritten again.
-- audit_events, outcome_ledger and analytics_events keep their original triggers untouched.
CREATE TABLE immutable_rewrite_permits (
  permit_id TEXT PRIMARY KEY, table_name TEXT NOT NULL, column_name TEXT NOT NULL, row_key TEXT NOT NULL,
  old_value TEXT, new_value TEXT, purpose TEXT NOT NULL CHECK (purpose IN ('reseal', 'tombstone')),
  created_at TEXT NOT NULL,
  CHECK (purpose <> 'tombstone' OR new_value LIKE '%tombstone:v1:%'),
  CHECK (purpose <> 'reseal' OR new_value LIKE '%enc:v%')
);

-- ---------------------------------------------------------------- retention (versioned policy data)
CREATE TABLE retention_policies (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, version INTEGER NOT NULL,
  definition TEXT NOT NULL, sha256 TEXT NOT NULL, reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, version),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);
CREATE TRIGGER retention_policies_no_update BEFORE UPDATE ON retention_policies BEGIN SELECT RAISE(ABORT, 'retention policy versions are immutable'); END;
CREATE TRIGGER retention_policies_no_delete BEFORE DELETE ON retention_policies BEGIN SELECT RAISE(ABORT, 'retention policy versions are immutable'); END;

CREATE TABLE retention_runs (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, run_id TEXT NOT NULL, policy_version INTEGER NOT NULL, policy_sha256 TEXT NOT NULL,
  dry_run INTEGER NOT NULL, counts TEXT NOT NULL, started_by TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, run_id)
);
CREATE TRIGGER retention_runs_no_update BEFORE UPDATE ON retention_runs BEGIN SELECT RAISE(ABORT, 'retention runs are append-only'); END;

-- ---------------------------------------------------------------- account deletion (two people)
CREATE TABLE account_deletion_requests (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, request_id TEXT NOT NULL, account_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested','executed','rejected','cancelled')),
  reason TEXT NOT NULL, requested_by TEXT NOT NULL, requested_at TEXT NOT NULL,
  decided_by TEXT, decided_at TEXT, decision_reason TEXT,
  summary TEXT, summary_sha256 TEXT, executed_at TEXT,
  PRIMARY KEY (tenant_id, client_id, request_id),
  FOREIGN KEY (tenant_id, client_id, account_id) REFERENCES accounts (tenant_id, client_id, account_id),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK (state <> 'executed' OR (summary IS NOT NULL AND summary_sha256 IS NOT NULL AND decided_by IS NOT NULL))
);
CREATE UNIQUE INDEX account_deletion_open ON account_deletion_requests (tenant_id, client_id, account_id) WHERE state = 'requested';
CREATE TRIGGER account_deletion_final BEFORE UPDATE ON account_deletion_requests WHEN OLD.state <> 'requested'
  BEGIN SELECT RAISE(ABORT, 'a decided deletion request is final'); END;
CREATE TRIGGER account_deletion_no_delete BEFORE DELETE ON account_deletion_requests BEGIN SELECT RAISE(ABORT, 'deletion requests are kept'); END;

ALTER TABLE accounts ADD COLUMN deleted_at TEXT;

-- ---------------------------------------------------------------- PHI key rotation
-- Re-encryption jobs are per tenant/client and resumable: each batch re-reads what still uses an
-- inactive key, so a crash loses nothing. Retirement is deployment-wide and refused while any
-- sealed value in any scope still names the key.
CREATE TABLE phi_rekey_jobs (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, job_id TEXT NOT NULL, target_key_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','completed','failed')),
  batch_size INTEGER NOT NULL, batches INTEGER NOT NULL DEFAULT 0, rewritten INTEGER NOT NULL DEFAULT 0, counts TEXT NOT NULL DEFAULT '{}',
  last_error TEXT, started_by TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
  PRIMARY KEY (tenant_id, client_id, job_id)
);
CREATE UNIQUE INDEX phi_rekey_one_running ON phi_rekey_jobs (tenant_id, client_id) WHERE state = 'running';

CREATE TABLE phi_key_retirements (
  key_id TEXT PRIMARY KEY, retired_by TEXT NOT NULL, retired_at TEXT NOT NULL, reason TEXT NOT NULL, checked TEXT NOT NULL
);
CREATE TRIGGER phi_key_retirements_no_update BEFORE UPDATE ON phi_key_retirements BEGIN SELECT RAISE(ABORT, 'key retirements are final'); END;
CREATE TRIGGER phi_key_retirements_no_delete BEFORE DELETE ON phi_key_retirements BEGIN SELECT RAISE(ABORT, 'key retirements are final'); END;

-- ---------------------------------------------------------------- call recording (disabled by default)
-- Consent mode is customer/counsel configuration recorded here, never inferred by the application.
CREATE TABLE recording_policies (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, version INTEGER NOT NULL,
  definition TEXT NOT NULL, sha256 TEXT NOT NULL, reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, version),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);
CREATE TRIGGER recording_policies_no_update BEFORE UPDATE ON recording_policies BEGIN SELECT RAISE(ABORT, 'recording policy versions are immutable'); END;
CREATE TRIGGER recording_policies_no_delete BEFORE DELETE ON recording_policies BEGIN SELECT RAISE(ABORT, 'recording policy versions are immutable'); END;

-- SIMULATED recordings: metadata and a sealed storage reference only; no audio exists.
CREATE TABLE call_recordings (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, recording_id TEXT NOT NULL, call_id TEXT NOT NULL, account_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL, policy_sha256 TEXT NOT NULL, consent_mode TEXT NOT NULL, disclosure_seq INTEGER NOT NULL,
  storage_ref TEXT NOT NULL, retention_class TEXT NOT NULL, simulated INTEGER NOT NULL CHECK (simulated = 1),
  duration_ms INTEGER, state TEXT NOT NULL CHECK (state IN ('recording','available','purged','deleted')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, recording_id),
  UNIQUE (tenant_id, client_id, call_id),
  FOREIGN KEY (tenant_id, client_id, call_id) REFERENCES voice_calls (tenant_id, client_id, call_id)
);

-- ---------------------------------------------------------------- immutability triggers, rewritten
-- Generated from each table's column list: every column except the rewritable ones must be
-- unchanged, and a rewritable column changes only under a matching permit and never from a tombstone.
DROP TRIGGER evidence_no_update;
CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence WHEN NOT (
  NEW.tenant_id IS OLD.tenant_id AND NEW.client_id IS OLD.client_id AND NEW.account_id IS OLD.account_id AND NEW.evidence_id IS OLD.evidence_id AND NEW.kind IS OLD.kind AND NEW.title IS OLD.title AND NEW.source IS OLD.source AND NEW.sha256 IS OLD.sha256 AND NEW.observed_at IS OLD.observed_at AND NEW.effective_at IS OLD.effective_at AND NEW.created_by IS OLD.created_by
    AND (NEW.content IS OLD.content OR (COALESCE(OLD.content, '') NOT LIKE 'tombstone:%' AND EXISTS (SELECT 1 FROM immutable_rewrite_permits p WHERE p.table_name = 'evidence' AND p.column_name = 'content' AND p.row_key = OLD.tenant_id || '|' || OLD.client_id || '|' || OLD.evidence_id AND p.old_value IS OLD.content AND p.new_value IS NEW.content)))
) BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;

DROP TRIGGER voice_events_no_update;
CREATE TRIGGER voice_events_no_update BEFORE UPDATE ON voice_call_events WHEN NOT (
  NEW.tenant_id IS OLD.tenant_id AND NEW.client_id IS OLD.client_id AND NEW.call_id IS OLD.call_id AND NEW.seq IS OLD.seq AND NEW.kind IS OLD.kind AND NEW.speaker IS OLD.speaker AND NEW.question_id IS OLD.question_id AND NEW.sim_at_ms IS OLD.sim_at_ms AND NEW.data IS OLD.data AND NEW.created_at IS OLD.created_at
    AND (NEW.text IS OLD.text OR (COALESCE(OLD.text, '') NOT LIKE 'tombstone:%' AND EXISTS (SELECT 1 FROM immutable_rewrite_permits p WHERE p.table_name = 'voice_call_events' AND p.column_name = 'text' AND p.row_key = OLD.tenant_id || '|' || OLD.client_id || '|' || OLD.call_id || '|' || OLD.seq AND p.old_value IS OLD.text AND p.new_value IS NEW.text)))
) BEGIN SELECT RAISE(ABORT, 'voice_call_events are append-only'); END;

DROP TRIGGER writebacks_immutable;
CREATE TRIGGER writebacks_immutable BEFORE UPDATE ON note_writebacks WHEN NOT (
  NEW.tenant_id IS OLD.tenant_id AND NEW.client_id IS OLD.client_id AND NEW.action_id IS OLD.action_id AND NEW.account_id IS OLD.account_id AND NEW.source_action_id IS OLD.source_action_id AND NEW.original_sha256 IS OLD.original_sha256 AND NEW.final_sha256 IS OLD.final_sha256 AND NEW.edited IS OLD.edited AND NEW.edited_by IS OLD.edited_by AND NEW.created_by IS OLD.created_by AND NEW.created_at IS OLD.created_at
    AND (NEW.original_draft IS OLD.original_draft OR (COALESCE(OLD.original_draft, '') NOT LIKE 'tombstone:%' AND EXISTS (SELECT 1 FROM immutable_rewrite_permits p WHERE p.table_name = 'note_writebacks' AND p.column_name = 'original_draft' AND p.row_key = OLD.tenant_id || '|' || OLD.client_id || '|' || OLD.action_id AND p.old_value IS OLD.original_draft AND p.new_value IS NEW.original_draft)))
    AND (NEW.final_text IS OLD.final_text OR (COALESCE(OLD.final_text, '') NOT LIKE 'tombstone:%' AND EXISTS (SELECT 1 FROM immutable_rewrite_permits p WHERE p.table_name = 'note_writebacks' AND p.column_name = 'final_text' AND p.row_key = OLD.tenant_id || '|' || OLD.client_id || '|' || OLD.action_id AND p.old_value IS OLD.final_text AND p.new_value IS NEW.final_text)))
    AND (NEW.edit_reason IS OLD.edit_reason OR (COALESCE(OLD.edit_reason, '') NOT LIKE 'tombstone:%' AND EXISTS (SELECT 1 FROM immutable_rewrite_permits p WHERE p.table_name = 'note_writebacks' AND p.column_name = 'edit_reason' AND p.row_key = OLD.tenant_id || '|' || OLD.client_id || '|' || OLD.action_id AND p.old_value IS OLD.edit_reason AND p.new_value IS NEW.edit_reason)))
) BEGIN SELECT RAISE(ABORT, 'write-back drafts are immutable'); END;

DROP TRIGGER decisions_no_update;
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON review_decisions WHEN NOT (
  NEW.tenant_id IS OLD.tenant_id AND NEW.client_id IS OLD.client_id AND NEW.decision_id IS OLD.decision_id AND NEW.action_id IS OLD.action_id AND NEW.decision IS OLD.decision AND NEW.actor_id IS OLD.actor_id AND NEW.payload_sha256 IS OLD.payload_sha256 AND NEW.account_revision IS OLD.account_revision AND NEW.created_at IS OLD.created_at
    AND (NEW.rationale IS OLD.rationale OR (COALESCE(OLD.rationale, '') NOT LIKE 'tombstone:%' AND EXISTS (SELECT 1 FROM immutable_rewrite_permits p WHERE p.table_name = 'review_decisions' AND p.column_name = 'rationale' AND p.row_key = OLD.tenant_id || '|' || OLD.client_id || '|' || OLD.decision_id AND p.old_value IS OLD.rationale AND p.new_value IS NEW.rationale)))
) BEGIN SELECT RAISE(ABORT, 'review_decisions are immutable'); END;


-- Proposal payloads: the bound hash, revision and kind never change; the stored payload changes
-- only under a permit (reseal of its sealed free-text fields, or a tombstone on account deletion).
DROP TRIGGER payload_immutable;
CREATE TRIGGER payload_immutable BEFORE UPDATE OF payload, payload_sha256, expected_revision, kind ON proposed_actions WHEN NOT (
  NEW.payload_sha256 IS OLD.payload_sha256 AND NEW.expected_revision IS OLD.expected_revision AND NEW.kind IS OLD.kind
    AND (NEW.payload IS OLD.payload OR (OLD.payload NOT LIKE '%"tombstone:v1:%' AND EXISTS (SELECT 1 FROM immutable_rewrite_permits p WHERE p.table_name = 'proposed_actions' AND p.column_name = 'payload' AND p.row_key = OLD.tenant_id || '|' || OLD.client_id || '|' || OLD.action_id AND p.old_value IS OLD.payload AND p.new_value IS NEW.payload)))
) BEGIN SELECT RAISE(ABORT, 'proposed action payload is immutable'); END;

-- EDI raw content: tombstone only (retention of raw evidence); the raw hash never changes.
DROP TRIGGER edi_files_raw_immutable;
CREATE TRIGGER edi_files_raw_immutable BEFORE UPDATE OF raw, raw_sha256 ON edi_files WHEN NOT (
  NEW.raw_sha256 IS OLD.raw_sha256
    AND (NEW.raw IS OLD.raw OR (OLD.raw NOT LIKE 'tombstone:%' AND NEW.raw LIKE 'tombstone:v1:%' AND EXISTS (SELECT 1 FROM immutable_rewrite_permits p WHERE p.table_name = 'edi_files' AND p.column_name = 'raw' AND p.row_key = OLD.tenant_id || '|' || OLD.client_id || '|' || OLD.file_id AND p.old_value IS OLD.raw AND p.new_value IS NEW.raw)))
) BEGIN SELECT RAISE(ABORT, 'EDI raw content is immutable'); END;
