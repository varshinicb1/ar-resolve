-- ADR 0070: components ported from clinic-receptionist (same owner).
-- Vendor/BAA register (PHI gate), notification channels with an outbox and a simulated sink,
-- and Twilio status-callback dedupe for the (disabled) live telephony adapter.

-- ---------------------------------------------------------------- vendor / BAA register
-- One row per recorded version. Append-only: a change is a new version with a reason (audited).
-- Recording "signed" is a person's attestation; the code cannot verify a contract.
CREATE TABLE vendor_baas (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, vendor_id TEXT NOT NULL, version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('signed','not_signed','in_negotiation','terminated')),
  baa_ref TEXT, covered_services TEXT NOT NULL, effective_on TEXT, expires_on TEXT, notes TEXT NOT NULL,
  record_sha256 TEXT NOT NULL, recorded_by TEXT NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, vendor_id, version),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id),
  CHECK (status <> 'signed' OR (baa_ref IS NOT NULL AND effective_on IS NOT NULL))
);
CREATE TRIGGER vendor_baas_no_update BEFORE UPDATE ON vendor_baas BEGIN SELECT RAISE(ABORT, 'vendor BAA records are append-only'); END;
CREATE TRIGGER vendor_baas_no_delete BEFORE DELETE ON vendor_baas BEGIN SELECT RAISE(ABORT, 'vendor BAA records are append-only'); END;

-- ---------------------------------------------------------------- notifications
-- config is sealed JSON (AES-256-GCM when AR_PHI_KEY is set); secrets never leave the server.
CREATE TABLE notification_channels (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL, events TEXT NOT NULL, filter TEXT,
  include_details INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, channel_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);

-- Outbox: one row per channel and source event (the audit event id), so a replayed event is not sent twice.
CREATE TABLE notification_deliveries (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
  channel_id TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','failed','refused')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL, delivered_at TEXT,
  PRIMARY KEY (tenant_id, client_id, delivery_id),
  UNIQUE (tenant_id, client_id, channel_id, event_id),
  FOREIGN KEY (tenant_id, client_id, channel_id) REFERENCES notification_channels (tenant_id, client_id, channel_id)
);
CREATE INDEX notification_deliveries_due ON notification_deliveries (status, next_attempt_at);

-- SIMULATED destination: what a Slack channel, inbox or webhook receiver would have received.
CREATE TABLE notification_sink (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, message_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL, channel_id TEXT NOT NULL, text TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, message_id)
);

-- ---------------------------------------------------------------- Twilio status callbacks
-- Dedupe key: CallSid + SequenceNumber + CallStatus (events may arrive out of order). A callback
-- for a call this system did not place is recorded unmatched and changes nothing; until it is
-- matched to a voice_calls row it has no tenant, so tenant_id/client_id are NULL for those rows.
CREATE TABLE telephony_callbacks (
  dedupe_key TEXT PRIMARY KEY, adapter TEXT NOT NULL, provider_call_id TEXT NOT NULL,
  call_status TEXT NOT NULL, sequence_number INTEGER, tenant_id TEXT, client_id TEXT, call_id TEXT,
  matched INTEGER NOT NULL, body_sha256 TEXT NOT NULL, received_at TEXT NOT NULL
);
