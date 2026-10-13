// Ported from clinic-receptionist src/fhir.ts safeFhirBase (same owner). Admin-supplied outbound
// URLs (FHIR bases, notification webhooks) must be public https endpoints: no credentials in the
// URL, no localhost, no internal names, no IP literals in private, loopback, link-local or CGNAT
// ranges, and IPv6 literals are refused rather than classified.
//
// Adapted for AR Resolve: the local mock FHIR server runs on 127.0.0.1, so callers may pass
// allowLoopback for simulator connectors only. Live connectors never do.
export function safePublicHttpsUrl(raw: string, opts: { allowLoopback?: boolean } = {}): string | null {
  let u: URL;
  try { u = new URL(String(raw ?? '').trim()); } catch { return null; }
  if (u.username || u.password) return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (opts.allowLoopback && (h === '127.0.0.1' || h === 'localhost') && (u.protocol === 'http:' || u.protocol === 'https:')) return u.toString().replace(/\/$/, '');
  if (u.protocol !== 'https:') return null;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || !h.includes('.')) return null;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null;
  }
  if (h.includes(':')) return null;
  return u.toString().replace(/\/$/, '');
}
