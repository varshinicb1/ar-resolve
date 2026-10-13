// Ported from clinic-receptionist src/spoken.ts (same owner), with the phrasing approach of its
// src/humanlike.ts (speakPhoneNumbers: groups with a breath between) and src/lang.ts (spokenWhen:
// dates the way a person says them).
//
// The origin works in one direction: speech recognition writes numbers as words ("September twenty
// third nineteen ninety seven") and spokenDatesToDigits turns them back into digits for the parsers.
// AR Resolve needs both directions (ADR 0080):
//   - read-back (agent -> payer representative): dollar amounts, dates and alphanumeric references
//     in words, so text-to-speech cannot misread "$425.00" or swallow a letter in a reference:
//       speakDollars(42500)      "four hundred twenty-five dollars and zero cents"
//       speakReference("RQ-88")  "R, Q, dash, eight, eight"
//       speakIsoDate("2026-10-30") "October thirtieth, two thousand twenty-six"
//   - screening (the Guard): spoken digits and dates turned back into digits, so identifier shapes
//     and unsourced-date checks still see what is said in words (digitWordsToDigits and the ported
//     spokenDatesToDigits).
// Pure functions; tested in tests/maya-followups.test.ts.

// ---------------------------------------------------------------- word tables (from the origin)

const UNITS: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORD_UNITS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9 };
const ORD_TEENS: Record<string, number> = { tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19 };
const ORD_TENS: Record<string, number> = { twentieth: 20, thirtieth: 30 };
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const W = (o: Record<string, number>) => Object.keys(o).join('|');
const invert = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'oh').map(([k, v]) => [v, k])) as Record<number, string>;
const UNIT_WORD = invert(UNITS);
const TEEN_WORD = invert(TEENS);
const TENS_WORD = invert(TENS);
const ORD_WORD: Record<number, string> = { ...invert(ORD_UNITS), ...invert(ORD_TEENS), ...invert(ORD_TENS) };

// ---------------------------------------------------------------- numbers to words (read-back)

function under100(n: number): string {
  if (n < 10) return UNIT_WORD[n];
  if (n < 20) return TEEN_WORD[n];
  const t = Math.floor(n / 10) * 10;
  return n % 10 ? `${TENS_WORD[t]}-${UNIT_WORD[n % 10]}` : TENS_WORD[t];
}

