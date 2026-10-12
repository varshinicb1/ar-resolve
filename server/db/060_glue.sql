-- ADR 0060: cross-workstream glue.
-- A reviewer may explicitly release a verbal payer request (accepted on a call) that
-- has not been reconciled by a receipt or an adjudication, so a new external request
-- of the same class can be approved. Append-only; one release per acceptance.
CREATE TABLE verbal_request_overrides (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, override_id TEXT NOT NULL,
  account_id TEXT NOT NULL, call_id TEXT NOT NULL, answer_id TEXT NOT NULL,
  guard_version INTEGER NOT NULL, reason TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, override_id),
  UNIQUE (tenant_id, client_id, answer_id),
  FOREIGN KEY (tenant_id, client_id, account_id) REFERENCES accounts (tenant_id, client_id, account_id)
);
CREATE TRIGGER verbal_request_overrides_no_update BEFORE UPDATE ON verbal_request_overrides BEGIN SELECT RAISE(ABORT, 'verbal request overrides are append-only'); END;
CREATE TRIGGER verbal_request_overrides_no_delete BEFORE DELETE ON verbal_request_overrides BEGIN SELECT RAISE(ABORT, 'verbal request overrides are append-only'); END;
