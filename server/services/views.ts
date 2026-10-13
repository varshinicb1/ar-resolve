// Read models for the account workspace and the scoped audit export (FR15).
import { type Db, all, one } from '../db/db.ts';
import { hashJson, nowIso } from '../util.ts';
import { scenarioView } from './scenario.ts';
import { audit, accountEvents, verifyChain } from './audit.ts';
import { can, requirePerm, type Scope } from './auth.ts';
import { listEvidence } from './evidence.ts';
import { currentFacts, factHistory } from './facts.ts';
import { approvalChecks, type ActionRow } from './review.ts';
import { activePause } from './controls.ts';
import { getAccountRow, priorityOf } from './workflow.ts';
import { accountOperationsExport } from './writeback.ts';
import { openPayload } from './sealed-store.ts';
import { open as openSealed } from './phi.ts';

function actions(db: Db, scope: Scope, accountId: string) {
  return all<ActionRow>(db, "SELECT * FROM proposed_actions WHERE tenant_id=? AND client_id=? AND account_id=? AND kind <> 'note_writeback' ORDER BY created_at DESC, rowid DESC", scope.tenantId, scope.clientId, accountId);
}

export function accountView(db: Db, scope: Scope, accountId: string) {
  requirePerm(scope, 'view');
  const a = getAccountRow(db, scope, accountId);
  const facts = currentFacts(db, scope, accountId);
  // Facts shown are the selected pack's required facts (DED01 for Phase 0 accounts).
  const scenario = scenarioView(db, scope, a, facts);
  const factList = scenario.factRule.definition.requiredFacts.map((rf) => {
    const f = facts.get(rf.key);
    return { key: rf.key, label: rf.label, acceptedStatuses: rf.acceptedStatuses, status: f?.status ?? 'missing', value: f?.value ?? null,
      unit: f?.unit ?? null, version: f?.version ?? 0, evidenceId: f?.evidenceId ?? null, locator: f?.locator ?? null, candidates: f?.candidates ?? [],
      ...(rf.optional ? { optional: true } : {}) };
  });
  const latestRun = one<{ run_id: string; state: string; result: string; inputs: string; account_revision: number; rule_id: string; rule_version: number; rule_sha256: string; created_by: string; created_at: string }>(db,
    'SELECT * FROM workflow_runs WHERE tenant_id=? AND client_id=? AND account_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', scope.tenantId, scope.clientId, accountId);
  const acts = actions(db, scope, accountId).map((r) => {
    const outbox = one<{ state: string; attempts: number; external_reference: string | null; last_error: string | null; idempotency_key: string; receipt_evidence_id: string | null }>(db,
      'SELECT state, attempts, external_reference, last_error, idempotency_key, receipt_evidence_id FROM action_outbox WHERE tenant_id=? AND client_id=? AND action_id=?', scope.tenantId, scope.clientId, r.action_id);
    const decisions = all<{ decision_id: string; decision: string; actor_id: string; rationale: string; payload_sha256: string; account_revision: number; created_at: string }>(db,
      'SELECT decision_id, decision, actor_id, rationale, payload_sha256, account_revision, created_at FROM review_decisions WHERE tenant_id=? AND client_id=? AND action_id=? ORDER BY created_at', scope.tenantId, scope.clientId, r.action_id);
    return {
      actionId: r.action_id, runId: r.run_id, kind: r.kind, riskClass: r.risk_class, connector: r.connector, payload: openPayload(r.payload),
      payloadSha256: r.payload_sha256, expectedRevision: r.expected_revision, state: r.state, expiresAt: r.expires_at, noteDraft: openSealed(r.note_draft),
      createdBy: r.created_by, createdAt: r.created_at, outbox: outbox ?? null, decisions,
      checks: r.state === 'awaiting_review' ? approvalChecks(db, scope, r) : null,
    };
  });
  const interactions = all<{ interaction_id: string; channel: string; destination: string; state: string; transitions: string; transcript_evidence_id: string | null; call_reference: string | null; mocked: number; created_at: string }>(db,
    'SELECT * FROM interactions WHERE tenant_id=? AND client_id=? AND account_id=? ORDER BY created_at', scope.tenantId, scope.clientId, accountId)
    .map((i) => ({ interactionId: i.interaction_id, channel: i.channel, destination: i.destination, state: i.state, transitions: JSON.parse(i.transitions),
      transcriptEvidenceId: i.transcript_evidence_id, callReference: i.call_reference, mocked: !!i.mocked, createdAt: i.created_at,
      // ADR 0060: calls run by the voice engine against the simulated line, vs the legacy pre-scripted transcript.
      engineCallId: one<{ call_id: string }>(db, 'SELECT call_id FROM voice_calls WHERE tenant_id=? AND client_id=? AND interaction_id=?', scope.tenantId, scope.clientId, i.interaction_id)?.call_id ?? null }));
  return {
    account: {
      accountId: a.account_id, externalId: a.external_id, payerId: a.payer_id, providerId: a.provider_id, patientToken: a.patient_token,
      serviceDate: a.service_date, claimReference: a.claim_reference, claimType: a.claim_type, balanceCents: a.balance_cents, currency: a.currency,
      scenario: a.scenario, state: a.state, revision: a.revision, batchId: a.batch_id, followupDue: a.followup_due, createdAt: a.created_at, updatedAt: a.updated_at,
      priority: priorityOf(a),
    },
    facts: factList,
    evidence: listEvidence(db, scope, accountId),
    latestRun: latestRun ? { runId: latestRun.run_id, state: latestRun.state, result: JSON.parse(latestRun.result), inputs: JSON.parse(latestRun.inputs),
      accountRevision: latestRun.account_revision, rule: { id: latestRun.rule_id, version: latestRun.rule_version, sha256: latestRun.rule_sha256 }, createdBy: latestRun.created_by, createdAt: latestRun.created_at } : null,
    actions: acts,
    interactions,
    timeline: accountEvents(db, scope.tenantId, scope.clientId, accountId),
    pause: activePause(db, scope.tenantId, scope.clientId),
    scenario: { current: scenario.current, lastRun: scenario.lastRun, pack: scenario.pack },
    permissions: { investigate: can(scope, 'investigate'), correct: can(scope, 'correct_fact'), review: can(scope, 'review'), operate: can(scope, 'operate'), export: can(scope, 'audit_export') },
  };
}

