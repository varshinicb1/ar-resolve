-- Operations workstream (040-049): follow-up calendars and tasks (FR13), remittance
-- reconciliation and the outcome ledger (FR14), note write-back to a simulated PM
-- system (FR12), payer/workflow pause holds (FR16) and product analytics events.
-- See docs/adr/0040-operations.md.

-- ---------------------------------------------------------------- product analytics
-- Opaque identifiers and enumerated classifications only. No free text, no PHI.
CREATE TABLE analytics_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK (event_name IN ('account_imported','identity_blocked','evidence_collected','evidence_conflict',
    'proposal_generated','review_opened','fact_corrected','proposal_approved','proposal_rejected','action_dispatched',
    'action_receipt_received','writeback_confirmed','followup_due','outcome_reconciled','account_reopened')),
  account_id TEXT, object_id TEXT, actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','system')), actor_id TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}', schema_version INTEGER NOT NULL, occurred_at TEXT NOT NULL
);
CREATE INDEX analytics_scope ON analytics_events (tenant_id, client_id, event_name, occurred_at);
CREATE TRIGGER analytics_no_update BEFORE UPDATE ON analytics_events BEGIN SELECT RAISE(ABORT, 'analytics_events is append-only'); END;
CREATE TRIGGER analytics_no_delete BEFORE DELETE ON analytics_events BEGIN SELECT RAISE(ABORT, 'analytics_events is append-only'); END;

-- ---------------------------------------------------------------- business calendars (FR13)
-- Versioned. NULL scope columns mean "applies more broadly". The most specific
-- matching calendar wins (payer+client > payer+tenant > client > tenant > global).
CREATE TABLE business_calendars (
  calendar_id TEXT NOT NULL, version INTEGER NOT NULL,
  tenant_id TEXT, client_id TEXT, payer_id TEXT,
  name TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('reference','synthetic','unverified')),
  definition TEXT NOT NULL, sha256 TEXT NOT NULL, source TEXT NOT NULL, retrieved_at TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (calendar_id, version)
);
CREATE TRIGGER calendars_immutable BEFORE UPDATE ON business_calendars BEGIN SELECT RAISE(ABORT, 'calendar versions are immutable'); END;
CREATE TRIGGER calendars_no_delete BEFORE DELETE ON business_calendars BEGIN SELECT RAISE(ABORT, 'calendar versions are immutable'); END;

-- Supervisor-configured review interval used when no payer commitment exists.
-- This is internal policy, never a payer promise.
CREATE TABLE followup_policies (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, version INTEGER NOT NULL,
  interval_value INTEGER NOT NULL CHECK (interval_value BETWEEN 1 AND 120),
  interval_unit TEXT NOT NULL CHECK (interval_unit IN ('days','weeks')),
  basis TEXT NOT NULL CHECK (basis IN ('business','calendar')),
  reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, version),
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, client_id)
);
CREATE TRIGGER policies_immutable BEFORE UPDATE ON followup_policies BEGIN SELECT RAISE(ABORT, 'policy versions are immutable'); END;

-- A payer commitment captured from evidence, with its exact source locator.
CREATE TABLE payer_commitments (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, commitment_id TEXT NOT NULL, account_id TEXT NOT NULL,
  action_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('turnaround','reprocess','callback')),
  value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 365), unit TEXT NOT NULL CHECK (unit IN ('days','weeks')),
  basis TEXT NOT NULL CHECK (basis IN ('business','calendar')), anchor_date TEXT NOT NULL,
  evidence_id TEXT NOT NULL, locator TEXT NOT NULL, quote TEXT NOT NULL,
  capture_method TEXT NOT NULL CHECK (capture_method IN ('structured','specialist')),
  status TEXT NOT NULL CHECK (status IN ('verified','reported')),
  captured_by TEXT NOT NULL, captured_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, commitment_id),
  FOREIGN KEY (tenant_id, client_id, account_id, evidence_id) REFERENCES evidence (tenant_id, client_id, account_id, evidence_id)
);
CREATE TRIGGER commitments_immutable BEFORE UPDATE ON payer_commitments BEGIN SELECT RAISE(ABORT, 'commitments are immutable'); END;

CREATE TABLE followup_tasks (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, followup_id TEXT NOT NULL, account_id TEXT NOT NULL,
  action_id TEXT, basis TEXT NOT NULL CHECK (basis IN ('payer_commitment','policy_interval')),
  commitment_id TEXT, policy_version INTEGER, calendar_id TEXT NOT NULL, calendar_version INTEGER NOT NULL,
  anchor_date TEXT NOT NULL, due_date TEXT NOT NULL, computation TEXT NOT NULL, label TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled','due','overdue','snoozed','completed','superseded')),
  snoozed_until TEXT, due_emitted INTEGER NOT NULL DEFAULT 0,
  completed_by TEXT, completed_at TEXT, completion_code TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, followup_id),
  FOREIGN KEY (tenant_id, client_id, account_id) REFERENCES accounts (tenant_id, client_id, account_id),
  FOREIGN KEY (calendar_id, calendar_version) REFERENCES business_calendars (calendar_id, version),
  CHECK (basis <> 'payer_commitment' OR commitment_id IS NOT NULL),
  CHECK (basis <> 'policy_interval' OR policy_version IS NOT NULL)
);
CREATE INDEX followups_due ON followup_tasks (state, due_date);
CREATE TRIGGER followup_basis_immutable BEFORE UPDATE OF basis, commitment_id, policy_version, calendar_id, calendar_version, anchor_date, due_date, computation ON followup_tasks
  BEGIN SELECT RAISE(ABORT, 'follow-up basis and due date are immutable; supersede instead'); END;