function under1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${UNIT_WORD[h]} hundred` : '', r || !h ? under100(r) : ''].filter(Boolean).join(' ');
}

/** 425 -> "four hundred twenty-five"; 1200000 -> "one million two hundred thousand". Whole numbers 0..999,999,999,999. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999_999) throw new RangeError('numberToWords takes a whole number from 0 to 999,999,999,999');
  if (n === 0) return 'zero';
  const parts: string[] = [];
  for (const [size, name] of [[1_000_000_000, 'billion'], [1_000_000, 'million'], [1_000, 'thousand'], [1, '']] as const) {
    const chunk = Math.floor(n / size) % 1000;
    if (chunk) parts.push(name ? `${under1000(chunk)} ${name}` : under1000(chunk));
  }
  return parts.join(' ');
}

/** 42500 -> "four hundred twenty-five dollars and zero cents"; 101 -> "one dollar and one cent". */
export function speakDollars(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError('speakDollars takes a non-negative whole number of cents');
  const d = Math.floor(cents / 100);
  const c = cents % 100;
  return `${numberToWords(d)} ${d === 1 ? 'dollar' : 'dollars'} and ${numberToWords(c)} ${c === 1 ? 'cent' : 'cents'}`;
}

/** 30 -> "thirtieth", 23 -> "twenty-third". */
export function ordinalWords(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 31) throw new RangeError('ordinalWords takes a day of the month');
  if (ORD_WORD[n]) return ORD_WORD[n];
  const t = Math.floor(n / 10) * 10;
  return `${TENS_WORD[t]}-${ORD_WORD[n % 10]}`;
}

/** 2026 -> "two thousand twenty-six", 1997 -> "nineteen ninety-seven", 2000 -> "two thousand". */
export function yearWords(y: number): string {
  if (!Number.isInteger(y) || y < 1000 || y > 2999) throw new RangeError('yearWords takes a four-digit year');
  if (y >= 2000 && y < 2100) return y === 2000 ? 'two thousand' : `two thousand ${under100(y - 2000)}`;
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  return lo === 0 ? `${under100(hi)} hundred` : lo < 10 ? `${under100(hi)} oh ${UNIT_WORD[lo]}` : `${under100(hi)} ${under100(lo)}`;
}

/** "2026-10-30" -> "October thirtieth, two thousand twenty-six". Invalid input comes back unchanged. */
export function speakIsoDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return iso;
  return `${MONTH_NAMES[+m[2] - 1]} ${ordinalWords(+m[3])}, ${yearWords(+m[1])}`;
}

/**
 * Alphanumeric reference the way a person reads it back: every character on its own, digits as words
 * ("zero", never "oh", so it cannot be heard as the letter O), groups split at dashes with a pause.
 * "RQ-88" -> "R, Q, dash, eight, eight".
 */
export function speakReference(ref: string): string {
  return ref.trim().toUpperCase().split('-').filter((g) => g.length)
    .map((g) => [...g].filter((ch) => /[A-Z0-9]/.test(ch)).map((ch) => (/\d/.test(ch) ? UNIT_WORD[+ch] : ch)).join(', '))
    .join(', dash, ');
}

// ---------------------------------------------------------------- words to digits (screening)

const DIGIT_WORD = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)';

/** Runs of two or more single spoken digits ("one two three", "eight, eight") become digits ("123", "88"). */
export function digitWordsToDigits(text: string): string {
  return text.replace(new RegExp(`\\b${DIGIT_WORD}(?:[\\s,]+${DIGIT_WORD})+\\b`, 'gi'), (run) =>
    run.split(/[\s,]+/).filter(Boolean).map((w) => String(UNITS[w.toLowerCase()])).join(''));
}

/** "twenty third" -> 23, "first" -> 1, "twenty" -> 20, "12" -> 12; null when it is not a day number. (origin) */
function dayValue(phrase: string): number | null {
  const p = phrase.trim().replace(/-/g, ' ').split(/\s+/);
  if (p.length === 1 && /^\d{1,2}(st|nd|rd|th)?$/.test(p[0])) return Number(p[0].replace(/\D/g, ''));
  if (p.length === 1) return ORD_UNITS[p[0]] ?? ORD_TEENS[p[0]] ?? ORD_TENS[p[0]] ?? UNITS[p[0]] ?? TEENS[p[0]] ?? TENS[p[0]] ?? null;
  if (p.length === 2 && TENS[p[0]] !== undefined) {
    const u = ORD_UNITS[p[1]] ?? UNITS[p[1]];
    return u === undefined ? null : TENS[p[0]] + u;
  }
  return null;
}

/** "nineteen ninety seven" -> 1997, "two thousand five" -> 2005, "twenty twenty" -> 2020. (origin) */
function yearValue(phrase: string): number | null {
  const p = phrase.trim().replace(/-/g, ' ').replace(/\band\b/g, ' ').split(/\s+/).filter(Boolean);
  if (p[0] === 'two' && p[1] === 'thousand') {
    const rest = p.slice(2);
    if (!rest.length) return 2000;
    const n = rest.length === 1 ? (UNITS[rest[0]] ?? TEENS[rest[0]] ?? TENS[rest[0]]) : TENS[rest[0]] !== undefined && UNITS[rest[1]] !== undefined ? TENS[rest[0]] + UNITS[rest[1]] : undefined;
    return n === undefined ? null : 2000 + n;
  }
  const century = TEENS[p[0]] ?? (p[0] === 'twenty' ? 20 : undefined);
  if (century === undefined || (century !== 19 && century !== 20) || p.length < 2) return null;
  const rest = p.slice(1);
  let n: number | undefined;
  if (rest.length === 1) n = TEENS[rest[0]] ?? TENS[rest[0]];
  else if (rest.length === 2 && rest[0] === 'oh') n = UNITS[rest[1]];
  else if (rest.length === 2) n = TENS[rest[0]] !== undefined && UNITS[rest[1]] !== undefined ? TENS[rest[0]] + UNITS[rest[1]] : undefined;
  return n === undefined ? null : century * 100 + n;
}

const DAY = `(?:(?:${W(TENS)})[ -](?:${W(ORD_UNITS)}|${W(UNITS)})|${W(ORD_UNITS)}|${W(ORD_TEENS)}|${W(ORD_TENS)}|${W(TEENS)}|${W(TENS)}|${W(UNITS)}|\\d{1,2}(?:st|nd|rd|th)?)`;
const YEAR = `(?:two thousand(?:(?: and)? (?:(?:${W(TENS)})(?:[ -](?:${W(UNITS)}))?|${W(TEENS)}|${W(UNITS)}))?|(?:nineteen|twenty) (?:oh (?:${W(UNITS)})|(?:${W(TENS)})(?:[ -](?:${W(UNITS)}))?|${W(TEENS)})|\\d{4})`;

/** Rewrite spoken dates ("first June two thousand five", "October thirtieth, two thousand twenty-six") as digits ("1 june 2005", "october 30 2026"). (origin, hyphens accepted) */
export function spokenDatesToDigits(text: string): string {
  const t = text.toLowerCase();
  const dayMonth = new RegExp(`\\b(${DAY})(?: of)? (${MONTHS})\\b,? (${YEAR})\\b`, 'g');
  const monthDay = new RegExp(`\\b(${MONTHS})(?: the)? (${DAY})\\b,? (${YEAR})\\b`, 'g');
  return t
    .replace(dayMonth, (all, d: string, m: string, y: string) => {
      const dv = dayValue(d);
      const yv = /^\d{4}$/.test(y) ? Number(y) : yearValue(y);
      return dv && yv ? `${dv} ${m} ${yv}` : all;
    })
    .replace(monthDay, (all, m: string, d: string, y: string) => {
      const dv = dayValue(d);
      const yv = /^\d{4}$/.test(y) ? Number(y) : yearValue(y);
      return dv && yv ? `${m} ${dv} ${yv}` : all;
    });
}

/** Everything the Guard should see as digits: spoken dates, then runs of spoken digits. */
export function spokenToDigits(text: string): string {
  const dates = spokenDatesToDigits(text);
  return digitWordsToDigits(dates === text.toLowerCase() ? text : dates);
}
