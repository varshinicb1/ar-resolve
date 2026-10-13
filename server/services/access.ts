// Ported from clinic-receptionist src/access.ts (same owner): named, role-based API keys with only a
// hash stored, created by an admin and audited on every use.
//
// The origin replaced one shared API_TOKEN with named keys (admin/staff/readonly) and wrote an audit
// row for every request to a patient-data or admin route. Adapted for AR Resolve (ADR 0080):
//   - a key is a service account bound to ONE tenant/client, holding a subset of the creator's
//     roles there (never more); at every request its roles are intersected again with the creator's
//     CURRENT grants, so removing the creator's role removes it from the key too;
//   - keys never hold human-only permissions (approvals, rule changes, admin of keys, BAAs,
//     retention, deletion, PHI keys, recording): see HUMAN_ONLY in auth.ts;
//   - the development identity (dev login + sessions) is untouched; keys are a separate token
//     family ("ark_") checked only when presented;
//   - every request made with a key is audited into the hash-chained audit log (api_key_request),
//     every action it takes carries actorId "svc:<key id>", and last use is tracked on the key;
//   - creation and revocation need manage_api_keys (supervisor) and a reason; the key is shown once.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { AppError, invalid, notFound, now, nowIso, sha256 } from '../util.ts';
import { randomBytes } from 'node:crypto';
import { audit } from './audit.ts';
import { requirePerm, type Identity, type Role, type Scope } from './auth.ts';

export const ACCESS_VERSION = 'api-keys.v1';
export const KEY_PREFIX = 'ark_';
/** Roles a key may carry. rule_approver is a human attestation role and is never given to a key. */
export const KEY_ROLES: Role[] = ['specialist', 'reviewer', 'supervisor', 'auditor'];
export const MAX_KEY_DAYS = 365;
export const DEFAULT_KEY_DAYS = 90;

interface KeyRow {
  tenant_id: string; client_id: string; key_id: string; name: string; token_sha256: string; token_prefix: string; roles: string;
  created_by: string; created_at: string; expires_at: string | null; revoked_at: string | null; revoked_by: string | null; revoke_reason: string | null;
  last_used_at: string | null; use_count: number;
}

const view = (r: KeyRow) => ({
  keyId: r.key_id, name: r.name, prefix: r.token_prefix, roles: JSON.parse(r.roles) as Role[], principal: `svc:${r.key_id}`,
  createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, revokedBy: r.revoked_by, revokeReason: r.revoke_reason,
  lastUsedAt: r.last_used_at, useCount: r.use_count,
  status: r.revoked_at ? 'revoked' : r.expires_at && r.expires_at <= nowIso() ? 'expired' : 'active',
});

/** Core and extra roles a user holds in one scope (the ceiling for keys they create). */
export function rolesOf(db: Db, userId: string, tenantId: string, clientId: string): Role[] {
  return [
    ...all<{ role: Role }>(db, 'SELECT role FROM grants WHERE user_id=? AND tenant_id=? AND client_id=?', userId, tenantId, clientId).map((r) => r.role),
    ...all<{ role: Role }>(db, 'SELECT role FROM extra_role_grants WHERE user_id=? AND tenant_id=? AND client_id=?', userId, tenantId, clientId).map((r) => r.role),
  ];
}

/** Resolves a presented "ark_" token to a service identity, or throws 401. Refusals of known keys are audited. */
export function authenticateKey(db: Db, token: string): Identity {
  const r = one<KeyRow>(db, 'SELECT * FROM api_keys WHERE token_sha256 = ?', sha256(token));
  if (!r) throw new AppError(401, 'unauthenticated', 'API key invalid');
  const refused = r.revoked_at ? 'revoked' : r.expires_at && r.expires_at <= nowIso() ? 'expired' : null;
  if (refused) {
    audit(db, { tenantId: r.tenant_id, clientId: r.client_id, actorId: `svc:${r.key_id}`, objectType: 'api_key', objectId: r.key_id, eventType: 'api_key_refused', details: { reason: refused } });
    throw new AppError(401, 'unauthenticated', `API key ${refused}`);
  }
  return { userId: `svc:${r.key_id}`, displayName: `Service key: ${r.name}`,
    apiKey: { keyId: r.key_id, tenantId: r.tenant_id, clientId: r.client_id, roles: JSON.parse(r.roles), createdBy: r.created_by } };
}

/** Scope of a key: its own tenant/client only, roles = key roles that the creator still holds. */
export function keyScope(db: Db, ident: Identity, tenantId: string, clientId: string): Scope {
  const k = ident.apiKey!;
  if (tenantId !== k.tenantId || clientId !== k.clientId) throw new AppError(404, 'scope_not_found', 'Scope not found');
  const ceiling = new Set(rolesOf(db, k.createdBy, tenantId, clientId));
  const roles = k.roles.filter((r) => ceiling.has(r));
  if (!roles.length) throw new AppError(403, 'key_without_roles', 'The person who created this key no longer holds any of its roles in this client');
  return { userId: ident.userId, displayName: ident.displayName, tenantId, clientId, roles, serviceKeyId: k.keyId };
}

