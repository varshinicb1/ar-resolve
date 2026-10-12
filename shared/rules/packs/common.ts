// Small deterministic helpers shared by the scenario logic modules.
import type { ChecklistItem, MapContext, RuleResult } from '../types.ts';

export const ABSTAIN = new Set(['collect_evidence', 'specialist_review']);

export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

export function result(outcome: string, reasonCodes: string[], missing: string[] = [], calculation: unknown = null, checklist?: ChecklistItem[]): RuleResult {
  const r: RuleResult = { outcome, abstained: ABSTAIN.has(outcome), reasonCodes, missing, calculation };
  if (checklist) r.checklist = checklist;
  return r;
}

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime()) / 86_400_000);
}

export function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// Comparison key for free-text document names. Free text is data: it is only ever
// compared, never interpreted.
export function normalizeLabel(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '';
}

// Identity, conflict and core-presence gate shared by every pack after DED01.
// Order matches DED01: identity failure, then conflict, then missing data.
export function gate(input: Record<string, unknown>, required: string[]): RuleResult | null {
  if (input.identityVerified === false) return result('collect_evidence', ['IDENTITY_NOT_VERIFIED'], ['identityVerified']);
  if (input.conflict) return result('specialist_review', ['SOURCE_CONFLICT']);
  const missing = required.filter((k) => isBlank(input[k]));
  if (missing.length) return result('collect_evidence', ['REQUIRED_FACT_MISSING'], missing);
  if (input.identityVerified !== true) return result('collect_evidence', ['IDENTITY_NOT_VERIFIED'], ['identityVerified']);
  return null;
}

// Conflict among the facts a pack actually reads (plus identity sources).
export function conflictAmong(ctx: MapContext, keys: string[]): boolean {
  return [...keys, 'claimReference', 'eobPatientToken', 'eobServiceDate'].some((k) => ctx.fact(k)?.status === 'conflicting');
}

export function readAll(ctx: MapContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rf of ctx.def.requiredFacts) out[rf.key] = ctx.usable(rf.key);
  return out;
}

export const COMMON_REASONS: Record<string, string> = {
  REQUIRED_FACT_MISSING: 'A required fact is missing or not usable',
  IDENTITY_NOT_VERIFIED: 'Claim identity is not verified',
  SOURCE_CONFLICT: 'Sources disagree on a material fact',
  RULE_SCOPE_MISMATCH: 'No compatible approved rule scope for this account',
};

export function makeReasonLabel(labels: Record<string, string>) {
  return (code: string): string => {
    const [base, detail] = code.split(':');
    if (base === 'DATE_INVALID') return `Date ${detail} is malformed or in the future`;
    if (base === 'VALUE_INVALID') return `Value ${detail} has an unrecognized type or value`;
    return labels[base] ?? COMMON_REASONS[base] ?? code;
  };
}