export function auditExport(db: Db, scope: Scope, accountId: string) {
  requirePerm(scope, 'audit_export');
  const a = getAccountRow(db, scope, accountId);
  const view = accountView(db, scope, accountId);
  const runs = all<Record<string, unknown>>(db, 'SELECT run_id, account_revision, rule_id, rule_version, rule_sha256, state, result, inputs, created_by, created_at FROM workflow_runs WHERE tenant_id=? AND client_id=? AND account_id=? ORDER BY created_at, rowid',
    scope.tenantId, scope.clientId, accountId).map((r) => ({ ...r, result: JSON.parse(r.result as string), inputs: JSON.parse(r.inputs as string) }));
  const exportedAt = nowIso();
  const exportEvent = audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'audit_export', objectId: accountId, accountId,
    eventType: 'audit_exported', details: { redactionProfile: 'synthetic-default' } });
  const packet = {
    format: 'ar-resolve.audit-packet.v1',
    environment: 'synthetic',
    exportedAt, exportedBy: scope.userId, exportEventId: exportEvent,
    scope: { tenantId: scope.tenantId, clientId: scope.clientId },
    redactionProfile: { name: 'synthetic-default', note: 'Synthetic data. Patient token shown masked; production profiles must be agreed with the client.' },
    account: { ...view.account, patientToken: a.patient_token.slice(0, 3) + '***' },
    facts: view.facts,
    factHistory: factHistory(db, scope, accountId),
    evidence: view.evidence,
    runs,
    actions: view.actions,
    interactions: view.interactions,
    events: accountEvents(db, scope.tenantId, scope.clientId, accountId),
    auditChain: verifyChain(db, scope.tenantId),
    operations: accountOperationsExport(db, scope, accountId), // write-backs, commitments, follow-ups, outcome ledger
  };
  return { ...packet, packetSha256: hashJson(packet) };
}
