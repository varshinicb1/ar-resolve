// Rule studio validation (FR06): data-only edits, schema check against the build
// pack rule schema, compatibility with the reviewed logic module, and fixtures.
// Pure functions shared by the server (authoritative) and the browser (preview).
import type { FactStatus, RuleDefinition } from './catalog.ts';
import { RULE_SCHEMA } from './rule-schema.ts';
import { paramsOf, type Fixture, type LogicModule } from './types.ts';

// ---------------------------------------------------------------- JSON schema subset

export interface SchemaError { path: string; message: string }

type Schema = Record<string, unknown>;

function isDate(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// Supports the keywords rule.schema.json uses: type, required, properties,
// additionalProperties:false, items, enum, const, pattern, minLength, minItems,
// uniqueItems, minimum, format:date. Unknown keywords fail closed.
const KNOWN = new Set(['$schema', '$id', 'title', 'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'pattern', 'minLength', 'minItems', 'uniqueItems', 'minimum', 'format']);

export function validateSchema(schema: Schema, value: unknown, path = '$'): SchemaError[] {
  const errs: SchemaError[] = [];
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) errs.push({ path, message: `unsupported schema keyword ${k}` });
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) errs.push({ path, message: `must be one of ${schema.enum.join(', ')}` });
  const t = schema.type;
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [...errs, { path, message: 'must be an object' }];
    const obj = value as Record<string, unknown>;
    for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in obj)) errs.push({ path: `${path}.${r}`, message: 'is required' });
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errs.push(...validateSchema(props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push({ path: `${path}.${k}`, message: 'is not allowed' });
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [...errs, { path, message: 'must be an array' }];
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errs.push({ path, message: `needs at least ${schema.minItems} item(s)` });
    if (schema.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) errs.push({ path, message: 'items must be unique' });
    if (schema.items) value.forEach((x, i) => errs.push(...validateSchema(schema.items as Schema, x, `${path}[${i}]`)));
  } else if (t === 'string') {
    if (typeof value !== 'string') return [...errs, { path, message: 'must be a string' }];
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errs.push({ path, message: `must have at least ${schema.minLength} character(s)` });
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) errs.push({ path, message: `must match ${schema.pattern}` });
    if (schema.format === 'date' && !isDate(value)) errs.push({ path, message: 'must be a date (YYYY-MM-DD)' });
  } else if (t === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return [...errs, { path, message: 'must be an integer' }];
    if (typeof schema.minimum === 'number' && value < schema.minimum) errs.push({ path, message: `must be >= ${schema.minimum}` });
  } else if (t !== undefined) {
    errs.push({ path, message: `unsupported type ${String(t)}` });
  }
  return errs;
}

// The build-pack schema describes the portable rule-pack shape. Our stored
// definition carries richer typed fields; this projection maps it onto that shape.
export function schemaProjection(def: RuleDefinition, mod: LogicModule) {
  return {
    id: def.id, version: def.version, status: def.status, scope: def.scope, effectiveFrom: def.effectiveFrom, effectiveThrough: def.effectiveThrough,
    owner: def.owner, approvalRequired: true, supportedAssumptions: def.supportedAssumptions, requiredFacts: def.requiredFacts.map((f) => f.key),
    actions: def.actions.map((a) => a.kind), prohibitedActions: def.prohibitedActions, sources: def.sources, branches: mod.branches,
  };
}

// ---------------------------------------------------------------- data-only edits

export const EDITABLE_FIELDS = ['scope', 'effectiveFrom', 'effectiveThrough', 'owner', 'supportedAssumptions', 'sources', 'requiredFacts', 'params',
  'followUpSource', 'outcomeLabels', 'approveLabels', 'prohibitedActions'] as const;

const ACCEPTABLE_STATUSES: FactStatus[] = ['verified', 'reported', 'inferred'];
const SLUG = /^[a-z][a-z0-9_]{2,60}$/;
const SCOPE_VALUE = /^[A-Za-z0-9_.*-]{1,80}$/;

