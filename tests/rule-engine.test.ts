import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateDed01 } from '../shared/rules/ded01.ts';

const fixtures = JSON.parse(readFileSync(new URL('../evaluation/deductible-fixtures.json', import.meta.url), 'utf8')) as { id: string; input: Record<string, unknown>; expected: string }[];

test('DED01 engine matches all 40 build-pack fixtures (synthetic oracle)', () => {
  assert.equal(fixtures.length, 40);
  const failures = fixtures.filter((f) => evaluateDed01(f.input).outcome !== f.expected).map((f) => [f.id, evaluateDed01(f.input).outcome, f.expected]);
  assert.deepEqual(failures, []);
});

test('blank and boolean amounts never become zero', () => {
  const base = fixtures[0].input;
  assert.equal(evaluateDed01({ ...base, appliedCents: '' }).outcome, 'collect_evidence');
  assert.equal(evaluateDed01({ ...base, appliedCents: false }).outcome, 'specialist_review');
  assert.equal(evaluateDed01({ ...base, secondaryAtDos: null }).outcome, 'collect_evidence');
});

test('calculation exposes operands for the reviewer', () => {
  const r = evaluateDed01({ ...fixtures[1].input });
  assert.equal(r.outcome, 'clarify_allocation');
  assert.deepEqual([r.calculation?.expectedCents, r.calculation?.appliedCents, r.calculation?.differenceCents], [0, 42500, 42500]);
});