/** The single scope a key can use (for /api/me). */
export function keyScopes(db: Db, userId: string) {
  const r = one<KeyRow & { tenant_name: string; client_name: string }>(db, `SELECT k.*, t.name tenant_name, c.name client_name FROM api_keys k JOIN tenants t USING (tenant_id)
    JOIN clients c ON c.tenant_id=k.tenant_id AND c.client_id=k.client_id WHERE k.key_id=?`, userId.replace(/^svc:/, ''));
  if (!r) return [];
  const ceiling = new Set(rolesOf(db, r.created_by, r.tenant_id, r.client_id));
  return [{ tenantId: r.tenant_id, tenantName: r.tenant_name, clientId: r.client_id, clientName: r.client_name, roles: (JSON.parse(r.roles) as Role[]).filter((x) => ceiling.has(x)) }];
}

/** Every request a key makes: last-used tracking and one audit event (method + path, no body). */
export function recordKeyRequest(db: Db, scope: Scope, method: string, path: string): void {
  if (!scope.serviceKeyId) return;
  tx(db, () => {
    run(db, 'UPDATE api_keys SET last_used_at=?, use_count=use_count+1 WHERE key_id=?', nowIso(), scope.serviceKeyId);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'api_key', objectId: scope.serviceKeyId!, eventType: 'api_key_request',
      details: { method, path: path.slice(0, 200), roles: scope.roles } });
  });
}

// ---------------------------------------------------------------- admin

function requireHuman(scope: Scope, what: string) {
  if (scope.serviceKeyId) throw new AppError(403, 'forbidden', `A service key cannot ${what}`);
}

export function listKeys(db: Db, scope: Scope) {
  requireHuman(scope, 'list keys');
  requirePerm(scope, 'manage_api_keys');
  return { version: ACCESS_VERSION, keyRoles: KEY_ROLES, maxDays: MAX_KEY_DAYS, yourRoles: scope.roles.filter((r) => KEY_ROLES.includes(r)),
    keys: all<KeyRow>(db, 'SELECT * FROM api_keys WHERE tenant_id=? AND client_id=? ORDER BY created_at DESC', scope.tenantId, scope.clientId).map(view) };
}

/** Creates a key. The plaintext token is returned once and never stored. */
export function createKey(db: Db, scope: Scope, body: { name?: unknown; roles?: unknown; expiresInDays?: unknown; reason?: unknown }) {
  requireHuman(scope, 'create keys');
  requirePerm(scope, 'manage_api_keys');
  const name = String(body.name ?? '').trim();
  if (!/^[\w .-]{3,60}$/.test(name)) throw invalid('name must be 3-60 letters, digits, spaces, dots, dashes or underscores');
  const roles = body.roles;
  if (!Array.isArray(roles) || !roles.length || !roles.every((r) => typeof r === 'string')) throw invalid('roles must be a non-empty list');
  const uniq = [...new Set(roles as string[])] as Role[];
  const notKeyRole = uniq.filter((r) => !KEY_ROLES.includes(r));
  if (notKeyRole.length) throw invalid(`A key cannot hold: ${notKeyRole.join(', ')}`);
  const held = new Set(rolesOf(db, scope.userId, scope.tenantId, scope.clientId));
  const beyond = uniq.filter((r) => !held.has(r));
  if (beyond.length) throw new AppError(403, 'exceeds_grants', `A key cannot have roles you do not hold in this client: ${beyond.join(', ')}`);
  const days = body.expiresInDays === undefined ? DEFAULT_KEY_DAYS : Number(body.expiresInDays);
  if (!Number.isInteger(days) || days < 1 || days > MAX_KEY_DAYS) throw invalid(`expiresInDays must be 1-${MAX_KEY_DAYS}`);
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 10) throw invalid('A reason of at least 10 characters is required');
  const keyId = `key_${randomBytes(6).toString('hex')}`;
  const token = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(now().getTime() + days * 86_400_000).toISOString();
  return tx(db, () => {
    run(db, `INSERT INTO api_keys (tenant_id, client_id, key_id, name, token_sha256, token_prefix, roles, created_by, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, scope.tenantId, scope.clientId, keyId, name, sha256(token), token.slice(0, 10), JSON.stringify(uniq.sort()), scope.userId, nowIso(), expiresAt);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'api_key', objectId: keyId, eventType: 'api_key_created',
      details: { name, roles: uniq, expiresAt, reason, tokenSha256Prefix: sha256(token).slice(0, 12) } });
    return { key: view(one<KeyRow>(db, 'SELECT * FROM api_keys WHERE key_id=?', keyId)!), token, shownOnce: true };
  });
}

export function revokeKey(db: Db, scope: Scope, keyId: string, body: { reason?: unknown }) {
  requireHuman(scope, 'revoke keys');
  requirePerm(scope, 'manage_api_keys');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 10) throw invalid('A reason of at least 10 characters is required');
  return tx(db, () => {
    const r = one<KeyRow>(db, 'SELECT * FROM api_keys WHERE tenant_id=? AND client_id=? AND key_id=?', scope.tenantId, scope.clientId, keyId);
    if (!r) throw notFound('Key');
    if (r.revoked_at) throw new AppError(409, 'already_revoked', 'This key is already revoked');
    run(db, 'UPDATE api_keys SET revoked_at=?, revoked_by=?, revoke_reason=? WHERE key_id=?', nowIso(), scope.userId, reason, keyId);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'api_key', objectId: keyId, eventType: 'api_key_revoked', details: { reason } });
    return view(one<KeyRow>(db, 'SELECT * FROM api_keys WHERE key_id=?', keyId)!);
  });
}