function text(v: unknown, field: string, errs: string[], max = 300): string | null {
  // eslint-disable-next-line no-control-regex
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) { errs.push(`${field} must be plain text, 1-${max} characters`); return null; }
  return v.trim();
}

function textList(v: unknown, field: string, errs: string[]): string[] | null {
  if (!Array.isArray(v) || !v.length || v.length > 20) { errs.push(`${field} must be a list of 1-20 entries`); return null; }
  const out = v.map((x, i) => text(x, `${field}[${i}]`, errs));
  if (out.some((x) => x === null)) return null;
  if (new Set(out).size !== out.length) { errs.push(`${field} entries must be unique`); return null; }
  return out as string[];
}

export interface PatchResult { def: RuleDefinition; errors: string[] }

// Applies a data-only patch. Logic (logicModule, branches, actions, risk classes,
// connectors) is not editable: it is reviewed code. Text is stored, never executed.
export function applyPatch(base: RuleDefinition, patch: unknown, mod: LogicModule): PatchResult {
  const errors: string[] = [];
  const def: RuleDefinition = JSON.parse(JSON.stringify(base));
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { def, errors: ['patch must be an object'] };
  const p = patch as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!(EDITABLE_FIELDS as readonly string[]).includes(k)) errors.push(`${k} is not editable: rule logic, actions and identity are reviewed code, not data`);
  }
  if (p.scope !== undefined) {
    const s = p.scope as Record<string, unknown>;
    if (!s || typeof s !== 'object') errors.push('scope must be an object');
    else for (const [k, v] of Object.entries(s)) {
      if (!['payer', 'plan', 'claimType'].includes(k)) errors.push(`scope.${k} is not editable (tenant and client come from your signed-in scope)`);
      else if (typeof v !== 'string' || !SCOPE_VALUE.test(v)) errors.push(`scope.${k} must be 1-80 characters of letters, digits, _ . - or *`);
      else (def.scope as Record<string, string>)[k] = v;
    }
  }
  for (const k of ['effectiveFrom', 'effectiveThrough'] as const) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== 'string' || !isDate(p[k] as string)) errors.push(`${k} must be a date (YYYY-MM-DD)`);
    else def[k] = p[k] as string;
  }
  if (p.owner !== undefined) { const t = text(p.owner, 'owner', errors, 120); if (t) def.owner = t; }
  if (p.followUpSource !== undefined) { const t = text(p.followUpSource, 'followUpSource', errors); if (t) def.followUpSource = t; }
  if (p.supportedAssumptions !== undefined) { const l = textList(p.supportedAssumptions, 'supportedAssumptions', errors); if (l) def.supportedAssumptions = l; }
  if (p.sources !== undefined) { const l = textList(p.sources, 'sources', errors); if (l) def.sources = l; }
  if (p.requiredFacts !== undefined) {
    if (!Array.isArray(p.requiredFacts)) errors.push('requiredFacts must be a list of { key, acceptedStatuses }');
    else for (const rf of p.requiredFacts as { key?: unknown; acceptedStatuses?: unknown }[]) {
      const target = def.requiredFacts.find((f) => f.key === rf?.key);
      if (!target) { errors.push(`requiredFacts: ${String(rf?.key)} is not a fact of this pack (facts are fixed by the logic module)`); continue; }
      const st = rf.acceptedStatuses;
      if (!Array.isArray(st) || !st.length || st.some((x) => !ACCEPTABLE_STATUSES.includes(x as FactStatus)) || new Set(st).size !== st.length) {
        errors.push(`requiredFacts.${target.key}.acceptedStatuses must be a non-empty subset of ${ACCEPTABLE_STATUSES.join(', ')}`);
      } else target.acceptedStatuses = st as FactStatus[];
    }
  }
  if (p.params !== undefined) {
    if (!p.params || typeof p.params !== 'object') errors.push('params must be an object');
    else for (const [k, v] of Object.entries(p.params as Record<string, unknown>)) {
      const spec = mod.paramSpecs.find((s) => s.key === k);
      if (!spec) errors.push(`params.${k} is not a parameter of ${mod.ruleId}`);
      else if (typeof v !== 'number' || !Number.isInteger(v) || v < spec.min || v > spec.max) errors.push(`params.${k} must be a whole number from ${spec.min} to ${spec.max}`);
      else def.params = { ...(def.params ?? {}), [k]: v };
    }
  }
  const kinds = def.actions.map((a) => a.kind);
  if (p.outcomeLabels !== undefined) {
    const o = p.outcomeLabels as Record<string, unknown>;
    if (!o || typeof o !== 'object') errors.push('outcomeLabels must be an object');
    else for (const [k, v] of Object.entries(o)) {
      if (!kinds.includes(k)) errors.push(`outcomeLabels.${k} is not an outcome of this pack`);
      else { const t = text(v, `outcomeLabels.${k}`, errors, 120); if (t) def.outcomeLabels = { ...(def.outcomeLabels ?? {}), [k]: t }; }
    }
  }
  if (p.approveLabels !== undefined) {
    const o = p.approveLabels as Record<string, unknown>;
    if (!o || typeof o !== 'object') errors.push('approveLabels must be an object');
    else for (const [k, v] of Object.entries(o)) {
      const a = def.actions.find((x) => x.kind === k);
      if (!a || a.risk === 'abstain') errors.push(`approveLabels.${k} is not an approvable action of this pack`);
      else { const t = text(v, `approveLabels.${k}`, errors, 120); if (t) a.approveLabel = t; }
    }
  }
  if (p.prohibitedActions !== undefined) {
    const l = p.prohibitedActions;
    if (!Array.isArray(l) || l.some((x) => typeof x !== 'string' || !SLUG.test(x)) || new Set(l).size !== l.length) errors.push('prohibitedActions must be unique snake_case identifiers');
    else {
      const dropped = mod.baseline.prohibitedActions.filter((x) => !l.includes(x));
      if (dropped.length) errors.push(`prohibitedActions cannot remove reviewed prohibitions: ${dropped.join(', ')}`);
      else def.prohibitedActions = l as string[];
    }
  }
  return { def, errors };
}

