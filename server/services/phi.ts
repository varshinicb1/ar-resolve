// Ported from clinic-receptionist src/phi.ts (same owner). Application-layer encryption for
// free text at rest (45 CFR 164.312(a)(2)(iv) is an addressable specification; this is a
// technical control, not a compliance claim).
//
// Format (unchanged from the origin, so values are interchangeable): "enc:v1:<base64 iv>:<base64
// ciphertext||tag>", AES-256-GCM with a fresh 96-bit IV per value. Values without the prefix are
// plaintext and pass through, so turning the key on does not break rows written before it.
//
// Adapted for AR Resolve: node:crypto instead of WebCrypto, synchronous (node:sqlite is
// synchronous), and the key comes from AR_PHI_KEY (32 random bytes, base64) read at call time.
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

export class PhiKeyError extends Error {}

export function phiKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.AR_PHI_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new PhiKeyError('AR_PHI_KEY must be 32 bytes, base64-encoded');
  return key;
}

/** True when a valid key is configured (an invalid key counts as not configured). */
export function sealingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  try { return phiKey(env) !== null; } catch { return false; }
}

export function isSealed(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

/** Encrypt when a key is configured; without one the value is stored as is (synthetic mode). */
export function seal(value: string, key: Buffer | null = phiKey()): string {
  if (!key) return value;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final(), c.getAuthTag()]);
  return `${PREFIX}${iv.toString('base64')}:${ct.toString('base64')}`;
}

/** Decrypt a sealed value; plaintext passes through. A sealed value without the key cannot be read. */
export function open(value: string, key: Buffer | null = phiKey()): string {
  if (!isSealed(value)) return value;
  if (!key) throw new PhiKeyError('Encrypted value but AR_PHI_KEY is not configured');
  const [ivB64, ctB64] = value.slice(PREFIX.length).split(':');
  const buf = Buffer.from(ctB64 ?? '', 'base64');
  if (buf.length < 16) throw new PhiKeyError('Sealed value is truncated');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64 ?? '', 'base64'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
}

/** Nullable helpers for optional text columns. */
export const sealNullable = (v: string | null | undefined): string | null => (v === null || v === undefined ? null : seal(v));
export const openNullable = (v: string | null | undefined): string | null => (v === null || v === undefined ? null : open(v));
