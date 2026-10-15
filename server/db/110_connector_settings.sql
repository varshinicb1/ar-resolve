-- ADR 0110: provider keys and modes entered in the app ("Connect providers" page).
--
-- DEPLOYMENT-level, like the environment variables they stand in for (same documented exception as
-- live_smoke_runs, ADR 0100): one Stedi key serves the whole deployment, so there are no tenant or
-- client columns. Only names declared in server/connectors/live/config.ts (SPECS vars and each
-- provider's mode variable) are accepted; the service refuses anything else.
--
-- Secret values are sealed with AES-256-GCM (server/services/phi.ts format enc:v1/enc:v2) before they
-- reach this table; the CHECK refuses a secret row whose value is not sealed. Non-secret values
-- (client ids, sender address, mode) are stored plain. An environment variable always wins over a row.
CREATE TABLE connector_settings (
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  secret INTEGER NOT NULL CHECK (secret IN (0, 1)),
  last4 TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, name),
  CHECK (secret = 0 OR value LIKE 'enc:v_:%'),
  CHECK (secret = 1 OR last4 IS NULL),
  CHECK (last4 IS NULL OR length(last4) <= 4)
);

-- Append-only change history: who, when, which name, set or cleared, and a fingerprint. For a secret
-- the fingerprint is only its last 4 characters (empty for values shorter than 12); never the value.
CREATE TABLE connector_setting_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('set', 'cleared')),
  secret INTEGER NOT NULL CHECK (secret IN (0, 1)),
  fingerprint TEXT,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  -- The scope the administrator acted from (for tracing to the audit chain); not an owner of the row.
  actor_tenant_id TEXT NOT NULL,
  actor_client_id TEXT NOT NULL,
  CHECK (secret = 0 OR fingerprint IS NULL OR length(fingerprint) <= 5)
);
CREATE INDEX connector_setting_changes_name ON connector_setting_changes (provider, name, seq);
CREATE TRIGGER connector_setting_changes_no_update BEFORE UPDATE ON connector_setting_changes
  BEGIN SELECT RAISE(ABORT, 'connector setting changes are append-only'); END;
CREATE TRIGGER connector_setting_changes_no_delete BEFORE DELETE ON connector_setting_changes
  BEGIN SELECT RAISE(ABORT, 'connector setting changes are append-only'); END;
