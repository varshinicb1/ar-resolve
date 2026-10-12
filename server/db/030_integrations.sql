-- Integrations workstream (migration range 030-039). Connector registry and
-- per-client configuration, versioned onboarding records, recorded authorizations,
-- versioned field mappings, connector events (adapter contract responses),
-- circuit breaker state, EDI file ingestion, and the generic signed webhook inbox.

-- Per tenant/client connector configuration. mode is what the client has asked
-- for; a live mode can only be set through the enable gate (server/connectors/framework.ts).
CREATE TABLE connector_configs (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, connector_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('local','simulated','disabled_live','live')),
  enabled INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL DEFAULT '{}',
  mapping_id TEXT, mapping_version INTEGER,
  updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, connector_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);

-- Connector onboarding record (docs/07): each save is a new immutable version.
CREATE TABLE connector_onboarding (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, connector_id TEXT NOT NULL, version INTEGER NOT NULL,
  record TEXT NOT NULL, sha256 TEXT NOT NULL, completeness REAL NOT NULL,
  recorded_by TEXT NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, connector_id, version),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);

-- Recorded customer authorization and covered-service verification. Required
-- (with a complete onboarding record and a non-synthetic environment) before live mode.
CREATE TABLE connector_authorizations (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, connector_id TEXT NOT NULL, authorization_id TEXT NOT NULL,
  authorization_ref TEXT NOT NULL, covered_service_verified INTEGER NOT NULL, baa_ref TEXT,
  notes TEXT NOT NULL DEFAULT '', recorded_by TEXT NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, authorization_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);

-- Versioned field mappings (definitions live in code; this table pins the hash
-- of every version ever used so a stored evidence record can be traced to it).
CREATE TABLE field_mapping_versions (
  mapping_id TEXT NOT NULL, version INTEGER NOT NULL, transaction_kind TEXT NOT NULL,
  definition TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (mapping_id, version)
);

-- Adapter contract responses (docs/07): one row per connector request/response or inbound event.
CREATE TABLE connector_events (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, event_id TEXT NOT NULL, connector_id TEXT NOT NULL,
  request_id TEXT NOT NULL, account_id TEXT, account_revision INTEGER, idempotency_key TEXT,
  action_class TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','not_found','rejected','error','timeout','uncertain','partially_completed','refused')),
  external_refs TEXT NOT NULL DEFAULT '{}', evidence_locator TEXT, source_time TEXT, received_time TEXT NOT NULL,
  raw_sha256 TEXT, normalized TEXT NOT NULL DEFAULT 'null', latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT,
  created_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, event_id)
);
CREATE INDEX connector_events_recent ON connector_events (tenant_id, client_id, connector_id, received_time);

CREATE TABLE connector_circuits (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, connector_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('closed','open','half_open')), consecutive_failures INTEGER NOT NULL,
  opened_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, connector_id)
);

-- Uploaded/received EDI files. Raw content is kept with its hash; ingestion is
-- idempotent per scope and bound to the previewed hash.
CREATE TABLE edi_files (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, file_id TEXT NOT NULL,
  filename TEXT NOT NULL, transaction_sets TEXT NOT NULL, raw_sha256 TEXT NOT NULL, raw TEXT NOT NULL,
  envelope TEXT NOT NULL, report TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ingested','partially_ingested','nothing_matched','rejected')),
  mapping TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, file_id),
  UNIQUE (tenant_id, client_id, raw_sha256),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);

-- Generic signed webhook inbox. Provider account → tenant/client is resolved
-- here, never from the payload. Events are persisted before acknowledgement.
CREATE TABLE webhook_endpoints (
  provider TEXT NOT NULL, provider_account TEXT NOT NULL, tenant_id TEXT NOT NULL, client_id TEXT NOT NULL,
  connector_id TEXT NOT NULL, secret_env TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (provider, provider_account)
);
CREATE TABLE webhook_events (
  provider TEXT NOT NULL, event_id TEXT NOT NULL, provider_account TEXT NOT NULL,
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, raw_sha256 TEXT NOT NULL, payload TEXT NOT NULL,
  occurred_at TEXT, received_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received','applied','ignored_out_of_order','failed')),
  detail TEXT, processed_at TEXT,
  PRIMARY KEY (provider, event_id)
);
-- Monotonic per-object state fed by webhooks (out-of-order tolerant).
CREATE TABLE webhook_object_state (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, provider TEXT NOT NULL, object_ref TEXT NOT NULL,
  state TEXT NOT NULL, rank INTEGER NOT NULL, occurred_at TEXT NOT NULL, event_id TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, provider, object_ref)
);

CREATE TABLE sim_clearinghouse_faults (fault TEXT PRIMARY KEY, remaining INTEGER NOT NULL);

-- Synthetic webhook endpoints for the simulated clearinghouse (one provider account per client).
INSERT INTO webhook_endpoints VALUES ('sim_clearinghouse', 'SIMCH-ORTHO', 'tn_demo', 'cl_ortho', 'sim_clearinghouse', 'AR_WEBHOOK_SECRET_SIMCH_ORTHO', 1);
INSERT INTO webhook_endpoints VALUES ('sim_clearinghouse', 'SIMCH-DERM', 'tn_demo', 'cl_derm', 'sim_clearinghouse', 'AR_WEBHOOK_SECRET_SIMCH_DERM', 1);
INSERT INTO webhook_endpoints VALUES ('sim_clearinghouse', 'SIMCH-OTHER', 'tn_other', 'cl_other', 'sim_clearinghouse', 'AR_WEBHOOK_SECRET_SIMCH_OTHER', 1);

CREATE TRIGGER onboarding_immutable BEFORE UPDATE ON connector_onboarding BEGIN SELECT RAISE(ABORT, 'onboarding record versions are immutable'); END;
CREATE TRIGGER authorizations_immutable BEFORE UPDATE ON connector_authorizations BEGIN SELECT RAISE(ABORT, 'authorization records are immutable'); END;
CREATE TRIGGER mapping_immutable BEFORE UPDATE ON field_mapping_versions BEGIN SELECT RAISE(ABORT, 'field mapping versions are immutable'); END;
CREATE TRIGGER connector_events_immutable BEFORE UPDATE ON connector_events BEGIN SELECT RAISE(ABORT, 'connector events are immutable'); END;
CREATE TRIGGER edi_files_raw_immutable BEFORE UPDATE OF raw, raw_sha256 ON edi_files BEGIN SELECT RAISE(ABORT, 'EDI raw content is immutable'); END;
