// Versioned business-day calendars (FR13). Calendars are data with a sha256 and
// a source. The US federal holiday list was read from OPM on 2026-10-12; payer
// calendars are synthetic because no real payer calendar has been supplied.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { hashJson, invalid, nowIso } from '../util.ts';
import { audit } from './audit.ts';
import { requirePerm, type Scope } from './auth.ts';

export interface Holiday { date: string; name: string }
export interface CalendarDefinition { weekendDays: number[]; holidays: Holiday[]; coverage: { from: string; to: string }; notes: string }
export interface Calendar {
  calendarId: string; version: number; tenantId: string | null; clientId: string | null; payerId: string | null;
  name: string; status: 'reference' | 'synthetic' | 'unverified'; definition: CalendarDefinition; sha256: string; source: string; retrievedAt: string | null;
}

export const OPM_SOURCE = 'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/';
export const OPM_RETRIEVED = '2026-10-12';

// Observed dates exactly as listed by OPM for 2026 and 2027 (retrieved 2026-10-12).
export const US_FEDERAL_2026_2027: Holiday[] = [
  { date: '2026-01-01', name: "New Year's Day" }, { date: '2026-01-19', name: 'Birthday of Martin Luther King, Jr.' },
  { date: '2026-02-16', name: "Washington's Birthday" }, { date: '2026-05-25', name: 'Memorial Day' },
  { date: '2026-06-19', name: 'Juneteenth National Independence Day' }, { date: '2026-07-03', name: 'Independence Day' },
  { date: '2026-09-07', name: 'Labor Day' }, { date: '2026-10-12', name: 'Columbus Day' }, { date: '2026-11-11', name: 'Veterans Day' },
  { date: '2026-11-26', name: 'Thanksgiving Day' }, { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2027-01-01', name: "New Year's Day" }, { date: '2027-01-18', name: 'Birthday of Martin Luther King, Jr.' },
  { date: '2027-02-15', name: "Washington's Birthday" }, { date: '2027-05-31', name: 'Memorial Day' },
  { date: '2027-06-18', name: 'Juneteenth National Independence Day' }, { date: '2027-07-05', name: 'Independence Day' },
  { date: '2027-09-06', name: 'Labor Day' }, { date: '2027-10-11', name: 'Columbus Day' }, { date: '2027-11-11', name: 'Veterans Day' },
  { date: '2027-11-25', name: 'Thanksgiving Day' }, { date: '2027-12-24', name: 'Christmas Day' },
];

const COVERAGE = { from: '2026-01-01', to: '2027-12-31' };

export function seedCalendars(db: Db): void {
  const put = (c: Omit<Calendar, 'sha256'>) => {
    if (one(db, 'SELECT 1 FROM business_calendars WHERE calendar_id=? AND version=?', c.calendarId, c.version)) return;
    run(db, 'INSERT INTO business_calendars VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', c.calendarId, c.version, c.tenantId, c.clientId, c.payerId, c.name, c.status,
      JSON.stringify(c.definition), hashJson(c.definition), c.source, c.retrievedAt, 'system:seed', nowIso());
  };
  put({ calendarId: 'cal_us_federal', version: 1, tenantId: null, clientId: null, payerId: null, name: 'US federal holidays (OPM), Mon-Fri',
    status: 'reference', source: OPM_SOURCE, retrievedAt: OPM_RETRIEVED,
    definition: { weekendDays: [0, 6], holidays: US_FEDERAL_2026_2027, coverage: COVERAGE,
      notes: 'Federal observed holidays as published by OPM. Reference default only: no payer has confirmed that it follows this calendar.' } });
  put({ calendarId: 'cal_demo_payer', version: 1, tenantId: 'tn_demo', clientId: null, payerId: 'demo-payer', name: 'Demo Payer A business days (SYNTHETIC)',
    status: 'synthetic', source: 'synthetic:ar-resolve-fixtures', retrievedAt: null,
    definition: { weekendDays: [0, 6], holidays: [...US_FEDERAL_2026_2027,
      { date: '2026-12-24', name: 'Synthetic payer closure (invented for testing)' }, { date: '2026-12-31', name: 'Synthetic payer closure (invented for testing)' }].sort((a, b) => a.date.localeCompare(b.date)),
    coverage: COVERAGE, notes: 'Synthetic calendar for the simulated payer. Not a real payer calendar.' } });
  // Seeded review-interval policy per client. It is internal policy, not a payer promise.
  for (const c of all<{ tenant_id: string; client_id: string }>(db, 'SELECT tenant_id, client_id FROM clients')) {
    if (one(db, 'SELECT 1 FROM followup_policies WHERE tenant_id=? AND client_id=?', c.tenant_id, c.client_id)) continue;
    run(db, 'INSERT INTO followup_policies VALUES (?,?,?,?,?,?,?,?,?)', c.tenant_id, c.client_id, 1, 10, 'days', 'business',
      'Seeded synthetic default. A supervisor should set this client\'s review interval.', 'system:seed', nowIso());
  }
}

interface CalRow { calendar_id: string; version: number; tenant_id: string | null; client_id: string | null; payer_id: string | null; name: string; status: Calendar['status']; definition: string; sha256: string; source: string; retrieved_at: string | null }

function toCal(r: CalRow): Calendar {
  return { calendarId: r.calendar_id, version: r.version, tenantId: r.tenant_id, clientId: r.client_id, payerId: r.payer_id, name: r.name, status: r.status,
    definition: JSON.parse(r.definition), sha256: r.sha256, source: r.source, retrievedAt: r.retrieved_at };
}

// Latest version of every calendar visible to this tenant/client.
export function visibleCalendars(db: Db, tenantId: string, clientId: string): Calendar[] {
  return all<CalRow>(db, `SELECT * FROM business_calendars c WHERE (tenant_id IS NULL OR tenant_id=?) AND (client_id IS NULL OR client_id=?)
    AND version = (SELECT MAX(version) FROM business_calendars d WHERE d.calendar_id=c.calendar_id) ORDER BY calendar_id`, tenantId, clientId).map(toCal);
}

// Most specific calendar wins: payer+client > payer+tenant > payer > client > tenant > global.
export function resolveCalendar(db: Db, tenantId: string, clientId: string, payerId: string | null): Calendar {
  const score = (c: Calendar) => (c.payerId && c.payerId !== payerId ? -1 : (c.payerId ? 100 : 0) + (c.clientId ? 10 : 0) + (c.tenantId ? 1 : 0));
  const best = visibleCalendars(db, tenantId, clientId).map((c) => ({ c, s: score(c) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s)[0];
  if (!best) throw invalid('No business calendar is configured');
  return best.c;
}

export function getCalendar(db: Db, calendarId: string, version: number): Calendar {
  const r = one<CalRow>(db, 'SELECT * FROM business_calendars WHERE calendar_id=? AND version=?', calendarId, version);
  if (!r) throw invalid('Unknown calendar version');
  return toCal(r);
}

// ---------------------------------------------------------------- date math (UTC calendar dates, YYYY-MM-DD)

const DAY = 86_400_000;
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
}
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
}
export function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
}

