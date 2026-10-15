// Operator provisioning (ADR 0090): tenants, clients, users, role grants and the IdP link table.
// Run through scripts/admin.ts by someone with access to the deployment (not over HTTP): sign-in
// never creates users or grants, so access exists only where an operator recorded it. Every change
// is written to auth_events; grant changes also go into the tenant's hash-chained audit log.
import { type Db, one, run, tx, all } from '../db/db.ts';
import { AppError, invalid, newId, nowIso } from '../util.ts';
import { audit } from './audit.ts';
import { authEvent, revokeUserSessions } from './web-sessions.ts';

const ID = /^[A-Za-z0-9][\w.-]{1,63}$/;
const CORE = ['specialist', 'reviewer', 'supervisor', 'auditor'];
const EXTRA = ['rule_approver'];
const need = (v: string | undefined, what: string) => { if (!v || !ID.test(v)) throw invalid(`${what} must be 2-64 letters, digits, ., _ or -`); return v; };
const name = (v: string | undefined, what: string) => { const s = (v ?? '').trim(); if (s.length < 2 || s.length > 120) throw invalid(`${what} must be 2-120 characters`); return s; };

export function addTenant(db: Db, actor: string, tenantId: string, tenantName: string) {
  need(tenantId, 'tenant id');
  return tx(db, () => {
    if (one(db, 'SELECT 1 FROM tenants WHERE tenant_id=?', tenantId)) throw new AppError(409, 'exists', 'Tenant exists');
    run(db, 'INSERT INTO tenants VALUES (?,?)', tenantId, name(tenantName, 'tenant name'));
    authEvent(db, { type: 'admin_tenant_added', actor, details: { tenantId } });
    return { tenantId };
  });
}

export function addClient(db: Db, actor: string, tenantId: string, clientId: string, clientName: string) {
  need(tenantId, 'tenant id'); need(clientId, 'client id');
  return tx(db, () => {
    if (!one(db, 'SELECT 1 FROM tenants WHERE tenant_id=?', tenantId)) throw new AppError(404, 'not_found', 'No such tenant');
    if (one(db, 'SELECT 1 FROM clients WHERE tenant_id=? AND client_id=?', tenantId, clientId)) throw new AppError(409, 'exists', 'Client exists');
    run(db, 'INSERT INTO clients VALUES (?,?,?)', tenantId, clientId, name(clientName, 'client name'));
    authEvent(db, { type: 'admin_client_added', actor, details: { tenantId, clientId } });
    return { tenantId, clientId };
  });
}

export function addUser(db: Db, actor: string, userId: string, displayName: string) {
  need(userId, 'user id');
  if (userId.startsWith('svc:')) throw invalid('svc: is reserved for API keys');
  return tx(db, () => {
    if (one(db, 'SELECT 1 FROM users WHERE user_id=?', userId)) throw new AppError(409, 'exists', 'User exists');
    run(db, 'INSERT INTO users VALUES (?,?)', userId, name(displayName, 'display name'));
    authEvent(db, { type: 'admin_user_added', actor, userId });
    return { userId };
  });
}

