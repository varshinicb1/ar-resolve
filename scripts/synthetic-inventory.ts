// Bulk SYNTHETIC inventory generator for load and stress testing (ADR 0095).
// Every identifier, date and amount is invented by a seeded PRNG. No PHI.
// Identifiers carry the synthetic markers the PHI ingest gate checks for (SYN?-, SYN?-C, PT-),
// with an "S" (stress) letter so they can never collide with the demo cohort:
//   external_id SYNS-<batch>-<n>   claim_reference SYNS-C<batch><n>   patient_token PT-S<hex>
//
// CLI:  node scripts/synthetic-inventory.ts <count> [batch] [seed] > inventory.csv
import { build835, type RemitClaim } from '../server/connectors/x12/responses.ts';

export const INVENTORY_HEADER = 'external_id,payer_id,provider_id,patient_token,service_date,claim_reference,claim_type,balance_cents,scenario';

export interface SyntheticAccount {
  externalId: string; payerId: string; providerId: string; patientToken: string; serviceDate: string;
  claimReference: string; claimType: string; balanceCents: number; scenario: string;
}

export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAYERS = ['demo-payer', 'syn-payer-b', 'syn-payer-c', 'syn-payer-d'];
const SCENARIOS = ['deductible', 'deductible', 'deductible', 'pending', 'denial', 'documentation', 'duplicate'];
const DAY = 86_400_000;

/** Deterministic synthetic accounts. Service dates fall 30-540 days before `asOf`. */
export function syntheticAccounts(count: number, opts: { batch?: string; seed?: number; asOf?: Date } = {}): SyntheticAccount[] {
  const batch = (opts.batch ?? 'B1').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'B1';
  const rnd = prng(opts.seed ?? 42);
  const asOf = (opts.asOf ?? new Date()).getTime();
  const width = Math.max(6, String(count).length);
  const out: SyntheticAccount[] = [];
  for (let i = 1; i <= count; i++) {
    const n = String(i).padStart(width, '0');
    const dos = new Date(asOf - (30 + Math.floor(rnd() * 510)) * DAY).toISOString().slice(0, 10);
    out.push({
      externalId: `SYNS-${batch}-${n}`, payerId: PAYERS[Math.floor(rnd() * PAYERS.length)], providerId: `PRV-SYN-0${1 + Math.floor(rnd() * 4)}`,
      patientToken: `PT-S${Math.floor(rnd() * 0xffffff).toString(16).toUpperCase().padStart(6, '0')}${n}`, serviceDate: dos,
      claimReference: `SYNS-C${batch}${n}`, claimType: rnd() < 0.85 ? 'professional' : 'institutional',
      balanceCents: 2500 + Math.floor(rnd() * 500_000), scenario: SCENARIOS[Math.floor(rnd() * SCENARIOS.length)],
    });
  }
  return out;
}

export function toCsv(accounts: SyntheticAccount[]): string {
  return INVENTORY_HEADER + '\n' + accounts.map((a) => [a.externalId, a.payerId, a.providerId, a.patientToken, a.serviceDate, a.claimReference,
    a.claimType, a.balanceCents, a.scenario].join(',')).join('\n') + '\n';
}

/** Splits an inventory into CSV parts no larger than maxBytes each, every part with the header. */
export function chunkCsv(accounts: SyntheticAccount[], maxBytes: number): string[] {
  const parts: string[] = [];
  let rows: string[] = [];
  let size = INVENTORY_HEADER.length + 1;
  for (const line of toCsv(accounts).trim().split('\n').slice(1)) {
    if (rows.length && size + line.length + 1 > maxBytes) { parts.push(INVENTORY_HEADER + '\n' + rows.join('\n') + '\n'); rows = []; size = INVENTORY_HEADER.length + 1; }
    rows.push(line);
    size += line.length + 1;
  }
  if (rows.length) parts.push(INVENTORY_HEADER + '\n' + rows.join('\n') + '\n');
  return parts;
}

/** A synthetic 835 remittance with one CLP per account (one SVC line each). */
export function synthetic835(accounts: SyntheticAccount[], control = 900000001): string {
  const claims: RemitClaim[] = accounts.map((a, i) => {
    const pr = Math.min(a.balanceCents, 2500);
    return { claimId: a.claimReference, status: '1', chargeCents: a.balanceCents + 7500, paidCents: a.balanceCents - pr, patientRespCents: pr,
      payerControlNumber: `SYNSPCN${i}`, patient: { last: 'SYNTHETIC', first: 'PATIENT', memberId: a.patientToken },
      lines: [{ procedure: 'SYNPROC1', chargeCents: a.balanceCents + 7500, paidCents: a.balanceCents - pr, serviceDate: a.serviceDate, allowedCents: a.balanceCents,
        adjustments: [{ group: 'CO', triplets: [['45', 7500]] }, { group: 'PR', triplets: [['1', pr]] }] }] };
  });
  const paid = claims.reduce((s, c) => s + c.paidCents, 0);
  return build835({ sender: 'DEMOPAYER', receiver: 'SYNTHPROV', control, at: new Date('2026-09-01T10:00:00Z'), payer: { name: 'DEMO PAYER A', id: 'DEMOPAYER' },
    payee: { name: 'SYNTHETIC PROVIDER', id: 'PRV-SYN-01' }, paymentCents: paid, paymentDate: '2026-09-01', trace: `SYNSTRACE${control}`, productionDate: '2026-09-01', claims });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const count = Number(process.argv[2] ?? 1000);
  if (!Number.isInteger(count) || count < 1 || count > 1_000_000) { console.error('usage: node scripts/synthetic-inventory.ts <count 1..1000000> [batch] [seed]'); process.exit(2); }
  process.stdout.write(toCsv(syntheticAccounts(count, { batch: process.argv[3], seed: Number(process.argv[4] ?? 42) })));
}
