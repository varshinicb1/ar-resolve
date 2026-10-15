// The live connector gate (ADR 0100). A live adapter may execute only when ALL of these hold:
//   1. the provider's mode variable is explicitly sandbox or production (deployment);
//   2. its credentials and base URLs are configured (deployment);
//   3. a customer authorization is recorded for this tenant/client and not revoked (scope);
//   4. production only: the connector live gate of ADR 0030/0070 is open for this scope
//      (covered-service verification, BAA reference, complete onboarding, non-synthetic environment,
//      PHI gate and BAA register) AND the connector was switched to live for this scope.
// Sandbox runs with synthetic or vendor-documented test data only: account-driven calls in sandbox
// refuse accounts whose identifiers are not synthetic (assertSandboxData).
// Every refusal is returned as reasons; the framework records it as a refused connector event.
import { type Db, all, one, run, tx } from '../../db/db.ts';
import { AppError, invalid, nowIso } from '../../util.ts';
import { audit } from '../../services/audit.ts';
import { requirePerm, type Scope } from '../../services/auth.ts';
import { getConfig, latestAuthorization, liveGate } from '../framework.ts';
import { phiModeOn } from '../../services/governance.ts';
import { type Env, type LiveMode, type ProviderId, SPECS, deploymentReasons, liveEnv, modeOf } from './config.ts';

export function revocation(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, connectorId: string, authorizationId: string) {
  return one<{ reason: string; revoked_by: string; revoked_at: string }>(db,
    'SELECT reason, revoked_by, revoked_at FROM live_authorization_revocations WHERE tenant_id=? AND client_id=? AND connector_id=? AND authorization_id=?',
    scope.tenantId, scope.clientId, connectorId, authorizationId) ?? null;
}

export interface GateResult { provider: ProviderId; connectorId: string; mode: LiveMode; open: boolean; reasons: string[] }

export function providerGate(db: Db, scope: Scope, p: ProviderId, env: Env = liveEnv()): GateResult {
  const spec = SPECS[p];
  const mode = modeOf(p, env);
  const reasons = [...deploymentReasons(p, env)];
  const auth = latestAuthorization(db, scope, spec.connectorId);
  if (!auth) reasons.push('No customer authorization is recorded for this client (POST /api/integrations/connectors/:id/authorization).');
  else {
    const rev = revocation(db, scope, spec.connectorId, auth.authorization_id);
    if (rev) reasons.push(`The latest authorization (${auth.authorization_id}) was revoked on ${rev.revoked_at.slice(0, 10)}.`);
  }
  if (mode === 'production') {
    // The full ADR 0030/0070 live gate, unchanged: authorization with covered-service verification,
    // BAA reference, complete onboarding, non-synthetic environment, PHI gate and BAA register.
    for (const r of liveGate(db, scope, spec.connectorId)) if (!reasons.includes(r)) reasons.push(r);
    if (!phiModeOn(env)) reasons.push('Production needs AR_PHI_MODE=on (PHI gate, ADR 0070).');
    if (getConfig(db, scope, spec.connectorId).mode !== 'live') reasons.push('The connector is not switched to live for this client (POST /api/integrations/connectors/:id/mode {"mode":"live"}).');
  }
  return { provider: p, connectorId: spec.connectorId, mode, open: reasons.length === 0, reasons };
}

// Synthetic markers used by the generated cohort (same as governance.isSyntheticInventoryRow).
const SYN_CLAIM = /^SYN[A-Z]?-C/;
const SYN_PT = /^PT-/;

/** Sandbox calls never carry possibly-real identifiers. Throws 409 with the reason otherwise. */
export function assertSandboxData(mode: LiveMode, ids: { claimReference?: string | null; patientToken?: string | null }) {
  if (mode !== 'sandbox') return;
  const bad: string[] = [];
  if (ids.claimReference && !SYN_CLAIM.test(ids.claimReference)) bad.push('claim reference');
  if (ids.patientToken && !SYN_PT.test(ids.patientToken)) bad.push('patient token');
  if (bad.length) throw new AppError(409, 'sandbox_requires_synthetic', `Sandbox mode sends synthetic or vendor test data only; this account's ${bad.join(' and ')} is not synthetic.`);
}

export function revokeAuthorization(db: Db, scope: Scope, connectorId: string, body: { reason?: unknown }) {
  requirePerm(scope, 'integration_admin');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 10) throw invalid('A reason of at least 10 characters is required');
  return tx(db, () => {
    const auth = latestAuthorization(db, scope, connectorId);
    if (!auth) throw new AppError(409, 'no_authorization', 'No authorization is recorded for this connector and client');
    if (revocation(db, scope, connectorId, auth.authorization_id)) throw new AppError(409, 'already_revoked', 'The latest authorization is already revoked');
    run(db, 'INSERT INTO live_authorization_revocations VALUES (?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, connectorId, auth.authorization_id, reason.slice(0, 2000), scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'connector', objectId: connectorId, eventType: 'connector_authorization_revoked',
      details: { authorizationId: auth.authorization_id, reason } });
    return { authorizationId: auth.authorization_id, revoked: true };
  });
}

export function lastSmoke(db: Db, provider: ProviderId) {
  const r = one<{ run_id: string; mode: string; target: string; outcome: string; checks: string; finished_at: string; run_by: string }>(db,
    'SELECT run_id, mode, target, outcome, checks, finished_at, run_by FROM live_smoke_runs WHERE provider=? ORDER BY finished_at DESC, rowid DESC LIMIT 1', provider);
  return r ? { runId: r.run_id, mode: r.mode, target: r.target, outcome: r.outcome, checks: JSON.parse(r.checks) as unknown[], finishedAt: r.finished_at, runBy: r.run_by } : null;
}

export function smokeHistory(db: Db, provider: ProviderId, limit = 10) {
  return all<{ run_id: string; mode: string; target: string; outcome: string; finished_at: string }>(db,
    'SELECT run_id, mode, target, outcome, finished_at FROM live_smoke_runs WHERE provider=? ORDER BY finished_at DESC, rowid DESC LIMIT ?', provider, limit);
}
