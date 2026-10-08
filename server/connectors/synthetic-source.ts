// Mocked research adapter: returns synthetic EOB, eligibility, clearinghouse and
// PM records from fixtures/synthetic-cohort.json. Stands in for a read-only
// PM/EHR + 835/271 feed, which is Blocked until a design partner grants access.
import { readFileSync } from 'node:fs';
import type { EvidenceKind } from '../services/evidence.ts';

export interface SourceDocument { kind: EvidenceKind; title: string; source: string; effectiveAt: string; content: unknown }
export interface CallScript { ref: string; turns: [string, string, Record<string, unknown>?][] }

interface Cohort {
  tenants: { tenantId: string; name: string; clients: { clientId: string; name: string }[] }[];
  users: { userId: string; displayName: string; grants: [string, string, string][] }[];
  inventories: Record<string, string>;
  sources: Record<string, { documents: SourceDocument[]; call: CallScript | null }>;
  accounts: { client: string; externalId: string; expectedFirst: string; story: string }[];
}

let cache: Cohort | null = null;
export function cohort(): Cohort {
  cache ??= JSON.parse(readFileSync(new URL('../../fixtures/synthetic-cohort.json', import.meta.url), 'utf8')) as Cohort;
  return cache;
}

export function fetchDocuments(clientId: string, externalId: string): SourceDocument[] {
  return cohort().sources[`${clientId}/${externalId}`]?.documents ?? [];
}

export function callScript(clientId: string, externalId: string): CallScript | null {
  return cohort().sources[`${clientId}/${externalId}`]?.call ?? null;
}
