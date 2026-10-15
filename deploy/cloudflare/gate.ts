// Password gate for the hosted synthetic demo (ADR 0120). The demo uses development sign-in, so
// anyone who reaches the app can act as any demo user, including the supervisor who can open
// Connect providers. A visitor first enters DEMO_PASSWORD (a Worker secret) on a small form; the
// Worker then sets an HttpOnly cookie and lets requests through. A cookie is used rather than HTTP
// Basic auth because the app already uses the Authorization header for its own Bearer tokens.
// No DEMO_PASSWORD (or a short one) refuses everything.
// No imports: this file is unit-tested from the main repo with plain Node.

export const MIN_PASSWORD_LENGTH = 12;
export const GATE_COOKIE = 'ar_demo_gate';

export type GateResult = { ok: true } | { ok: false; status: 401 | 503; body: string };

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// Compares fixed-length digests so the time taken does not depend on where the inputs differ.
async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function configured(demoPassword: string | undefined): demoPassword is string {
  return !!demoPassword && demoPassword.length >= MIN_PASSWORD_LENGTH;
}

const LOCKED: GateResult = { ok: false, status: 503, body: `Demo is locked: set the DEMO_PASSWORD secret (at least ${MIN_PASSWORD_LENGTH} characters).` };

/** The cookie value for a password. Changing DEMO_PASSWORD signs everyone out. */
export async function gateToken(demoPassword: string): Promise<string> {
  return hex(await sha256(`ar-resolve-demo-gate:v1:${demoPassword}`));
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Is this request already through the gate? */
export async function checkGate(cookieHeader: string | null, demoPassword: string | undefined): Promise<GateResult> {
  if (!configured(demoPassword)) return LOCKED;
  const got = readCookie(cookieHeader, GATE_COOKIE);
  if (got && await same(got, await gateToken(demoPassword))) return { ok: true };
  return { ok: false, status: 401, body: 'Password required.' };
}

/** Checks a password typed into the gate form. */
export async function checkPassword(submitted: string, demoPassword: string | undefined): Promise<GateResult> {
  if (!configured(demoPassword)) return LOCKED;
  if (await same(submitted, demoPassword)) return { ok: true };
  return { ok: false, status: 401, body: 'Wrong password.' };
}
