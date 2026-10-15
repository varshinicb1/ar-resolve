// Structured JSON logs (ADR 0090). One line per event on stdout (errors on stderr).
//
// No PHI in logs, by construction and by redaction:
//   - request logs carry method, the matched route PATTERN (never the raw path or query string,
//     which can carry search terms), status, duration, request id and the principal id;
//   - any field whose name suggests patient, contact or credential content is replaced with
//     "[redacted]" at any depth; string values are scrubbed of bearer tokens, API keys, emails,
//     phone numbers, SSN-shaped and DOB-shaped values;
//   - error messages are scrubbed the same way; stacks are logged only in the synthetic environment.
// tests/production.test.ts proves the redaction on a PHI-shaped payload.

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|patient|member|subscriber|dob|birth|ssn|first[-_]?name|last[-_]?name|full[-_]?name|^name$|display[-_]?name|email|phone|address|street|zip|postal|note|text|body|transcript|summary|payload|rationale|answer|content|csv|id_token|code_verifier|nonce)/i;
const SCRUB: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\bark_[A-Za-z0-9_-]{8,}/g, 'ark_[redacted]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[jwt-redacted]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email-redacted]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn-redacted]'],
  [/\b(19|20)\d{2}-\d{2}-\d{2}\b(?!T)/g, '[date-redacted]'],
  [/\b\d{1,2}\/\d{1,2}\/(19|20)\d{2}\b/g, '[date-redacted]'],
  [/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone-redacted]'],
];

/** Keys that are known-safe even though they match a sensitive word (ids, counts, codes). */
const SAFE_KEYS = new Set(['requestId', 'userId', 'principal', 'route', 'method', 'status', 'durationMs', 'code', 'event', 'msg', 'level', 'ts', 'env', 'keyId', 'bodyBytes']);

export function scrubString(s: string): string {
  let out = s;
  for (const [re, rep] of SCRUB) out = out.replace(re, rep);
  return out.length > 2000 ? out.slice(0, 2000) + '…' : out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = !SAFE_KEYS.has(k) && SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export type Sink = (line: string, level: Level) => void;
const defaultSink: Sink = (line, level) => { (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n'); };

export function createLogger(opts: { level?: Level; sink?: Sink; base?: Record<string, unknown> } = {}): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const sink = opts.sink ?? defaultSink;
  const emit = (level: Level, event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < min) return;
    const rec = { ts: new Date().toISOString(), level, event, ...(opts.base ?? {}), ...(redact(fields) as Record<string, unknown>) };
    let line: string;
    try { line = JSON.stringify(rec); } catch { line = JSON.stringify({ ts: rec.ts, level, event, note: 'unserialisable fields dropped' }); }
    sink(line, level);
  };
  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

/** Error fields safe to log: name, scrubbed message, and the stack only when allowed. */
export function errorFields(err: unknown, withStack: boolean): Record<string, unknown> {
  const e = err as Error;
  return { errorName: e?.name ?? 'Error', errorMessage: scrubString(String(e?.message ?? err)).slice(0, 500), ...(withStack && e?.stack ? { stack: scrubString(e.stack) } : {}) };
}

// Library default (tests, scripts): warnings and errors only. main.ts / worker.ts install the configured level.
let shared: Logger = createLogger({ level: 'warn' });
export const log = (): Logger => shared;
export function setLogger(l: Logger): void { shared = l; }
