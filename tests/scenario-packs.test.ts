import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODULES, moduleForRule } from '../shared/rules/registry.ts';
import { runFixtures, validateDefinition } from '../shared/rules/studio.ts';
import { selectScenario, type SelectionSignals } from '../shared/rules/select.ts';
import { DED01_V1 } from '../shared/rules/catalog.ts';
import { hashJson } from '../server/util.ts';
import type { Fixture } from '../shared/rules/types.ts';

const load = (file: string) => JSON.parse(readFileSync(new URL(`../evaluation/${file}`, import.meta.url), 'utf8')) as Fixture[];

test('DED01 definition is byte-for-byte the Phase 0 draft v1', () => {
  assert.equal(hashJson(DED01_V1), '173dec8123e28fccad3b072aefeae1c5d9b17a4e88d2b8a9097543b185a6d045');
  assert.equal(moduleForRule('DED01')!.baseline, DED01_V1);
});

for (const mod of MODULES) {
  test(`${mod.ruleId} (${mod.id}) passes all of its fixtures`, () => {
    const fx = load(mod.fixtureFile);
    assert.ok(fx.length >= 6, `${mod.ruleId} has at least 6 fixtures`);
    const failures = runFixtures(mod, fx).filter((r) => !r.pass).map((r) => [r.id, r.expected, r.actual, r.missingReasons]);
    assert.deepEqual(failures, []);
    if (mod.ruleId !== 'DED01') {
      const cats = new Set(fx.map((f) => f.category));
      // The router only abstains, so it has no positive (action-proposing) case.
      for (const c of mod.kind === 'router' ? ['negative', 'ambiguous', 'adversarial'] : ['positive', 'negative', 'ambiguous', 'adversarial']) assert.ok(cats.has(c as never), `${mod.ruleId} has ${c} cases`);
    }
  });

  test(`${mod.ruleId} baseline validates against rule.schema.json and its module`, () => {
    const report = validateDefinition(mod.baseline, mod, load(mod.fixtureFile));
    assert.deepEqual([report.schema.errors, report.compatibility.errors], [[], []]);
    assert.equal(report.ok, true);
  });
}

test('specialist routes never propose a payer-facing or financial action', () => {
  for (const mod of MODULES.filter((m) => m.kind === 'specialist_route' || m.kind === 'router')) {
    for (const a of mod.baseline.actions) {
      assert.ok(a.risk === 'abstain' || (a.risk === 'internal_work_item' && a.connector === 'internal_worklist'), `${mod.ruleId} ${a.kind}`);
    }
  }
});

test('specialist route exposes its evidence checklist', () => {
  const tf = moduleForRule('TF01')!;
  const r = tf.evaluate({ identityVerified: true, claimReference: 'C', originalSubmissionDate: '2026-01-01' }, {});
  assert.equal(r.outcome, 'collect_evidence');
  assert.deepEqual(r.checklist!.map((c) => [c.key, c.satisfied]), [
    ['originalSubmissionDate', true], ['submissionReceiptRef', false], ['payerReceivedDate', false], ['filingRuleReference', false], ['filingTriggerDate', false]]);
  assert.deepEqual(r.missing, ['submissionReceiptRef', 'payerReceivedDate', 'filingRuleReference', 'filingTriggerDate']);
});

test('outcome kinds are unique across packs (except shared abstentions)', () => {
  const seen = new Map<string, string>();
  for (const m of MODULES) for (const a of m.baseline.actions) {
    if (a.risk === 'abstain') continue;
    assert.ok(!seen.has(a.kind), `${a.kind} in ${m.ruleId} and ${seen.get(a.kind)}`);
    seen.set(a.kind, m.ruleId);
  }
});

const selection = JSON.parse(readFileSync(new URL('../evaluation/selection-fixtures.json', import.meta.url), 'utf8')) as
  { id: string; signals: SelectionSignals; expected: { status: string; scenario: string | null; candidates?: string[]; reasons?: string[] } }[];

test('scenario selection matches every selection fixture, including ambiguous and adversarial', () => {
  const failures = [];
  for (const f of selection) {
    const r = selectScenario(f.signals);
    const codes = r.reasons.map((x) => x.code);
    const ok = r.status === f.expected.status && r.scenario === f.expected.scenario
      && (!f.expected.candidates || JSON.stringify(r.candidates) === JSON.stringify(f.expected.candidates))
      && (f.expected.reasons ?? []).every((c) => codes.includes(c));
    if (!ok) failures.push([f.id, r.status, r.scenario, codes]);
  }
  assert.deepEqual(failures, []);
});

test('selection is deterministic and order-independent for multiple matches', () => {
  const a = selectScenario({ adjustments: { status: 'verified', value: [{ group: 'OA', carc: '18' }, { group: 'PR', carc: '1' }] }, remarkCodes: { status: 'missing', value: null }, claimStatus: { status: 'missing', value: null }, inventoryScenario: null });
  const b = selectScenario({ adjustments: { status: 'verified', value: [{ group: 'PR', carc: '1' }, { group: 'OA', carc: '18' }] }, remarkCodes: { status: 'missing', value: null }, claimStatus: { status: 'missing', value: null }, inventoryScenario: null });
  assert.deepEqual(a.candidates, b.candidates);
  assert.equal(a.status, 'ambiguous');
});
