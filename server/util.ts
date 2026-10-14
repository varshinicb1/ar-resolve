import { createHash, randomBytes } from 'node:crypto';

// Stable JSON: object keys sorted recursively, so the same payload always hashes the same.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

// Identifiers draw from a pre-filled CSPRNG pool (ADR 0095): one randomBytes() call per id
// was a fifth of bulk-import CPU. Ids are unique, not secret; newToken() stays unpooled.
let idPool = Buffer.alloc(0);
let idOffset = 0;
export function newId(prefix: string): string {
  if (idOffset + 9 > idPool.length) { idPool = randomBytes(9 * 1024); idOffset = 0; }
  idOffset += 9;
  return `${prefix}_${idPool.toString('base64url', idOffset - 9, idOffset)}`;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

let clockOverride: (() => Date) | null = null;
export function setClock(fn: (() => Date) | null): void {
  clockOverride = fn;
}
export function now(): Date {
  return clockOverride ? clockOverride() : new Date();
}
export function nowIso(): string {
  return now().toISOString();
}

export class AppError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const forbidden = (msg: string) => new AppError(403, 'forbidden', msg);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
export const invalid = (msg: string, details?: unknown) => new AppError(400, 'invalid_request', msg, details);
