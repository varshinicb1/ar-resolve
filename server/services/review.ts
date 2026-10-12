// Hash-bound human review (FR10/FR11). The client never sends an "approved"
// payload: it names the action and echoes the payload hash and account revision
// it saw. The server recomputes every prerequisite inside one transaction.
import { type Db, one, run, tx } from '../db/db.ts';
import { AppError, conflict, forbidden, hashJson, invalid, newId, notFound, nowIso } from '../util.ts';
import { audit } from './audit.ts';
import { can, requirePerm, type Scope } from './auth.ts';
import { loadRule } from './rules.ts';
import { getAccountRow } from './workflow.ts';
import { ruleRunnableForApproval } from './scenario.ts';
import type { RuleDefinition } from '../../shared/rules/catalog.ts';

export interface ActionRow {
  tenant_id: string; client_id: string; action_id: string; account_id: string; run_id: string; expected_revision: number;
  kind: string; risk_class: string; connector: string; payload: string; payload_sha256: string; note_draft: string;
  state: string; expires_at: string; created_by: string; created_at: string; updated_at: string;
}

export interface Check { id: string; label: string; pass: boolean; detail?: string }

export function getAction(db: Db, scope: Scope, actionId: string): ActionRow {
  const r = one<ActionRow>(db, 'SELECT * FROM proposed_actions WHERE tenant_id=? AND client_id=? AND action_id=?', scope.tenantId, scope.clientId, actionId);
  if (!r) throw notFound('Action');
  return r;
}

// Deterministic verifier: the same list drives the disabled-button explanations
// in the UI and the server-side gate.
export function approvalChecks(db: Db, scope: Scope, action: ActionRow): Check[] {
  const account = getAccountRow(db, scope, action.account_id);
  const runRow = one<{ inputs: string; created_by: string; rule_id: string; rule_version: number }>(db,
    'SELECT inputs, created_by, rule_id, rule_version FROM workflow_runs WHERE tenant_id=? AND client_id=? AND run_id=?', scope.tenantId, scope.clientId, action.run_id)!;
  const inputs = JSON.parse(runRow.inputs) as { factRefs: { key: string; used: boolean; status: string; optional?: boolean }[] };
  const def: RuleDefinition = loadRule(db, runRow.rule_id, runRow.rule_version).definition;
  const payload = JSON.parse(action.payload);
  // Optional facts (a handled branch when absent, ADR 0020) never block approval.
  const unusable = inputs.factRefs.filter((f) => !f.used && !f.optional);
  const runnable = ruleRunnableForApproval(db, scope, runRow.rule_id, runRow.rule_version);
  const checks: Check[] = [
    { id: 'role', label: 'You hold the reviewer role for this client', pass: can(scope, 'review') },
    { id: 'separation', label: 'Reviewer is not the person who generated the proposal', pass: scope.userId !== runRow.created_by,
      detail: scope.userId === runRow.created_by ? 'Separation of duties: ask another reviewer' : undefined },
    { id: 'state', label: 'Proposal is awaiting review', pass: action.state === 'awaiting_review', detail: `Current state: ${action.state}` },
    { id: 'current', label: 'Proposal reflects the current evidence revision', pass: action.expected_revision === account.revision,
      detail: action.expected_revision === account.revision ? undefined : `Proposal revision ${action.expected_revision}, account now at ${account.revision}` },
    { id: 'expiry', label: 'Proposal has not expired', pass: action.expires_at > nowIso(), detail: `Expires ${action.expires_at}` },
    { id: 'integrity', label: 'Payload matches its recorded hash', pass: hashJson(payload) === action.payload_sha256 },
    { id: 'identity', label: 'Account identity verified', pass: account.state !== 'blocked' && !unusable.some((f) => f.key === 'identityVerified') },
    { id: 'facts', label: 'All required facts are verified or acceptably reported', pass: unusable.length === 0,
      detail: unusable.length ? `Unusable: ${unusable.map((f) => `${f.key} (${f.status})`).join(', ')}` : undefined },
    { id: 'permitted', label: 'Action is permitted by the rule and not prohibited', pass: def.actions.some((a) => a.kind === action.kind && a.risk !== 'abstain') && !def.prohibitedActions.includes(action.kind) },
    { id: 'rule', label: `Rule ${runRow.rule_id} v${runRow.rule_version} is runnable in this environment (synthetic: draft allowed)`, pass: runnable.pass, detail: runnable.detail },
  ];
  return checks;
}

