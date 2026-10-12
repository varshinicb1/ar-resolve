// Deterministic extraction from representative turns (no model). Transcript
// text is untrusted evidence: these functions only return typed values and
// flags. Nothing here can change state, permissions or actions; the engine
// decides what to do with a typed value according to the question plan.

export const EXTRACTOR_VERSION = 'voice-extract.v1';

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALE: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };

// Reference-like tokens (claim numbers, call references) are removed before
// amount parsing so "SYN-C1045" never becomes $1,045.
const REF_TOKEN = /\b[A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+)+\b/g;

function wordsToNumber(words: string[]): number | null {
  let total = 0;
  let current = 0;
  let any = false;
  for (const w of words) {
    if (w === 'and') continue;
    if (w in SMALL) { current += SMALL[w]; any = true; continue; }
    if (w === 'hundred') { current = (current || 1) * 100; any = true; continue; }
    if (w in SCALE) { total += (current || 1) * SCALE[w]; current = 0; any = true; continue; }
    return null;
  }
  return any ? total + current : null;
}

export interface MoneyMatch { cents: number; text: string; index: number }

// Finds monetary amounts written as digits ($1,200.00, 1200 dollars) or words
// ("one thousand two hundred dollars", "... and fifty cents"). Integer cents.
export function findMoney(text: string): MoneyMatch[] {
  const clean = text.replace(REF_TOKEN, (m) => ' '.repeat(m.length));
  const out: MoneyMatch[] = [];
  const digit = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?|\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?\s*dollars?\b/gi;
  for (const m of clean.matchAll(digit)) {
    const whole = (m[1] ?? m[3]).replace(/,/g, '');
    const cents = Number(whole) * 100 + Number(m[2] ?? m[4] ?? 0);
    out.push({ cents, text: m[0].trim(), index: m.index ?? 0 });
  }
  const vocab = [...Object.keys(SMALL), ...Object.keys(SCALE), 'and'].join('|');
  const wordsRe = new RegExp(`\\b((?:(?:${vocab})[\\s-]+)*(?:${vocab}))\\s+dollars?(?:\\s+and\\s+((?:(?:${vocab})[\\s-]+)*(?:${vocab}))\\s+cents?)?`, 'gi');
  for (const m of clean.matchAll(wordsRe)) {
    const dollars = wordsToNumber(m[1].toLowerCase().split(/[\s-]+/).filter(Boolean));
    if (dollars === null) continue;
    const c = m[2] ? wordsToNumber(m[2].toLowerCase().split(/[\s-]+/).filter(Boolean)) : 0;
    if (c === null || c > 99) continue;
    out.push({ cents: dollars * 100 + c, text: m[0].trim(), index: m.index ?? 0 });
  }
  return out.sort((a, b) => a.index - b.index);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export interface DateMatch { iso: string | null; partial: string; yearMissing: boolean }

// ISO, US numeric and "Month D, YYYY". A date without a year is never completed
// with a guessed year; it is returned with yearMissing so the verifier flags it.
export function findDate(text: string): DateMatch | null {
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return valid(+m[1], +m[2], +m[3], m[0]);
  m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) return valid(+m[3], +m[1], +m[2], m[0]);
  const re = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i');
  m = text.match(re);
  if (m) {
    const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    if (!m[3]) return { iso: null, partial: m[0], yearMissing: true };
    return valid(+m[3], month, +m[2], m[0]);
  }
  return null;
}

function valid(y: number, mo: number, d: number, raw: string): DateMatch | null {
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
  return { iso, partial: raw, yearMissing: false };
}

