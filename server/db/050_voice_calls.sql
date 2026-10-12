-- E08 Voice: durable payer call orchestration against a simulated payer line.
-- Every row carries tenant/client scope. Call events and policy versions are
-- append-only; the call row is the state machine record (optimistic version).

-- Versioned client call policy (allowlist, disclosure/recording config, verbal
-- action permissions, cost assumption). The current policy is the max version.
CREATE TABLE voice_policy_versions (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, version INTEGER NOT NULL,
  definition TEXT NOT NULL, sha256 TEXT NOT NULL, reason TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, version),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);

CREATE TABLE voice_calls (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, call_id TEXT NOT NULL, account_id TEXT NOT NULL,
  payer_id TEXT NOT NULL, destination TEXT NOT NULL, scenario_id TEXT NOT NULL,
  plan_id TEXT NOT NULL, plan_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL, policy_sha256 TEXT NOT NULL,
  adapter TEXT NOT NULL, provider_call_id TEXT NOT NULL, sim_script TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','dialing','ivr','hold','transfer','rep_connected','authenticating','questioning','read_back','wrap_up',
    'completed','dropped','cancelled','handoff_to_human','failed')),
  outcome TEXT, reason_code TEXT,
  plan TEXT NOT NULL, line_state TEXT NOT NULL, pending_read_back TEXT,
  sim_elapsed_ms INTEGER NOT NULL DEFAULT 0, ivr_ms INTEGER NOT NULL DEFAULT 0, hold_ms INTEGER NOT NULL DEFAULT 0,
  talk_ms INTEGER NOT NULL DEFAULT 0, hold_segment_ms INTEGER NOT NULL DEFAULT 0, hold_timeout_ms INTEGER NOT NULL,
  cancel_requested TEXT, handoff TEXT, assigned_to TEXT,
  reconcile_required INTEGER NOT NULL DEFAULT 0, reconciled_by TEXT,
  idempotency_key TEXT NOT NULL, account_revision_at_start INTEGER NOT NULL,
  transcript_evidence_id TEXT, interaction_id TEXT,
  version INTEGER NOT NULL DEFAULT 1, next_step_at TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
  PRIMARY KEY (tenant_id, client_id, call_id),
  UNIQUE (tenant_id, client_id, idempotency_key),
  UNIQUE (adapter, provider_call_id),
  FOREIGN KEY (tenant_id, client_id, account_id) REFERENCES accounts (tenant_id, client_id, account_id)
);
CREATE INDEX voice_calls_account ON voice_calls (tenant_id, client_id, account_id, created_at);
CREATE INDEX voice_calls_state ON voice_calls (state, next_step_at);

-- Turn-by-turn record: state transitions, IVR prompts, DTMF, hold segments,
-- agent and representative turns, verifier flags. seq is contiguous per call.
CREATE TABLE voice_call_events (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, call_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('state','ivr','dtmf','hold','turn','flag','system')),
  speaker TEXT, text TEXT, question_id TEXT, sim_at_ms INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, call_id, seq),
  FOREIGN KEY (tenant_id, client_id, call_id) REFERENCES voice_calls (tenant_id, client_id, call_id)
);

-- Structured answers extracted from representative turns, bound to turn seqs.
CREATE TABLE voice_answers (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, call_id TEXT NOT NULL, answer_id TEXT NOT NULL,
  question_id TEXT NOT NULL, answer_key TEXT NOT NULL, fact_key TEXT, value TEXT, unit TEXT,
  status TEXT NOT NULL CHECK (status IN ('extracted','answered','confirmed','unconfirmed','unknown','refused','quarantined')),
  turn_seqs TEXT NOT NULL, read_back_seq INTEGER, flags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, answer_id),
  FOREIGN KEY (tenant_id, client_id, call_id) REFERENCES voice_calls (tenant_id, client_id, call_id)
);
CREATE INDEX voice_answers_call ON voice_answers (tenant_id, client_id, call_id);

-- Signed provider status callbacks, persisted before acknowledgement and deduped by event id.
CREATE TABLE voice_callbacks (
  event_id TEXT PRIMARY KEY, adapter TEXT NOT NULL, provider_call_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, call_id TEXT NOT NULL,
  event_type TEXT NOT NULL, body_sha256 TEXT NOT NULL, received_at TEXT NOT NULL
);

-- SIMULATOR ONLY: the simulated payer's own record of requests a representative
-- accepted on the phone. Survives restarts so a dropped call can be reconciled.
CREATE TABLE sim_voice_payer_requests (
  request_id TEXT PRIMARY KEY, payer_id TEXT NOT NULL, claim_reference TEXT NOT NULL,
  kind TEXT NOT NULL, provider_call_id TEXT NOT NULL, opened_at TEXT NOT NULL,
  tat_value INTEGER, tat_unit TEXT, tat_basis TEXT
);
-- SIMULATOR ONLY: one-shot faults for restart tests.
CREATE TABLE sim_voice_faults (fault TEXT PRIMARY KEY, remaining INTEGER NOT NULL);

CREATE TRIGGER voice_events_no_update BEFORE UPDATE ON voice_call_events BEGIN SELECT RAISE(ABORT, 'voice_call_events are append-only'); END;
CREATE TRIGGER voice_events_no_delete BEFORE DELETE ON voice_call_events BEGIN SELECT RAISE(ABORT, 'voice_call_events are append-only'); END;
CREATE TRIGGER voice_policy_no_update BEFORE UPDATE ON voice_policy_versions BEGIN SELECT RAISE(ABORT, 'voice policy versions are immutable'); END;
CREATE TRIGGER voice_policy_no_delete BEFORE DELETE ON voice_policy_versions BEGIN SELECT RAISE(ABORT, 'voice policy versions are immutable'); END;
