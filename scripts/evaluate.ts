// Writes evaluation/REPORT.md: every registered scenario pack against its fixtures,
// FR05 selection fixtures, and the cohort's expected first outcomes end to end.
// Mechanics validation only.
import { readFileSync, writeFileSync } from 'node:fs';
import { DED01_V1 } from '../shared/rules/catalog.ts';
import { MODULES } from '../shared/rules/registry.ts';
import { runFixtures } from '../shared/rules/studio.ts';
import { selectScenario, SCENARIO_MAP_V1, type SelectionSignals } from '../shared/rules/select.ts';
import type { Fixture } from '../shared/rules/types.ts';
import { hashJson, setClock } from '../server/util.ts';
import { start, importCohort, accountByExt } from '../tests/helpers.ts';
import { cohort } from '../server/connectors/synthetic-source.ts';

const load = <T,>(file: string) => JSON.parse(readFileSync(new URL(`../evaluation/${file}`, import.meta.url), 'utf8')) as T;

const packs = MODULES.map((mod) => {
  const rows = runFixtures(mod, load<Fixture[]>(mod.fixtureFile));
  return { mod, rows, fails: rows.filter((r) => !r.pass) };
});
const ded = packs.find((p) => p.mod.ruleId === 'DED01')!;

const selFx = load<{ id: string; name: string; category: string; signals: SelectionSignals; expected: { status: string; scenario: string | null; candidates?: string[]; reasons?: string[] } }[]>('selection-fixtures.json');
const selRows = selFx.map((f) => {
  const r = selectScenario(f.signals);
  const codes = r.reasons.map((x) => x.code);
  const pass = r.status === f.expected.status && r.scenario === f.expected.scenario
    && (!f.expected.candidates || JSON.stringify(r.candidates) === JSON.stringify(f.expected.candidates))
    && (f.expected.reasons ?? []).every((c) => codes.includes(c));
  return { f, r, pass };
});

// Status freshness is date-relative, so the cohort runs at its recorded evaluation clock.
const clock = (cohort() as unknown as { evaluationClock?: string }).evaluationClock;
if (clock) setClock(() => new Date(clock));
const h = await start();
const cohortRows: string[] = [];
let cohortMatch = 0;
for (const [client, user] of [['cl_ortho', 'u_ana'], ['cl_derm', 'u_ana'], ['cl_multi', 'u_ana']] as const) {
  const c = await h.as(user, 'tn_demo', client);
  await importCohort(c, client);
  for (const a of cohort().accounts.filter((x) => x.client === client)) {
    const id = await accountByExt(c, a.externalId);
    const r = (await c.post(`/api/accounts/${id}/investigate`)).body;
    const ok = r.outcome === a.expectedFirst;
    if (ok) cohortMatch++;
    cohortRows.push(`| ${client} | ${a.externalId} | ${r.scenario?.selected ?? '—'} (${r.scenario?.status ?? '?'}) | ${r.rule?.id ?? '?'} v${r.rule?.version ?? '?'} | ${a.expectedFirst} | ${r.outcome} | ${ok ? 'match' : 'DIFF'} |`);
  }
}
await h.close();
setClock(null);

const total = packs.reduce((n, p) => n + p.rows.length, 0);
const totalFails = packs.reduce((n, p) => n + p.fails.length, 0);
const selFails = selRows.filter((r) => !r.pass);

const report = `# Evaluation report: scenario packs (synthetic)

Generated ${new Date().toISOString()} by \`npm run eval\`.

**Scope.** Mechanics validation of the deterministic scenario packs and scenario selection on synthetic fixtures. Labels are synthetic proposals (\`synthetic_proposed_not_customer_approved\`); DED01 uses the build pack's fixtures unchanged. This is not payer-policy validation, not shadow-mode accuracy and not a basis for any accuracy claim (docs/09).

| Item | Value |
| --- | --- |
| DED01 | ${DED01_V1.id} v${DED01_V1.version} (${DED01_V1.status}), definition sha256 \`${hashJson(DED01_V1).slice(0, 16)}…\`, fixtures ${ded.rows.length - ded.fails.length}/${ded.rows.length} |
| All pack fixtures | ${total - totalFails}/${total} across ${packs.length} packs |
| Selection map | ${SCENARIO_MAP_V1.id} v${SCENARIO_MAP_V1.version} (${SCENARIO_MAP_V1.status}), sha256 \`${hashJson(SCENARIO_MAP_V1).slice(0, 16)}…\`, fixtures ${selRows.length - selFails.length}/${selRows.length} |
| End-to-end cohort | ${cohortMatch}/${cohortRows.length}${clock ? ` (clock ${clock})` : ''} |
| Engine | \`shared/rules/registry.ts\` modules (same code in API, worker and browser) |

## Packs

| Pack | Kind | Logic | Fixtures | Critical cases agree | Abstentions | Categories |
| --- | --- | --- | --- | --- | --- | --- |
${packs.map(({ mod, rows, fails }) => {
  const crit = rows.filter((r) => r.severity === 'critical');
  const cats = [...new Set(rows.map((r) => r.category))].join(', ');
  return `| ${mod.ruleId} ${mod.title} | ${mod.kind.replace('_', ' ')} | \`${mod.id}\` | ${rows.length - fails.length}/${rows.length} | ${crit.filter((r) => r.pass).length}/${crit.length} | ${rows.filter((r) => ['collect_evidence', 'specialist_review'].includes(r.actual)).length}/${rows.length} | ${cats} |`;
}).join('\n')}

## End-to-end cohort (import → evidence → facts → selection → rule)

| Client | Account | Selected scenario | Rule run | Expected first outcome | Actual | Result |
| --- | --- | --- | --- | --- | --- | --- |
${cohortRows.join('\n')}

## Selection fixtures (FR05)

| Case | Name | Category | Expected | Actual |
| --- | --- | --- | --- | --- |
${selRows.map(({ f, r, pass }) => `| ${f.id} | ${f.name} | ${f.category} | ${f.expected.status} ${f.expected.scenario ?? ''} | ${pass ? '' : 'DIFF '}${r.status} ${r.scenario ?? ''} |`).join('\n')}

## Fixture detail

${packs.map(({ mod, rows }) => `### ${mod.ruleId}

| Case | Name | Category | Severity | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
${rows.map((r) => `| ${r.id} | ${r.name} | ${r.category} | ${r.severity} | ${r.expected} | ${r.pass ? '' : 'DIFF '}${r.actual} |`).join('\n')}`).join('\n\n')}

## Not established

Extraction accuracy, correct-action accuracy on real accounts, reviewer burden, payer coverage, the correctness of the CARC-to-pack routing for any real client, and any financial outcome. These require Gate B (shadow mode on authorized, expert-labeled data) and customer sign-off of each pack.
`;
writeFileSync(new URL('../evaluation/REPORT.md', import.meta.url), report);
console.log(`DED01 fixtures ${ded.rows.length - ded.fails.length}/${ded.rows.length}; all packs ${total - totalFails}/${total}; selection ${selRows.length - selFails.length}/${selRows.length}; cohort ${cohortMatch}/${cohortRows.length}; wrote evaluation/REPORT.md`);
for (const p of packs) console.log(`  ${p.mod.ruleId.padEnd(8)} ${p.rows.length - p.fails.length}/${p.rows.length}${p.fails.length ? '  FAIL ' + p.fails.map((f) => f.id).join(', ') : ''}`);
for (const r of cohortRows.filter((x) => x.includes('DIFF'))) console.log('  ' + r);
if (totalFails || selFails.length || cohortMatch !== cohortRows.length) process.exit(1);
