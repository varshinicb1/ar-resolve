export interface ApiError { status: number; code: string; message: string; details: unknown }

const store = {
  get(k: string) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

export const session = {
  token: store.get('ar.token'),
  tenantId: store.get('ar.tenant'),
  clientId: store.get('ar.client'),
  setToken(t: string | null) { this.token = t; store.set('ar.token', t); },
  setScope(tenantId: string, clientId: string) { this.tenantId = tenantId; this.clientId = clientId; store.set('ar.tenant', tenantId); store.set('ar.client', clientId); },
  /** CSRF token of a single sign-on cookie session (ADR 0090); kept in memory only. */
  csrf: null as string | null,
  clear() { this.setToken(null); this.csrf = null; this.tenantId = null; this.clientId = null; store.set('ar.tenant', null); store.set('ar.client', null); },
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  else if (session.csrf && method !== 'GET') headers['x-csrf-token'] = session.csrf;
  if (session.tenantId && session.clientId) { headers['x-tenant'] = session.tenantId; headers['x-client'] = session.clientId; }
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = (json as { error?: { code: string; message: string; details: unknown } }).error;
    throw { status: r.status, code: e?.code ?? 'error', message: e?.message ?? r.statusText, details: e?.details ?? null } satisfies ApiError;
  }
  return json as T;
}

export const api = {
  get: <T,>(p: string) => call<T>('GET', p),
  post: <T,>(p: string, b: unknown = {}) => call<T>('POST', p, b),
  put: <T,>(p: string, b: unknown = {}) => call<T>('PUT', p, b),
};

export function money(cents: unknown): string {
  if (typeof cents !== 'number') return '—';
  return (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function errorText(e: unknown): string {
  const err = e as ApiError;
  return err?.message ?? String(e);
}
