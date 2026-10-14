-- ADR 0095 (stress testing): indexes for access paths the load harness found doing
-- full scans. Each one is named after the query that needed it. Additive only.

-- audit(): "latest event hash for this tenant" ran on every audited write and sorted the
-- whole tenant chain (USE TEMP B-TREE FOR ORDER BY), making bulk import O(n^2).
CREATE INDEX IF NOT EXISTS audit_tenant_seq ON audit_events (tenant_id, seq);

-- 835/277 identity matching by claim reference; 271 matching by patient token.
CREATE INDEX IF NOT EXISTS accounts_claim_reference ON accounts (tenant_id, client_id, claim_reference);
CREATE INDEX IF NOT EXISTS accounts_patient_token ON accounts (tenant_id, client_id, patient_token);

-- Queue views and counts filter by state.
CREATE INDEX IF NOT EXISTS accounts_state ON accounts (tenant_id, client_id, state);

-- Latest proposal per account (queue next step, account view, in-flight checks).
CREATE INDEX IF NOT EXISTS proposed_actions_account ON proposed_actions (tenant_id, client_id, account_id, created_at);
-- Review queue: awaiting_review proposals in creation order.
CREATE INDEX IF NOT EXISTS proposed_actions_state ON proposed_actions (tenant_id, client_id, state, created_at);

-- Outbox worker scans by state on every tick.
CREATE INDEX IF NOT EXISTS action_outbox_state ON action_outbox (state, created_at);

-- resolveFacts(): all observations for one account. Without this every investigation and every
-- ingested 835/277/271 item scanned the whole observations table (an 835 of 1,000 claims took ~5 s).
CREATE INDEX IF NOT EXISTS observations_account ON observations (tenant_id, client_id, account_id);

-- recordLedger(): "latest ledger hash for this tenant" sorted the tenant's whole ledger per entry.
CREATE INDEX IF NOT EXISTS ledger_tenant_seq ON outcome_ledger (tenant_id, seq);
-- reconcileLine(): prior remittance line for the same account and line number.
CREATE INDEX IF NOT EXISTS remittance_lines_account ON remittance_lines (tenant_id, client_id, account_id, line_number);
-- Approval lookups by action (outbox re-checks, account view, receipt attribution).
CREATE INDEX IF NOT EXISTS review_decisions_action ON review_decisions (tenant_id, client_id, action_id);
