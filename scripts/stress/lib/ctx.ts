import { readFileSync } from 'node:fs';
import { ROOT } from './proc.ts';

export type Mode = 'quick' | 'full';

export interface Ctx {
  mode: Mode;
  log: (...m: unknown[]) => void;
  metric: (key: string, value: unknown) => void;
  check: (name: string, pass: boolean, detail?: string) => void;
  note: (text: string) => void;
}

export interface Scenario { name: string; title: string; run: (ctx: Ctx) => Promise<void> }

export interface ScenarioResult {
  name: string; title: string; durationMs: number; metrics: Record<string, unknown>;
  checks: { name: string; pass: boolean; detail: string | null }[]; notes: string[]; error: string | null;
}

interface Cohort { inventories: Record<string, string> }
let cohortCache: Cohort | null = null;
/** The checked-in synthetic demo cohort (fixtures/synthetic-cohort.json). */
export function cohortInventory(clientId: string): string {
  cohortCache ??= JSON.parse(readFileSync(`${ROOT}fixtures/synthetic-cohort.json`, 'utf8')) as Cohort;
  return cohortCache.inventories[clientId];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when no response was a 5xx or a transport failure (reset, timeout, hang). */
export function cleanStatuses(statuses: Record<string, number>): boolean {
  return Object.keys(statuses).every((k) => !k.startsWith('5') && !k.startsWith('err:'));
}