export interface ReviewInput { decision: 'approved' | 'rejected' | 'needs_evidence'; rationale: string; payloadSha256: string; accountRevision: number }

export function reviewAction(db: Db, scope: Scope, actionId: string, input: ReviewInput) {
  requirePerm(scope, 'review');
  if (!['approved', 'rejected', 'needs_evidence'].includes(input.decision)) throw invalid('decision must be approved, rejected or needs_evidence');
  if (!input.rationale || input.rationale.trim().length < 5) throw invalid('A rationale is required for every decision');
  if (typeof input.payloadSha256 !== 'string' || typeof input.accountRevision !== 'number') throw invalid('payloadSha256 and accountRevision are required');
  return tx(db, () => {
    const action = getAction(db, scope, actionId);
    const account = getAccountRow(db, scope, action.account_id);
    if (input.payloadSha256 !== action.payload_sha256) throw conflict('payload_mismatch', 'The proposal you reviewed is not the stored proposal. Refresh before deciding.');
    if (input.accountRevision !== account.revision || action.expected_revision !== account.revision) {
      throw conflict('stale_review', 'Evidence changed after this proposal was generated. Refresh to review the current proposal.', { proposalRevision: action.expected_revision, accountRevision: account.revision, yourRevision: input.accountRevision });
    }
    if (action.state !== 'awaiting_review') throw conflict('not_reviewable', `This proposal is already ${action.state}`, { state: action.state });
    if (input.decision === 'approved') {
      const failed = approvalChecks(db, scope, action).filter((c) => !c.pass);
      if (failed.length) {
        if (failed.some((f) => f.id === 'role' || f.id === 'separation')) throw forbidden(failed.map((f) => f.detail ?? f.label).join('; '));
        throw new AppError(422, 'prerequisites_failed', 'Approval prerequisites failed', failed);
      }
    }
    // Conditional update: exactly one concurrent decision can win.
    const changed = run(db, `UPDATE proposed_actions SET state=?, updated_at=? WHERE tenant_id=? AND client_id=? AND action_id=? AND state='awaiting_review' AND expected_revision=?`,
      input.decision, nowIso(), scope.tenantId, scope.clientId, actionId, account.revision);
    if (changed !== 1) throw conflict('not_reviewable', 'Another decision was recorded first');
    const decisionId = newId('dec');
    run(db, 'INSERT INTO review_decisions VALUES (?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, decisionId, actionId, input.decision,
      scope.userId, input.rationale.trim(), action.payload_sha256, account.revision, nowIso());
    let idempotencyKey: string | null = null;
    if (input.decision === 'approved') {
      idempotencyKey = `${scope.tenantId}:${scope.clientId}:${actionId}:${action.payload_sha256.slice(0, 16)}`;
      run(db, 'INSERT INTO action_outbox (tenant_id, client_id, action_id, idempotency_key, connector, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        scope.tenantId, scope.clientId, actionId, idempotencyKey, action.connector, 'pending', nowIso(), nowIso());
      run(db, 'UPDATE accounts SET state=?, updated_at=? WHERE tenant_id=? AND client_id=? AND account_id=?', 'approved', nowIso(), scope.tenantId, scope.clientId, action.account_id);
    } else {
      run(db, 'UPDATE accounts SET state=?, updated_at=? WHERE tenant_id=? AND client_id=? AND account_id=?',
        input.decision === 'rejected' ? 'specialist_review' : 'needs_information', nowIso(), scope.tenantId, scope.clientId, action.account_id);
    }
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'action', objectId: actionId, accountId: action.account_id,
      eventType: `proposal_${input.decision}`, details: { decisionId, payloadSha256: action.payload_sha256, accountRevision: account.revision, rationale: input.rationale.trim(), idempotencyKey } });
    return { decisionId, decision: input.decision, idempotencyKey };
  });
}
