// FHIR R4 read-only client for Coverage, ExplanationOfBenefit, Claim, ClaimResponse and
// Patient (token only). No write interactions exist on this client.
import type { BackendTokenSource } from './smart.ts';

export const READ_TYPES = ['Coverage', 'ExplanationOfBenefit', 'Claim', 'ClaimResponse', 'Patient'] as const;
export type ReadType = (typeof READ_TYPES)[number];

export interface Bundle { resourceType: 'Bundle'; type: string; total?: number; entry?: { resource: FhirResource }[] }
export interface FhirResource { resourceType: string; id: string; [k: string]: unknown }

export class FhirError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class FhirReadClient {
  private base: string;
  private tokens: BackendTokenSource;
  constructor(baseUrl: string, tokens: BackendTokenSource) { this.base = baseUrl.replace(/\/$/, ''); this.tokens = tokens; }

  private async get(path: string): Promise<unknown> {
    const token = await this.tokens.get();
    const r = await fetch(`${this.base}/${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/fhir+json' } });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new FhirError(r.status, `FHIR ${path.split('?')[0]} failed with ${r.status}`);
    return body;
  }

  async read(type: ReadType, id: string): Promise<FhirResource> {
    if (!READ_TYPES.includes(type)) throw new FhirError(400, `Resource type ${type} is not readable by this client`);
    if (!/^[A-Za-z0-9\-.]{1,64}$/.test(id)) throw new FhirError(400, 'Invalid resource id');
    const res = (await this.get(`${type}/${id}`)) as FhirResource;
    if (res?.resourceType !== type) throw new FhirError(502, `Expected ${type}, received ${res?.resourceType}`);
    return type === 'Patient' ? patientToken(res) : res;
  }

  async search(type: ReadType, params: Record<string, string>): Promise<FhirResource[]> {
    if (!READ_TYPES.includes(type)) throw new FhirError(400, `Resource type ${type} is not readable by this client`);
    const b = (await this.get(`${type}?${new URLSearchParams(params)}`)) as Bundle;
    if (b?.resourceType !== 'Bundle') throw new FhirError(502, 'Search did not return a Bundle');
    return (b.entry ?? []).map((e) => e.resource).filter((r) => r?.resourceType === type).map((r) => (type === 'Patient' ? patientToken(r) : r));
  }
}

// Patient is reduced to its id and identifier values. Names, birth dates, addresses and
// telecom are discarded at the client boundary and never reach storage.
export function patientToken(p: FhirResource): FhirResource {
  const ids = Array.isArray(p.identifier) ? (p.identifier as { system?: string; value?: string }[]).map((i) => ({ system: i.system ?? null, value: i.value ?? null })) : [];
  return { resourceType: 'Patient', id: p.id, identifier: ids };
}
