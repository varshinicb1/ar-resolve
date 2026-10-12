// ADR 0060: one scenario routing source. The KB routing (shared/kb/routing.ts) derives from
// the rule-pack selection map (shared/rules/select.ts); these tests fail on any disagreement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_CODES, PROPOSED_ROUTES, ROUTE_GUARDS, ROUTING_SOURCE_MAP, ROUTING_TABLE, guardViolations, mapCarcRows, routeScenario } from '../shared/kb/routing.ts';
import { SCENARIO_MAP_V1, selectScenario, type ScenarioMap } from '../shared/rules/select.ts';
import { MODULES } from '../shared/rules/registry.ts';

const select = (group: string, carc: string, map: ScenarioMap = SCENARIO_MAP_V1) => selectScenario({ adjustments: { status: 'verified', value: [{ group, carc }] },
  remarkCodes: { status: 'missing', value: null }, claimStatus: { status: 'missing', value: null }, inventoryScenario: null }, map);

test('KB routing derives from the active selection map version', () => {
  assert.equal(ROUTING_SOURCE_MAP, SCENARIO_MAP_V1);
  const fromTable = ROUTING_TABLE.flatMap((r) => r.carcs.map((c) => `${r.scenarioId}:${c}`)).sort();
  const fromMap = mapCarcRows().map((r) => `${r.scenarioId}:${r.carc}`).sort();
  assert.deepEqual(fromTable, fromMap, 'the KB table has exactly the selection map CARC rows');
  assert.deepEqual(guardViolations(), [], 'guards only constrain rows the map routes');
  const packs = new Set(MODULES.map((m) => m.ruleId));
  for (const r of ROUTING_TABLE) assert.ok(packs.has(r.scenarioId), `${r.scenarioId} is a registered rule pack`);
  for (const p of PROPOSED_ROUTES) for (const c of p.carcs) assert.equal(select('CO', c).status, 'unknown', `proposed CARC ${c} is not routed by the map`);
});

test('for every mapped CARC and group, the KB never routes where selection does not', () => {
  let routed = 0;
  for (const row of mapCarcRows()) {
    const guard = ROUTE_GUARDS.find((g) => g.scenarioId === row.scenarioId && g.carcs.includes(row.carc));
    const rarcs = guard?.requiresRarc ? [guard.rarcs[0]] : [];
    for (const g of GROUP_CODES) {
      const sel = select(g, row.carc);
      const kb = routeScenario(g, row.carc, rarcs);
      if (kb.decision === 'scenario') {
        routed++;
        assert.equal(sel.status, 'selected');
        assert.equal(kb.scenarioId, sel.scenario, `${g}-${row.carc}`);
      } else {
        // The only allowed difference is a KB group guard (stricter: specialist review).
        assert.ok(guard?.groups && !guard.groups.includes(g), `${g}-${row.carc}: unexpected refusal ${kb.reasons.join(' ')}`);
      }
    }
    assert.ok(GROUP_CODES.some((g) => routeScenario(g, row.carc, rarcs).decision === 'scenario'), `${row.carc} routes under some group`);
  }
  assert.ok(routed > 30);
  assert.match(routeScenario('CO', '133').reasons.join(' '), /proposed for PEND01/);
  assert.equal(routeScenario('PR', '1').selectionMap.version, SCENARIO_MAP_V1.version);
});

test('a guard that names a CARC the map does not route is detected', () => {
  const trimmed: ScenarioMap = { ...SCENARIO_MAP_V1, version: 99, entries: SCENARIO_MAP_V1.entries.filter((e) => e.id !== 'carc-97') };
  assert.deepEqual(guardViolations(trimmed), ['guard BUN01 CARC 97 is not routed to BUN01 by SCENARIO_MAP v99']);
  const moved: ScenarioMap = { ...SCENARIO_MAP_V1, version: 98, entries: SCENARIO_MAP_V1.entries.map((e) => (e.id === 'carc-18' ? { ...e, scenario: 'COB01' } : e)) };
  assert.deepEqual(guardViolations(moved), ['guard DUP01 CARC 18 is not routed to DUP01 by SCENARIO_MAP v98']);
});