// Reference numbers are taken only after an explicit cue word; a bare token is
// not assumed to be a reference. The claim reference format is excluded.
export function findReference(text: string): string | null {
  const re = /\b(?:reference|ref|confirmation|request|ticket)\s*(?:number|no\.?|id|#)?\s*(?:is|:)?\s*((?=[A-Z0-9-]*[\d-])[A-Z0-9][A-Z0-9-]{3,})\b/gi;
  for (const m of text.matchAll(re)) {
    const token = m[1].toUpperCase();
    if (/^[A-Z]{2,6}-C\d+$/.test(token)) continue; // a claim number is not a call/request reference
    return token;
  }
  return null;
}

export function findClaimReferences(text: string): string[] {
  return [...text.matchAll(/\b[A-Z]{2,6}-C\d{3,}\b/g)].map((m) => m[0]);
}

export function findAdjustmentGroup(text: string): 'PR' | 'CO' | 'OA' | 'PI' | null {
  if (/\bpatient responsibility\b|\bgroup (?:code )?PR\b|\bPR\b/i.test(text)) return 'PR';
  if (/\bcontractual obligation\b|\bgroup (?:code )?CO\b|\bCO\b/.test(text)) return 'CO';
  if (/\bother adjustment\b|\bOA\b/.test(text)) return 'OA';
  if (/\bpayer initiated\b|\bPI\b/.test(text)) return 'PI';
  return null;
}

export function findCrossover(text: string): 'crossed' | 'not_crossed' | null {
  if (/\b(not|hasn't|has not|wasn't|was not|never)\b[^.]*\b(cross(ed)? over|forwarded|crossed)\b/i.test(text)) return 'not_crossed';
  if (/\b(crossed over|was forwarded|has been forwarded|did cross)\b/i.test(text)) return 'crossed';
  return null;
}

export interface TurnaroundCommitment { value: number; unit: 'days' | 'weeks' | 'months'; basis: 'business' | 'calendar' | 'unspecified'; text: string }

export function findTurnaround(text: string): TurnaroundCommitment | null {
  const m = text.match(/\b(?:within|in|about|up to)\s+(\d{1,3}|[a-z-]+)\s+(business|working|calendar)?\s*(days?|weeks?|months?)\b/i);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : wordsToNumber(m[1].toLowerCase().split('-'));
  if (n === null) return null;
  const unit = m[3].toLowerCase().startsWith('day') ? 'days' : m[3].toLowerCase().startsWith('week') ? 'weeks' : 'months';
  const basis = !m[2] ? 'unspecified' : /business|working/i.test(m[2]) ? 'business' : 'calendar';
  return { value: n, unit, basis, text: m[0] };
}

export const isConfirmation = (t: string) => /^\s*(yes|yeah|correct|that'?s (right|correct)|that is (right|correct)|right)\b/i.test(t);
export const isNegation = (t: string) => /^\s*(no|nope|that'?s not (right|correct)|that is not (right|correct)|actually)\b/i.test(t);
export const isRefusal = (t: string) => /\b(not able to|unable to|can(?:no|')t|won'?t|not allowed to|not permitted to)\s+(give|provide|share|release|disclose)\b/i.test(t);
export const isUnknown = (t: string) => /\b(don'?t|do not|can(?:no|')t|cannot)\s+(have|see|tell|find)\b|\bnot available\b|\bonly (?:see|have)\b|\bno record\b/i.test(t);

// Qualifiers that make an accumulator figure a running total rather than the
// amount met before this claim at adjudication (docs/05 deductible call flow).
export const ACCUMULATOR_TIMING = /\b(to date|so far|as of today|as of now|currently|right now|year[- ]to[- ]date|at this time|today'?s total|current total)\b/i;
export const BEFORE_CLAIM = /\bbefore (?:this|the) claim\b|\bprior to (?:this|the) claim\b|\bat (?:the time of )?adjudication\b/i;

// Text that reads like an instruction to the system. It is flagged and stored;
// it never alters behaviour. Detection is for reviewer visibility only — the
// containment is that transcript text has no path to actions or permissions.
const INSTRUCTION_LIKE = /\b(ignore (?:all |any |your )?(?:previous|prior|above) instructions|disregard (?:your|the) (?:rules|instructions)|system prompt|you are now|as an ai|approve (?:a |the )?(?:full )?(?:write[- ]?off|payment|refund|request)|write[- ]?off|grant (?:\w+ )?(?:access|role|permission)|mark (?:this|the) (?:account|claim) (?:as )?(?:paid|resolved|closed)|change the (?:code|balance))\b/i;
export const isInstructionLike = (t: string) => INSTRUCTION_LIKE.test(t);

export const isAcceptance = (t: string) => /\b(i(?:'ve| have) (?:opened|submitted|created|sent) (?:a |the )?(?:reprocessing|reconsideration|review) request|request (?:is|has been) (?:opened|submitted|created))\b/i.test(t);
export const isAgreeToLook = (t: string) => /\b(i(?:'ll| will) (?:take a look|look into|send it for review|have someone look))\b/i.test(t);

export function speakMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function spellReference(ref: string): string {
  return ref.split('').map((c) => (c === '-' ? 'dash' : c)).join(' ');
}
