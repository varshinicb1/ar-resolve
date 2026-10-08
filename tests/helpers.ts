import type { AddressInfo } from 'node:net';
import { openDb, type Db } from '../server/db/db.ts';
import { seed } from '../server/services/seed.ts';
import { createApp } from '../server/http/app.ts';
import { cohort } from '../server/connectors/synthetic-source.ts';

export interface Harness {
  db: Db;
  base: string;
  close: () => Promise<void>;
  as: (userId: string, tenantId?: string, clientId?: string) => Promise<Client>;
}

export interface Client {
  get: (path: string) => Promise<{ status: number; body: any }>;
  post: (path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  token: string;
}

export async function start(dbPath = ':memory:'): Promise<Harness> {
  const db = openDb(dbPath);
  seed(db);
  const server = createApp(db);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = async (userId: string, tenantId = 'tn_demo', clientId = 'cl_ortho'): Promise<Client> => {
    const login = await fetch(`${base}/api/dev/login`, { method: 'POST', body: JSON.stringify({ userId }) });
    const { token } = (await login.json()) as { token: string };
    const headers = { authorization: `Bearer ${token}`, 'x-tenant': tenantId, 'x-client': clientId, 'content-type': 'application/json' };
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    return { token, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) };
  };
  return { db, base, as, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}

export async function importCohort(c: Client, clientId = 'cl_ortho') {
  const csv = cohort().inventories[clientId];
  const r = await c.post('/api/imports', { sourceName: `${clientId}.csv`, csv });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body;
}

export async function accountByExt(c: Client, ext: string): Promise<string> {
  const r = await c.get(`/api/accounts?q=${encodeURIComponent(ext)}`);
  const item = r.body.items.find((i: any) => i.externalId === ext);
  if (!item) throw new Error(`no account ${ext}: ${JSON.stringify(r.body)}`);
  return item.accountId;
}
