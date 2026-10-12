// Development identity only: named synthetic users sign in without a password.
// Production needs enterprise SSO + MFA (docs/08). Scope and roles always come
// from the server-side grants table, never from the client.
import { type Db, all, one, run } from '../db/db.ts';
import { AppError, forbidden, newToken, nowIso, sha256, now } from '../util.ts';

export type Role = 'specialist' | 'reviewer' | 'supervisor' | 'auditor' | 'rule_approver';

export const PERMISSIONS = {
  view: ['specialist', 'reviewer', 'supervisor', 'auditor'],
  import: ['specialist', 'supervisor'],
  investigate: ['specialist', 'reviewer'],
  correct_fact: ['specialist', 'reviewer'],
  review: ['reviewer'],
  operate: ['supervisor'],
  audit_export: ['auditor', 'supervisor'],
  rule_author: ['reviewer', 'supervisor'],
  rule_approve: ['rule_approver'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export interface Scope {
  userId: string;
  displayName: string;
  tenantId: string;
  clientId: string;
  roles: Role[];
}

export interface Identity {
  userId: string;
  displayName: string;
}

const SESSION_HOURS = 12;

export function createSession(db: Db, userId: string): string {
  const user = one(db, 'SELECT user_id FROM users WHERE user_id = ?', userId);
  if (!user) throw new AppError(401, 'unknown_user', 'Unknown development user');
  const token = newToken();
  const expires = new Date(now().getTime() + SESSION_HOURS * 3600_000).toISOString();
  run(db, 'INSERT INTO sessions VALUES (?, ?, ?, ?)', sha256(token), userId, nowIso(), expires);
  return token;
}

export function authenticate(db: Db, token: string | undefined): Identity {
  if (!token) throw new AppError(401, 'unauthenticated', 'Sign in required');
  const row = one<{ user_id: string; display_name: string; expires_at: string }>(db,
    'SELECT s.user_id, u.display_name, s.expires_at FROM sessions s JOIN users u USING (user_id) WHERE s.token_sha256 = ?', sha256(token));
  if (!row || row.expires_at < nowIso()) throw new AppError(401, 'unauthenticated', 'Session expired or invalid');
  return { userId: row.user_id, displayName: row.display_name };
}

export function listScopes(db: Db, userId: string) {
  const rows = all<{ tenant_id: string; tenant_name: string; client_id: string; client_name: string; role: Role }>(db,
    `SELECT g.tenant_id, t.name tenant_name, g.client_id, c.name client_name, g.role
     FROM grants g JOIN tenants t USING (tenant_id) JOIN clients c ON c.tenant_id = g.tenant_id AND c.client_id = g.client_id
     WHERE g.user_id = ? ORDER BY g.rowid`, userId);
  const map = new Map<string, { tenantId: string; tenantName: string; clientId: string; clientName: string; roles: Role[] }>();
  for (const r of rows) {
    const key = `${r.tenant_id}/${r.client_id}`;
    if (!map.has(key)) map.set(key, { tenantId: r.tenant_id, tenantName: r.tenant_name, clientId: r.client_id, clientName: r.client_name, roles: [] });
    map.get(key)!.roles.push(r.role);
  }
  for (const x of extraRoles(db, userId)) map.get(`${x.tenant_id}/${x.client_id}`)?.roles.push(x.role);
  return [...map.values()];
}

// Resolves the requested tenant/client against the caller's grants. A scope the
// caller holds no grant for is indistinguishable from one that does not exist.
export function resolveScope(db: Db, ident: Identity, tenantId: string | undefined, clientId: string | undefined): Scope {
  if (!tenantId || !clientId) throw new AppError(400, 'scope_required', 'Select a tenant and client scope');
  const roles = all<{ role: Role }>(db, 'SELECT role FROM grants WHERE user_id = ? AND tenant_id = ? AND client_id = ?',
    ident.userId, tenantId, clientId).map((r) => r.role);
  if (!roles.length) throw new AppError(404, 'scope_not_found', 'Scope not found');
  roles.push(...extraRoles(db, ident.userId).filter((x) => x.tenant_id === tenantId && x.client_id === clientId).map((x) => x.role));
  return { userId: ident.userId, displayName: ident.displayName, tenantId, clientId, roles };
}

// Roles outside the core grants CHECK list (migration 020). Only add to a scope the
// user already holds a core grant for.
function extraRoles(db: Db, userId: string) {
  return all<{ tenant_id: string; client_id: string; role: Role }>(db, 'SELECT tenant_id, client_id, role FROM extra_role_grants WHERE user_id = ? ORDER BY rowid', userId);
}

export function can(scope: Scope, perm: Permission): boolean {
  return scope.roles.some((r) => (PERMISSIONS[perm] as readonly Role[]).includes(r));
}

export function requirePerm(scope: Scope, perm: Permission): void {
  if (!can(scope, perm)) throw forbidden(`Your role in this client does not permit: ${perm.replace('_', ' ')}`);
}

// Re-check used by the executor at dispatch time: the approver must still hold review rights.
export function userHasRole(db: Db, userId: string, tenantId: string, clientId: string, role: Role): boolean {
  return !!one(db, 'SELECT 1 FROM grants WHERE user_id = ? AND tenant_id = ? AND client_id = ? AND role = ?', userId, tenantId, clientId, role);
}
