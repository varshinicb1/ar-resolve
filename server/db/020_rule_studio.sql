-- Rule studio lifecycle (ADR 0020). rule_versions (001) stays the immutable store
-- of hashed definitions; these tables add per-scope ownership, review, activation
-- and retirement without altering core tables.

-- Roles that the core grants CHECK constraint does not list. Only rule_approver today.
CREATE TABLE extra_role_grants (
  user_id TEXT NOT NULL REFERENCES users, tenant_id TEXT NOT NULL, client_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('rule_approver')),
  PRIMARY KEY (user_id, tenant_id, client_id, role),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);

-- Working copies. Editable until validation freezes them into a new rule version.
CREATE TABLE rule_drafts (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, draft_id TEXT NOT NULL,
  rule_id TEXT NOT NULL, base_version INTEGER NOT NULL, definition TEXT NOT NULL,
  edit_seq INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('editing','frozen','withdrawn')),
  frozen_version INTEGER, last_validation TEXT,
  author_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, draft_id),
  FOREIGN KEY (rule_id, base_version) REFERENCES rule_versions (rule_id, version)
);

-- Lifecycle of each frozen version. Owner scope '*'/'*' marks built-in baselines.
CREATE TABLE rule_lifecycle (
  rule_id TEXT NOT NULL, version INTEGER NOT NULL,
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','validated','in_review','approved','rejected','retired')),
  base_version INTEGER, draft_id TEXT, author_id TEXT NOT NULL,
  validation TEXT, validation_sha256 TEXT,
  submitted_by TEXT, submitted_at TEXT, reviewed_by TEXT, reviewed_at TEXT, review_rationale TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (rule_id, version),
  FOREIGN KEY (rule_id, version) REFERENCES rule_versions (rule_id, version),
  CHECK (status <> 'approved' OR reviewed_by IS NOT NULL),
  -- Separation of duties also holds at the storage layer.
  CHECK (reviewed_by IS NULL OR reviewed_by <> author_id)
);
CREATE INDEX rule_lifecycle_scope ON rule_lifecycle (tenant_id, client_id, rule_id);

-- Append-only activation log. The active version for a scope is the latest
-- activation whose active_from has passed.
CREATE TABLE rule_activations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, activation_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, rule_id TEXT NOT NULL, version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('publish','rollback')),
  active_from TEXT NOT NULL, reason TEXT NOT NULL, previous_version INTEGER,
  definition_sha256 TEXT NOT NULL, activated_by TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (rule_id, version) REFERENCES rule_versions (rule_id, version),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);
CREATE INDEX rule_activations_scope ON rule_activations (tenant_id, client_id, rule_id, active_from);

CREATE TABLE rule_retirements (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, rule_id TEXT NOT NULL, version INTEGER NOT NULL,
  reason TEXT NOT NULL, retired_by TEXT NOT NULL, retired_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, rule_id, version),
  FOREIGN KEY (rule_id, version) REFERENCES rule_versions (rule_id, version)
);

CREATE TRIGGER rule_activations_no_update BEFORE UPDATE ON rule_activations BEGIN SELECT RAISE(ABORT, 'rule_activations is append-only'); END;
CREATE TRIGGER rule_activations_no_delete BEFORE DELETE ON rule_activations BEGIN SELECT RAISE(ABORT, 'rule_activations is append-only'); END;
CREATE TRIGGER rule_retirements_no_update BEFORE UPDATE ON rule_retirements BEGIN SELECT RAISE(ABORT, 'rule_retirements are immutable'); END;
CREATE TRIGGER rule_retirements_no_delete BEFORE DELETE ON rule_retirements BEGIN SELECT RAISE(ABORT, 'rule_retirements are immutable'); END;
-- A retired version never comes back.
CREATE TRIGGER rule_lifecycle_retired_final BEFORE UPDATE OF status ON rule_lifecycle WHEN OLD.status = 'retired'
  BEGIN SELECT RAISE(ABORT, 'retired rule versions are final'); END;