// ---------------------------------------------------------------- compatibility and fixtures

export function compatibilityErrors(def: RuleDefinition, mod: LogicModule, owner?: { tenant: string; client: string }): string[] {
  const e: string[] = [];
  const base = mod.baseline;
  if (def.logicModule !== mod.id) e.push(`logicModule must be ${mod.id}`);
  if (def.id !== mod.ruleId) e.push(`id must be ${mod.ruleId}`);
  const keys = (d: RuleDefinition) => d.requiredFacts.map((f) => `${f.key}${f.optional ? '?' : ''}`).join(',');
  if (keys(def) !== keys(base)) e.push('requiredFacts must list exactly the facts the logic module reads');
  for (const f of def.requiredFacts) {
    if (!f.acceptedStatuses.length || f.acceptedStatuses.some((s) => !ACCEPTABLE_STATUSES.includes(s))) e.push(`requiredFacts.${f.key}: accepted statuses must be a non-empty subset of ${ACCEPTABLE_STATUSES.join(', ')}`);
  }
  const shape = (d: RuleDefinition) => d.actions.map((a) => `${a.kind}:${a.risk}:${a.connector}`).join(',');
  if (shape(def) !== shape(base)) e.push('actions (kinds, risk classes, connectors) are fixed by the logic module');
  for (const a of def.actions) if (a.risk !== 'abstain' && !(a.approveLabel ?? '').trim()) e.push(`approve label for ${a.kind} is required`);
  const dropped = base.prohibitedActions.filter((x) => !def.prohibitedActions.includes(x));
  if (dropped.length) e.push(`prohibitedActions must keep ${dropped.join(', ')}`);
  for (const spec of mod.paramSpecs) {
    const v = def.params?.[spec.key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < spec.min || v > spec.max) e.push(`params.${spec.key} must be a whole number from ${spec.min} to ${spec.max}`);
  }
  for (const k of Object.keys(def.params ?? {})) if (!mod.paramSpecs.some((s) => s.key === k)) e.push(`params.${k} is not a parameter of ${mod.ruleId}`);
  if (!isDate(def.effectiveFrom) || !isDate(def.effectiveThrough) || def.effectiveFrom > def.effectiveThrough) e.push('effective dates must be valid and effectiveFrom <= effectiveThrough');
  if (def.followUpBusinessDays !== null) e.push('followUpBusinessDays must be null: no verified payer turnaround source exists; follow-up comes only from payer commitments in evidence');
  if (owner && (def.scope.tenant !== owner.tenant || def.scope.client !== owner.client)) e.push('scope tenant/client must equal the owning scope');
  const kinds = def.actions.map((a) => a.kind);
  for (const k of Object.keys(def.outcomeLabels ?? {})) if (!kinds.includes(k)) e.push(`outcomeLabels.${k} is not an outcome`);
  return e;
}

