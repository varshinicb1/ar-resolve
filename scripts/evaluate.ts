// Writes evaluation/REPORT.md: DED01 against the build-pack fixtures plus the
// cohort's expected first outcomes. Mechanics validation only.
import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateDed01 } from '../shared/rules/ded01.ts';
import { DED01_V1 } from '../shared/rules/catalog.ts';
import { hashJson } from '../server/util.ts';
import { start, importCohort, accountByExt } from '../tests/helpers.ts';
import { cohort } from '../server/connectors/synthetic-source.ts';

const fx = JSON.parse(readFileSync(new URL('../evaluation/deductible-fixtures.json', import.meta.url), 'utf8')) as { id: string; name: string; input: Record<string, unknown>; expected: string; severity: string }[];
const rows = fx.map((f) => ({ ...f, actual: evaluateDed01(f.input).outcome }));
const fails = rows.filter((r) => r.actual !== r.expected);

const h = await start();
const cohortRows: string[] = [];
for (const [client, user] of [['cl_ortho', 'u_ana'], ['cl_derm', 'u_ana']] as const) {
  const c = await h.as(user, 'tn_demo', client);
  await importCohort(c, client);
  for (const a of cohort().accounts.filter((x) => x.client === client)) {
    const id = await accountByExt(c, a.externalId);
    const r = (await c.post(`/api/accounts/${id}/investigate`)).body;
    cohortRows.push(`| ${a.externalId} | ${a.expectedFirst} | ${r.outcome} | ${r.outcome === a.expectedFirst ? 'match' : 'DIFF'} |`);
  }
}
await h.close();

const report = `# Evaluation report: DED01 draft v1 (synthetic)

Generated ${new Date().toISOString()} by \`npm run eval\`.

**Scope.** Mechanics validation of the deterministic rule engine on synthetic fixtures. Labels are the build pack's synthetic proposals (\`synthetic_proposed_not_customer_approved\`). This is not payer-policy validation, not shadow-mode accuracy and not a basis for any accuracy claim (docs/09).

| Item | Value |
| --- | --- |
| Rule | ${DED01_V1.id} v${DED01_V1.version} (${DED01_V1.status}), definition sha256 \`${hashJson(DED01_V1).slice(0, 16)}…\` |
| Engine | \`shared/rules/ded01.ts\` (same module in API, worker and browser) |
| Fixture set | evaluation/deductible-fixtures.json, ${rows.length} cases |
| Fixture agreement | ${rows.length - fails.length}/${rows.length} |
| Critical-severity cases | ${rows.filter((r) => r.severity === 'critical').length}, all ${rows.filter((r) => r.severity === 'critical' && r.actual === r.expected).length === rows.filter((r) => r.severity === 'critical').length ? 'agree' : 'NOT all agree'} |
| Abstentions (collect_evidence or specialist_review) | ${rows.filter((r) => ['collect_evidence', 'specialist_review'].includes(r.actual)).length}/${rows.length} |

## End-to-end cohort (import → evidence → facts → rule)

| Account | Expected first outcome | Actual | Result |
| --- | --- | --- | --- |
${cohortRows.join('\n')}

## Fixture detail

| Case | Name | Severity | Expected | Actual |
| --- | --- | --- | --- | --- |
${rows.map((r) => `| ${r.id} | ${r.name} | ${r.severity} | ${r.expected} | ${r.actual} |`).join('\n')}

## Not established

Extraction accuracy, correct-action accuracy on real accounts, reviewer burden, payer coverage and any financial outcome. These require Gate B (shadow mode on authorized, expert-labeled data).
`;
writeFileSync(new URL('../evaluation/REPORT.md', import.meta.url), report);
console.log(`fixtures ${rows.length - fails.length}/${rows.length}; cohort ${cohortRows.filter((r) => r.includes('match')).length}/${cohortRows.length}; wrote evaluation/REPORT.md`);
if (fails.length || cohortRows.some((r) => r.includes('DIFF'))) process.exit(1);
