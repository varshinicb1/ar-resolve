-- ADR 0100: real, gated integrations. Two append-only tables.

-- A recorded connector authorization (connector_authorizations, ADR 0030) can be revoked for one
-- tenant/client. Revocations are final; a new authorization must be recorded to re-enable.
CREATE TABLE live_authorization_revocations (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, connector_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL, reason TEXT NOT NULL, revoked_by TEXT NOT NULL, revoked_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, connector_id, authorization_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id),
  CHECK (length(reason) >= 10)
);
CREATE TRIGGER live_authorization_revocations_no_update BEFORE UPDATE ON live_authorization_revocations
  BEGIN SELECT RAISE(ABORT, 'revocations are append-only'); END;
CREATE TRIGGER live_authorization_revocations_no_delete BEFORE DELETE ON live_authorization_revocations
  BEGIN SELECT RAISE(ABORT, 'revocations are append-only'); END;

-- Smoke runs (npm run smoke:live) are DEPLOYMENT-level, not tenant data: they test the credentials in
-- this deployment's environment against the vendor's sandbox with vendor-documented test data only.
-- They carry no tenant, client, account or patient data, so the table has no tenant/client columns
-- (a documented exception in ADR 0100). Only pass/fail per check and short error text are stored.
CREATE TABLE live_smoke_runs (
  run_id TEXT PRIMARY KEY, provider TEXT NOT NULL, mode TEXT NOT NULL, target TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'refused')),
  checks TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, run_by TEXT NOT NULL,
  CHECK (target IN ('vendor_sandbox', 'local_mock', 'none'))
);
CREATE INDEX live_smoke_runs_provider ON live_smoke_runs (provider, finished_at);
CREATE TRIGGER live_smoke_runs_no_update BEFORE UPDATE ON live_smoke_runs BEGIN SELECT RAISE(ABORT, 'smoke runs are append-only'); END;
CREATE TRIGGER live_smoke_runs_no_delete BEFORE DELETE ON live_smoke_runs BEGIN SELECT RAISE(ABORT, 'smoke runs are append-only'); END;