export interface FixtureRow { id: string; name: string; category: string; severity: string; expected: string; actual: string; pass: boolean; reasonCodes: string[]; missingReasons: string[] }

export function runFixtures(mod: LogicModule, fixtures: Fixture[], def: RuleDefinition = mod.baseline): FixtureRow[] {
  const params = paramsOf(def, mod);
  return fixtures.map((f) => {
    const r = mod.evaluate(f.input, { ...params, ...(f.params ?? {}) });
    const missingReasons = (f.expectedReasons ?? []).filter((c) => !r.reasonCodes.includes(c));
    return { id: f.id, name: f.name, category: f.category ?? 'positive', severity: f.severity, expected: f.expected, actual: r.outcome,
      pass: r.outcome === f.expected && !missingReasons.length, reasonCodes: r.reasonCodes, missingReasons };
  });
}

export interface ValidationReport {
  ok: boolean;
  ruleId: string;
  logicModule: string;
  schema: { ok: boolean; errors: SchemaError[] };
  compatibility: { ok: boolean; errors: string[] };
  fixtures: { total: number; passed: number; failures: FixtureRow[] };
}

export function validateDefinition(def: RuleDefinition, mod: LogicModule, fixtures: Fixture[], owner?: { tenant: string; client: string }): ValidationReport {
  const schemaErrors = validateSchema(RULE_SCHEMA, schemaProjection(def, mod));
  const compat = compatibilityErrors(def, mod, owner);
  const rows = compat.length ? [] : runFixtures(mod, fixtures, def);
  const failures = rows.filter((r) => !r.pass);
  const compatAll = fixtures.length ? compat : [...compat, 'no fixtures exist for this pack'];
  return {
    ok: !schemaErrors.length && !compatAll.length && !failures.length,
    ruleId: def.id, logicModule: def.logicModule,
    schema: { ok: !schemaErrors.length, errors: schemaErrors },
    compatibility: { ok: !compatAll.length, errors: compatAll },
    fixtures: { total: rows.length, passed: rows.length - failures.length, failures },
  };
}

// Field-level diff for the review screen.
export function diffDefinitions(before: unknown, after: unknown, path = ''): { path: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const isObj = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before as object), ...Object.keys(after as object)])].sort();
    return keys.flatMap((k) => diffDefinitions((before as Record<string, unknown>)[k], (after as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length && before.every((x) => isObj(x))) {
    return before.flatMap((x, i) => diffDefinitions(x, after[i], `${path}[${(x as { key?: string; kind?: string }).key ?? (x as { kind?: string }).kind ?? i}]`));
  }
  return [{ path, before, after }];
}
