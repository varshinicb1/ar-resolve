-- ADR 0090: production hardening. Cookie sessions for single sign-on, OIDC login transactions,
-- the admin-managed IdP-to-user link table and a deployment-level authentication event log.

-- Browser sessions created by OIDC sign-in. Only an HMAC of the cookie value is stored.
-- Idle and absolute expiry are both enforced by the server (web-sessions.ts). The CSRF token is
-- derived from the cookie value with the session secret, so it is never stored.
CREATE TABLE web_sessions (
  session_hmac TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE INDEX web_sessions_user ON web_sessions (user_id);

-- One row per started sign-in: state (hashed), nonce and PKCE verifier. Consumed exactly once.
CREATE TABLE oidc_login_states (
  state_sha256 TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Admin-managed mapping from an IdP identity to an AR Resolve user. Sign-in never creates users
-- or grants: an identity with no active link is refused. A link may be pre-registered by email
-- (subject NULL) and is bound to the IdP subject on first sign-in, only if the IdP asserts
-- email_verified=true.
CREATE TABLE sso_identities (
  link_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT,
  email TEXT,
  user_id TEXT NOT NULL REFERENCES users,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  bound_at TEXT,
  disabled_at TEXT,
  disabled_by TEXT,
  CHECK (subject IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX sso_identities_subject ON sso_identities (issuer, subject) WHERE subject IS NOT NULL;
CREATE UNIQUE INDEX sso_identities_email ON sso_identities (issuer, lower(email)) WHERE subject IS NULL AND disabled_at IS NULL;

-- Deployment-level authentication events (sign-in, refusal, logout, admin link changes). Holds no
-- PHI: user ids, IdP issuer, a hash of the subject and a reason code. Append-only.
CREATE TABLE auth_events (
  event_id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  user_id TEXT,
  issuer TEXT,
  subject_sha256 TEXT,
  actor TEXT NOT NULL,
  details TEXT NOT NULL
);
CREATE TRIGGER auth_events_no_update BEFORE UPDATE ON auth_events BEGIN SELECT RAISE(ABORT, 'auth_events is append-only'); END;
CREATE TRIGGER auth_events_no_delete BEFORE DELETE ON auth_events BEGIN SELECT RAISE(ABORT, 'auth_events is append-only'); END;

-- Backups taken by the scheduler or the backup script (file name, size, digest, key id).
CREATE TABLE backup_runs (
  backup_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  file_name TEXT,
  bytes INTEGER,
  sha256 TEXT,
  encrypted_with TEXT,
  pages INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  error TEXT
);
