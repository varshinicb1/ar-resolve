// Seeded random mutation of text fixtures (CSV and X12) for robustness fuzzing.
import { prng } from '../../synthetic-inventory.ts';

const HOSTILE = ['~', '*', ':', '^', '\n', '\r\n', ',', '"', "'", '\u0000', '￿', '\uD800', '‮', '😀', '%s', '${x}', '<script>', 'ISA', 'IEA*1*', 'SE*', '-1', '99999999999999999999', 'NaN', '\\'];

export function mutate(text: string, seed: number): string {
  const r = prng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  let s = text;
  const ops = 1 + Math.floor(r() * 6);
  for (let k = 0; k < ops; k++) {
    const at = Math.floor(r() * (s.length + 1));
    switch (Math.floor(r() * 9)) {
      case 0: s = s.slice(0, at) + pick(HOSTILE) + s.slice(at); break; // insert hostile token
      case 1: s = s.slice(0, at) + s.slice(at + 1 + Math.floor(r() * 20)); break; // delete a run
      case 2: { const len = Math.floor(r() * 200); s = s.slice(0, at) + s.slice(at, at + len).repeat(1 + Math.floor(r() * 50)) + s.slice(at + len); break; } // duplicate a run
      case 3: s = s.slice(0, Math.max(1, at)); break; // truncate
      case 4: s = s.slice(0, at) + String.fromCharCode(Math.floor(r() * 0x10000)) + s.slice(at + 1); break; // replace a char
      case 5: { const lines = s.split(/(?<=~|\n)/); const i = Math.floor(r() * lines.length); const j = Math.floor(r() * lines.length); [lines[i], lines[j]] = [lines[j], lines[i]]; s = lines.join(''); break; } // swap segments/rows
      case 6: s = s.slice(0, at) + pick(HOSTILE).repeat(1 + Math.floor(r() * 2000)) + s.slice(at); break; // long hostile run
      case 7: s = s.replace(/\d/g, (d) => (r() < 0.05 ? pick(['-', '.', 'E', '9'.repeat(30)]) : d)); break; // corrupt numbers
      default: s = s.split('').reverse().join('').slice(0, 300) + s; break; // garbage prefix
    }
  }
  return s;
}

/** Deeply nested JSON text: [[[[...]]]] of the given depth, as a field value. */
export function nested(depth: number, key = 'value'): string {
  return `{"${key}":${'['.repeat(depth)}${']'.repeat(depth)},"reason":"stress nested input","expectedRevision":1}`;
}

export function nestedObject(depth: number): string {
  return `{"value":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)},"reason":"stress nested input","expectedRevision":1}`;
}
