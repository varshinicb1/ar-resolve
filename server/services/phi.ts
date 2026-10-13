// Ported from clinic-receptionist src/phi.ts (same owner). Application-layer encryption for
// free text at rest (45 CFR 164.312(a)(2)(iv) is an addressable specification; this is a
// technical control, not a compliance claim).
//
// Formats:
//   "enc:v1:<base64 iv>:<base64 ciphertext||tag>"  the origin's format (one key, AR_PHI_KEY). Kept
//       readable forever; it is opened with the keyring entry "legacy".
//   "enc:v2:<key id>:<base64 iv>:<base64 ciphertext||tag>"  ADR 0080 keyring format. The key id is
//       bound as AES-GCM additional data, so a blob relabelled with another key id fails to open.
// AES-256-GCM with a fresh 96-bit IV per value. Values without a prefix are plaintext and pass
// through, so turning a key on does not break rows written before it.
//
// Keyring (ADR 0080): AR_PHI_KEYS="<id>:<base64>,<id>:<base64>" with AR_PHI_ACTIVE_KEY_ID naming the
// key new values are sealed with. AR_PHI_KEY alone is still accepted and acts as the key "legacy"
// (v1 format), so existing deployments behave exactly as before. Rotation: add a new key, make it
// active, run the re-encryption job (phi-keys.ts), then retire the old key once nothing uses it.
//
// Adapted for AR Resolve: node:crypto instead of WebCrypto, synchronous (node:sqlite is
// synchronous), keys read from the environment at call time.
// Generate a key with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const V1 = 'enc:v1:';
const V2 = 'enc:v2:';
export const LEGACY_KEY_ID = 'legacy';
const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class PhiKeyError extends Error {}

type Env = Record<string, string | undefined>;

export interface Keyring { activeId: string | null; keys: Map<string, Buffer> }

function decodeKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) throw new PhiKeyError(`${label} must be 32 bytes, base64-encoded`);
  return key;
}

/** Parses AR_PHI_KEY / AR_PHI_KEYS / AR_PHI_ACTIVE_KEY_ID. Throws PhiKeyError on any malformed entry. */
export function phiKeyring(env: Env = process.env): Keyring {
  const keys = new Map<string, Buffer>();
  for (const part of (env.AR_PHI_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    const id = i > 0 ? part.slice(0, i).trim() : '';
    if (!KEY_ID.test(id)) throw new PhiKeyError('AR_PHI_KEYS entries must be "<key id>:<base64 key>" with a key id of lowercase letters, digits, - or _');
    if (keys.has(id)) throw new PhiKeyError(`AR_PHI_KEYS lists key id ${id} twice`);
    keys.set(id, decodeKey(part.slice(i + 1), `AR_PHI_KEYS key ${id}`));
  }
  if (env.AR_PHI_KEY) {
    const legacy = decodeKey(env.AR_PHI_KEY, 'AR_PHI_KEY');
    const listed = keys.get(LEGACY_KEY_ID);
    if (listed && !listed.equals(legacy)) throw new PhiKeyError('AR_PHI_KEY differs from the "legacy" entry in AR_PHI_KEYS');
    keys.set(LEGACY_KEY_ID, legacy);
  }
  let activeId: string | null = null;
  if (env.AR_PHI_ACTIVE_KEY_ID) {
    activeId = env.AR_PHI_ACTIVE_KEY_ID.trim();
    if (!keys.has(activeId)) throw new PhiKeyError(`AR_PHI_ACTIVE_KEY_ID ${activeId} is not in the keyring`);
  } else if (keys.size === 1) {
    activeId = [...keys.keys()][0];
  } else if (keys.size > 1) {
    throw new PhiKeyError('Several PHI keys are configured; set AR_PHI_ACTIVE_KEY_ID to the one new values are sealed with');
  }
  return { activeId, keys };
}

/** The active key (new values are sealed with it), or null when sealing is off. */
export function phiKey(env: Env = process.env): Buffer | null {
  const r = phiKeyring(env);
  return r.activeId ? r.keys.get(r.activeId)! : null;
}

/** True when a valid key is configured (an invalid configuration counts as not configured). */
export function sealingEnabled(env: Env = process.env): boolean {
  try { return phiKey(env) !== null; } catch { return false; }
}

export function isSealed(v: unknown): v is string {
  return typeof v === 'string' && (v.startsWith(V1) || v.startsWith(V2));
}

/** The key id a sealed value was written with ("legacy" for v1), or null for plaintext. */
export function sealedKeyId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.startsWith(V1)) return LEGACY_KEY_ID;
  if (v.startsWith(V2)) return v.slice(V2.length).split(':')[0] || null;
  return null;
}

function encrypt(value: string, key: Buffer, aad: string | null): { iv: string; ct: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}

function decrypt(ivB64: string, ctB64: string, key: Buffer, aad: string | null): string {
  const buf = Buffer.from(ctB64 ?? '', 'base64');
  if (buf.length < 16) throw new PhiKeyError('Sealed value is truncated');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64 ?? '', 'base64'));
  if (aad) d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
}

/**
 * Encrypt when a key is configured; without one the value is stored as is (synthetic mode).
 * A Buffer argument seals with that key in the origin's v1 format; a Keyring (or the environment's
 * keyring by default) seals with its active key, v1 for "legacy" and v2 with the key id otherwise.
 */
export function seal(value: string, key?: Buffer | Keyring | null): string {
  if (key === null) return value;
  if (Buffer.isBuffer(key)) { const e = encrypt(value, key, null); return `${V1}${e.iv}:${e.ct}`; }
  const ring = key ?? phiKeyring();
  if (!ring.activeId) return value;
  const k = ring.keys.get(ring.activeId)!;
  if (ring.activeId === LEGACY_KEY_ID) { const e = encrypt(value, k, null); return `${V1}${e.iv}:${e.ct}`; }
  const e = encrypt(value, k, `${V2}${ring.activeId}`);
  return `${V2}${ring.activeId}:${e.iv}:${e.ct}`;
}

/** Decrypt a sealed value; plaintext passes through. A sealed value whose key is not configured cannot be read. */
export function open(value: string, key?: Buffer | Keyring | null): string {
  if (!isSealed(value)) return value;
  if (value.startsWith(V1)) {
    const k = Buffer.isBuffer(key) ? key : (key ?? phiKeyring()).keys.get(LEGACY_KEY_ID);
    if (!k) throw new PhiKeyError('Encrypted value (v1) but AR_PHI_KEY (the "legacy" key) is not configured');
    const [ivB64, ctB64] = value.slice(V1.length).split(':');
    return decrypt(ivB64, ctB64, k, null);
  }
  const [kid, ivB64, ctB64] = value.slice(V2.length).split(':');
  const k = Buffer.isBuffer(key) ? key : (key ?? phiKeyring()).keys.get(kid);
  if (!k) throw new PhiKeyError(`Encrypted value uses PHI key ${kid}, which is not in the keyring`);
  return decrypt(ivB64, ctB64, k, `${V2}${kid}`);
}

/** Nullable helpers for optional text columns. */
export const sealNullable = (v: string | null | undefined): string | null => (v === null || v === undefined ? null : seal(v));
export const openNullable = (v: string | null | undefined): string | null => (v === null || v === undefined ? null : open(v));