export function setGrant(db: Db, actor: string, userId: string, tenantId: string, clientId: string, role: string, on: boolean) {
  if (![...CORE, ...EXTRA].includes(role)) throw invalid(`role must be one of ${[...CORE, ...EXTRA].join(', ')}`);
  return tx(db, () => {
    if (!one(db, 'SELECT 1 FROM users WHERE user_id=?', userId)) throw new AppError(404, 'not_found', 'No such user');
    if (!one(db, 'SELECT 1 FROM clients WHERE tenant_id=? AND client_id=?', tenantId, clientId)) throw new AppError(404, 'not_found', 'No such client');
    const table = CORE.includes(role) ? 'grants' : 'extra_role_grants';
    if (table === 'extra_role_grants' && on && !one(db, 'SELECT 1 FROM grants WHERE user_id=? AND tenant_id=? AND client_id=?', userId, tenantId, clientId))
      throw invalid('rule_approver is added on top of a core role in the same client; grant a core role first');
    const changed = on ? run(db, `INSERT OR IGNORE INTO ${table} VALUES (?,?,?,?)`, userId, tenantId, clientId, role)
      : run(db, `DELETE FROM ${table} WHERE user_id=? AND tenant_id=? AND client_id=? AND role=?`, userId, tenantId, clientId, role);
    if (changed) {
      audit(db, { tenantId, clientId, actorId: actor, objectType: 'user_grant', objectId: userId, eventType: on ? 'grant_added' : 'grant_removed', details: { role } });
      authEvent(db, { type: on ? 'admin_grant_added' : 'admin_grant_removed', actor, userId, details: { tenantId, clientId, role } });
    }
    return { userId, tenantId, clientId, role, changed: changed > 0 };
  });
}

export function linkIdentity(db: Db, actor: string, o: { userId: string; issuer: string; subject?: string; email?: string }) {
  if (!o.issuer || !/^https?:\/\//.test(o.issuer)) throw invalid('issuer must be the exact OIDC issuer URL');
  if (!o.subject && !o.email) throw invalid('give --subject (the IdP sub claim) or --email (bound on first verified sign-in)');
  if (o.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) throw invalid('email is not valid');
  return tx(db, () => {
    if (!one(db, 'SELECT 1 FROM users WHERE user_id=?', o.userId)) throw new AppError(404, 'not_found', 'No such user');
    const linkId = newId('sso');
    run(db, 'INSERT INTO sso_identities (link_id, issuer, subject, email, user_id, created_by, created_at, bound_at) VALUES (?,?,?,?,?,?,?,?)',
      linkId, o.issuer, o.subject ?? null, o.email?.toLowerCase() ?? null, o.userId, actor, nowIso(), o.subject ? nowIso() : null);
    authEvent(db, { type: 'admin_sso_linked', actor, userId: o.userId, issuer: o.issuer, subject: o.subject ?? null, details: { linkId, byEmail: !o.subject } });
    return { linkId };
  });
}

export function disableIdentity(db: Db, actor: string, linkId: string) {
  return tx(db, () => {
    const r = one<{ user_id: string; disabled_at: string | null }>(db, 'SELECT user_id, disabled_at FROM sso_identities WHERE link_id=?', linkId);
    if (!r) throw new AppError(404, 'not_found', 'No such link');
    if (r.disabled_at) throw new AppError(409, 'already_disabled', 'Already disabled');
    run(db, 'UPDATE sso_identities SET disabled_at=?, disabled_by=? WHERE link_id=?', nowIso(), actor, linkId);
    const revoked = revokeUserSessions(db, r.user_id, 'sso_link_disabled');
    authEvent(db, { type: 'admin_sso_disabled', actor, userId: r.user_id, details: { linkId, sessionsRevoked: revoked } });
    return { linkId, sessionsRevoked: revoked };
  });
}

export function revokeSessionsFor(db: Db, actor: string, userId: string) {
  return tx(db, () => {
    const n = revokeUserSessions(db, userId, 'admin_revoked');
    authEvent(db, { type: 'admin_sessions_revoked', actor, userId, details: { count: n } });
    return { userId, sessionsRevoked: n };
  });
}

export function overview(db: Db) {
  return {
    users: all(db, 'SELECT user_id, display_name FROM users ORDER BY user_id'),
    grants: all(db, "SELECT user_id, tenant_id, client_id, role FROM grants UNION ALL SELECT user_id, tenant_id, client_id, role FROM extra_role_grants ORDER BY 1, 2, 3, 4"),
    links: all(db, 'SELECT link_id, issuer, subject, email, user_id, bound_at, disabled_at FROM sso_identities ORDER BY created_at'),
  };
}