export function nonBusinessReason(date: string, def: CalendarDefinition): string | null {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  if (def.weekendDays.includes(dow)) return 'weekend';
  const h = def.holidays.find((x) => x.date === date);
  return h ? `holiday: ${h.name}` : null;
}

export interface DueComputation { dueDate: string; steps: string[]; skipped: { date: string; reason: string }[]; warnings: string[] }

// Business basis: count N business days after the anchor (the anchor day itself is not counted).
// Calendar basis: anchor + N days; if that lands on a non-business day the follow-up
// moves to the next business day (it is never pulled earlier than the commitment).
export function computeDue(anchor: string, value: number, unit: 'days' | 'weeks', basis: 'business' | 'calendar', cal: Calendar): DueComputation {
  const def = cal.definition;
  const skipped: { date: string; reason: string }[] = [];
  const steps: string[] = [];
  let d = anchor;
  if (basis === 'business') {
    const n = unit === 'weeks' ? value * 5 : value;
    steps.push(`${value} ${unit} on a business-day basis = ${n} business days after ${anchor}`);
    let counted = 0;
    while (counted < n) {
      d = addDays(d, 1);
      const why = nonBusinessReason(d, def);
      if (why) skipped.push({ date: d, reason: why }); else counted++;
    }
  } else {
    const n = unit === 'weeks' ? value * 7 : value;
    d = addDays(anchor, n);
    steps.push(`${value} ${unit} on a calendar basis = ${anchor} + ${n} days = ${d}`);
    let why = nonBusinessReason(d, def);
    while (why) { skipped.push({ date: d, reason: why }); d = addDays(d, 1); why = nonBusinessReason(d, def); }
    if (skipped.length) steps.push(`Moved to the next business day (${d})`);
  }
  if (skipped.some((s) => s.reason.startsWith('holiday'))) steps.push(`Skipped holidays: ${skipped.filter((s) => s.reason.startsWith('holiday')).map((s) => s.date).join(', ')}`);
  steps.push(`Calendar ${cal.calendarId} v${cal.version} (${cal.status})`);
  const warnings: string[] = [];
  if (d > def.coverage.to || anchor < def.coverage.from) warnings.push(`Calendar holidays are only known from ${def.coverage.from} to ${def.coverage.to}; dates outside that range count weekends only`);
  if (cal.status !== 'reference') warnings.push(cal.status === 'synthetic' ? 'Synthetic calendar: not a real payer calendar' : 'Calendar is unverified');
  return { dueDate: d, steps, skipped, warnings };
}