-- ---------------------------------------------------------------- remittance and outcomes (FR14)
CREATE TABLE remittance_batches (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, batch_id TEXT NOT NULL, source_name TEXT NOT NULL, format TEXT NOT NULL,
  sha256 TEXT NOT NULL, lines INTEGER NOT NULL, matched INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, batch_id)
);
CREATE TABLE remittance_lines (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, remit_line_id TEXT NOT NULL, batch_id TEXT NOT NULL,
  claim_reference TEXT NOT NULL, payer_id TEXT NOT NULL, line_number INTEGER NOT NULL, adjudicated_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('original','corrected','reversal')),
  allowed_cents INTEGER NOT NULL, paid_cents INTEGER NOT NULL, deductible_cents INTEGER NOT NULL, adjustments TEXT NOT NULL,
  account_id TEXT, match_status TEXT NOT NULL CHECK (match_status IN ('matched','unmatched','ambiguous')),
  evidence_id TEXT, line_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, remit_line_id),
  UNIQUE (tenant_id, client_id, line_sha256)
);
CREATE TRIGGER remit_lines_immutable BEFORE UPDATE ON remittance_lines BEGIN SELECT RAISE(ABORT, 'remittance lines are immutable'); END;
CREATE TABLE cash_postings (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, posting_id TEXT NOT NULL, claim_reference TEXT NOT NULL, payer_id TEXT NOT NULL,
  line_number INTEGER NOT NULL, amount_cents INTEGER NOT NULL, posted_date TEXT NOT NULL, deposit_reference TEXT NOT NULL,
  account_id TEXT, match_status TEXT NOT NULL CHECK (match_status IN ('matched','unmatched','ambiguous')),
  sha256 TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, posting_id), UNIQUE (tenant_id, client_id, sha256)
);
CREATE TRIGGER cash_immutable BEFORE UPDATE ON cash_postings BEGIN SELECT RAISE(ABORT, 'cash postings are immutable'); END;

CREATE TABLE attribution_rules (
  rule_id TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('draft','approved','retired')),
  definition TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (rule_id, version)
);
CREATE TRIGGER attribution_def_immutable BEFORE UPDATE OF definition, sha256 ON attribution_rules BEGIN SELECT RAISE(ABORT, 'attribution rule definitions are immutable'); END;

-- Append-only, hash-chained per tenant. Payer promise, accepted request,
-- adjudication change and cash posting are distinct entry types.
CREATE TABLE outcome_ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, account_id TEXT NOT NULL, line_number INTEGER, action_id TEXT,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('payer_promise','request_accepted','adjudication_changed','adjudication_unchanged','reversal','cash_posted','contradiction')),
  amount_cents INTEGER, delta_cents INTEGER,
  attribution TEXT NOT NULL CHECK (attribution IN ('attributable','not_attributable','not_applicable')),
  attribution_rule TEXT, attribution_reason TEXT NOT NULL,
  source_type TEXT NOT NULL, source_id TEXT NOT NULL, evidence_id TEXT,
  recorded_by TEXT NOT NULL, recorded_at TEXT NOT NULL, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL
);
CREATE INDEX ledger_account ON outcome_ledger (tenant_id, client_id, account_id, seq);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON outcome_ledger BEGIN SELECT RAISE(ABORT, 'outcome_ledger is append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON outcome_ledger BEGIN SELECT RAISE(ABORT, 'outcome_ledger is append-only'); END;

-- ---------------------------------------------------------------- note write-back (FR12)
-- Simulated PM/EHR system of record. Stands in for the customer's PM; survives restarts.
CREATE TABLE sim_pm_records (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, account_id TEXT NOT NULL, pm_record_id TEXT NOT NULL UNIQUE,
  external_id TEXT NOT NULL, record_version INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, account_id)
);
CREATE TABLE sim_pm_notes (
  pm_note_id TEXT PRIMARY KEY, pm_record_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  field TEXT NOT NULL, note_type TEXT NOT NULL, text TEXT NOT NULL, written_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- Write-back proposal detail: original system draft, the final (possibly edited)
-- text, who edited and why. The approver is the review_decisions row.
CREATE TABLE note_writebacks (
  tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, action_id TEXT NOT NULL, account_id TEXT NOT NULL,
  source_action_id TEXT NOT NULL, original_draft TEXT NOT NULL, original_sha256 TEXT NOT NULL,
  final_text TEXT NOT NULL, final_sha256 TEXT NOT NULL, edited INTEGER NOT NULL, edit_reason TEXT, edited_by TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, client_id, action_id),
  FOREIGN KEY (tenant_id, client_id, action_id) REFERENCES proposed_actions (tenant_id, client_id, action_id),
  CHECK (edited = 0 OR (edit_reason IS NOT NULL AND edited_by IS NOT NULL))
);
CREATE TRIGGER writebacks_immutable BEFORE UPDATE ON note_writebacks BEGIN SELECT RAISE(ABORT, 'write-back drafts are immutable'); END;

-- ---------------------------------------------------------------- pause holds (FR16)
-- A held row stays state='pending' (the core CHECK constraint is not altered) but
-- is never dispatched while held_at is set. Release happens only after re-check.
ALTER TABLE action_outbox ADD COLUMN held_at TEXT;
ALTER TABLE action_outbox ADD COLUMN hold_scope_key TEXT;
ALTER TABLE action_outbox ADD COLUMN hold_reason TEXT;