// ---------------------------------------------------------------- supervisor configuration

export function createCalendarVersion(db: Db, scope: Scope, body: { calendarId?: string; name?: string; payerId?: string | null; holidays?: Holiday[]; weekendDays?: number[]; reason?: string }) {
  requirePerm(scope, 'operate');
  const name = String(body.name ?? '').trim();
  if (name.length < 3) throw invalid('A calendar name is required');
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 5) throw invalid('A reason is required');
  const holidays = Array.isArray(body.holidays) ? body.holidays : [];
  for (const h of holidays) if (!isDate(h?.date) || typeof h.name !== 'string' || !h.name.trim() || h.name.length > 80) throw invalid('Each holiday needs a real date (YYYY-MM-DD) and a short name');
  const weekendDays = Array.isArray(body.weekendDays) ? body.weekendDays : [0, 6];
  if (!weekendDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw invalid('weekendDays must be 0-6');
  const payerId = body.payerId ? String(body.payerId) : null;
  if (payerId && !/^[\w-]{1,40}$/.test(payerId)) throw invalid('Invalid payer id');
  const calendarId = body.calendarId ? String(body.calendarId) : `cal_${scope.clientId}_${payerId ?? 'default'}`;
  if (!/^cal_[\w-]{1,60}$/.test(calendarId)) throw invalid('Invalid calendar id');
  return tx(db, () => {
    const existing = one<{ tenant_id: string | null; client_id: string | null; v: number }>(db, 'SELECT tenant_id, client_id, MAX(version) v FROM business_calendars WHERE calendar_id=?', calendarId);
    if (existing?.v && (existing.tenant_id !== scope.tenantId || existing.client_id !== scope.clientId)) throw invalid('That calendar belongs to another scope; choose a different calendar id');
    const version = (existing?.v ?? 0) + 1;
    const sorted = [...holidays].sort((a, b) => a.date.localeCompare(b.date));
    const definition: CalendarDefinition = { weekendDays, holidays: sorted.map((h) => ({ date: h.date, name: h.name.trim() })),
      coverage: { from: sorted[0]?.date ?? COVERAGE.from, to: sorted[sorted.length - 1]?.date ?? COVERAGE.to }, notes: reason };
    run(db, 'INSERT INTO business_calendars VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', calendarId, version, scope.tenantId, scope.clientId, payerId, name, 'unverified',
      JSON.stringify(definition), hashJson(definition), `user:${scope.userId}`, null, scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'calendar', objectId: `${calendarId}@${version}`,
      eventType: 'calendar_version_created', details: { calendarId, version, payerId, holidays: definition.holidays.length, sha256: hashJson(definition) } });
    return { calendarId, version, sha256: hashJson(definition), status: 'unverified' };
  });
}
