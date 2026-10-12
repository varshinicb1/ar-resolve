import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './helpers.ts';
import { verifyKnowledge } from '../scripts/kb-verify.ts';
import { KB_ROOT, KbIntegrityError, datasetHash, loadKnowledge, search } from '../server/services/kb.ts';
import { routeScenario } from '../shared/kb/routing.ts';
import { openDb } from '../server/db/db.ts';
import { seed } from '../server/services/seed.ts';

function copyKnowledge(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kb-')) + '/';
  cpSync(KB_ROOT, dir, { recursive: true });
  return dir;
}
function edit(root: string, file: string, fn: (ds: any) => void, rehash = true) {
  const ds = JSON.parse(readFileSync(root + file, 'utf8'));
  fn(ds);
  if (rehash) { ds.header.sha256 = datasetHash(ds.entries); ds.header.count = ds.entries.length; }
  writeFileSync(root + file, JSON.stringify(ds));
}

test('shipped datasets pass integrity checks and carry provenance', () => {
  const r = verifyKnowledge();
  assert.deepEqual(r.errors, []);
  assert.ok(r.counts['x12.carc'] >= 300, 'CARC index loaded');
  assert.ok(r.counts['x12.rarc'] >= 300, 'RARC index loaded');
  assert.equal(r.counts['x12.group'], 5);
  assert.equal(r.counts['kb.playbooks'], 9);
  const carc = JSON.parse(readFileSync(KB_ROOT + 'x12/carc.json', 'utf8'));
  assert.equal(carc.header.sourceUrl, 'https://x12.org/codes/claim-adjustment-reason-codes');
  assert.match(carc.header.retrievedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(carc.header.coverage.complete, false, 'partial coverage is declared, not hidden');
});

test('kb:verify catches tampering, duplicates, missing sources and routing to unknown codes', () => {
  const root = copyKnowledge();
  edit(root, 'x12/carc.json', (ds) => { ds.entries.find((e: any) => e.code === '1').description = 'Tampered'; }, false);
  edit(root, 'x12/rarc.json', (ds) => { ds.entries.push({ ...ds.entries[0] }); });
  edit(root, 'regulatory/articles.json', (ds) => { delete ds.entries[0].facts[0].citation.url; });
  edit(root, 'x12/claim-status.json', (ds) => { ds.entries = ds.entries.filter((e: any) => e.code !== '0'); delete ds.header.source; });
  edit(root, 'payers/synthetic-payers.json', (ds) => { ds.entries[0].synthetic = false; });
  const r = verifyKnowledge(root);
  const has = (re: RegExp) => assert.ok(r.errors.some((e) => re.test(e)), `expected error ${re}: ${r.errors.join('\n')}`);
  has(/carc\.json: sha256 mismatch/);
  has(/rarc\.json: duplicate rarc:M1/);
  has(/articles\.json: medicare-timely-filing fact 0 lacks a full citation/);
  has(/claim-status\.json: header\.source missing/);
  has(/not marked synthetic/);

  const root2 = copyKnowledge();
  edit(root2, 'x12/carc.json', (ds) => {
    ds.entries = ds.entries.filter((e: any) => e.code !== '133' && e.code !== '197');
    const c29 = ds.entries.find((e: any) => e.code === '29'); c29.status = 'deactivated'; c29.stopDate = '2020-01-01';
  });
  edit(root2, 'x12/rarc.json', (ds) => { ds.entries.find((e: any) => e.code === 'M15').stopDate = '2020-01-01'; ds.entries.find((e: any) => e.code === 'M15').status = 'deactivated'; });
  const r2 = verifyKnowledge(root2);
  assert.ok(r2.errors.includes('routing: PEND01 references unknown CARC 133'));
  assert.ok(r2.errors.includes('routing: BUN01 references deactivated RARC M15'));
  // The rule-pack selection map is the routing source of truth: its CARCs must exist and be active.
  assert.ok(r2.errors.includes('selection map SCENARIO_MAP v1: carc-29 (TF01) references deactivated CARC 29'), r2.errors.join('\n'));
  assert.ok(r2.errors.includes('selection map SCENARIO_MAP v1: carc-197 (AUTH01) references unknown CARC 197'));
});

test('loader versions datasets by hash and refuses tampered files', () => {
  const db = openDb(':memory:');
  seed(db);
  const first = loadKnowledge(db);
  assert.ok(first.every((x) => x.changed && x.version === 1));
  assert.ok(loadKnowledge(db).every((x) => !x.changed && x.version === 1), 'reload is idempotent');

  const root = copyKnowledge();
  edit(root, 'glossary/glossary.json', (ds) => { ds.entries.push({ id: 'zz-test', term: 'ZZ test term', definition: 'Synthetic test term', links: [], related: [] }); });
  const second = loadKnowledge(db, root);
  assert.deepEqual(second.find((x) => x.dataset === 'kb.glossary'), { dataset: 'kb.glossary', version: 2, changed: true });
  assert.equal(second.find((x) => x.dataset === 'x12.carc')!.changed, false);
  const rows = db.prepare('SELECT version, active FROM kb_sources WHERE dataset=? ORDER BY version').all('kb.glossary') as { version: number; active: number }[];
  assert.deepEqual(rows.map((r) => [r.version, r.active]), [[1, 0], [2, 1]]);

  const bad = copyKnowledge();
  edit(bad, 'x12/carc.json', (ds) => { ds.entries[0].description = 'Tampered'; }, false);
  assert.throws(() => loadKnowledge(db, bad), KbIntegrityError);
});

test('routeScenario: pure draft routing with specialist review for unknown or conflicting input', () => {
  const ded = routeScenario('PR', '1', []);
  assert.equal(ded.decision, 'scenario');
  assert.equal(ded.scenarioId, 'DED01');
  assert.equal(ded.mappingStatus, 'draft_requires_business_signoff');
  assert.equal(routeScenario('pr', ' 1 ').scenarioId, 'DED01', 'normalizes case and whitespace');
  assert.equal(routeScenario('CO', '1').decision, 'specialist_review', 'deductible under CO is not routed');
  assert.equal(routeScenario('CO', '9999').decision, 'specialist_review');
  assert.match(routeScenario('CO', '9999').reasons.join(' '), /No draft routing exists for CARC 9999/);
  assert.equal(routeScenario('ZZ', '1').decision, 'specialist_review');
  assert.equal(routeScenario('CO', '16').decision, 'specialist_review', 'generic CARC 16 needs a RARC');
  assert.equal(routeScenario('CO', '16', ['M127']).scenarioId, 'DOC01');
  const multi = routeScenario('CO', '50', ['M15']);
  assert.equal(multi.decision, 'specialist_review');
  assert.deepEqual(multi.candidates.map((c) => c.scenarioId).sort(), ['BUN01', 'MN01']);
  assert.equal(routeScenario('CO', '97', ['M15']).scenarioId, 'BUN01', 'corroborating RARC keeps a single candidate');
  assert.equal(routeScenario('PR', '18').decision, 'specialist_review', 'duplicate only under OA/CO');
  assert.equal(routeScenario('OA', '18').scenarioId, 'DUP01');
});

test('KB API: search, code lookup, explain and playbooks', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    const src = (await ana.get('/api/kb/sources')).body;
    assert.equal(src.searchEngine, 'fts5', 'node:sqlite ships FTS5');
    assert.ok(src.datasets.every((d: any) => d.sha256.length === 64 && d.retrievedAt && d.source));

    const s = (await ana.get('/api/kb/search?q=deductible')).body;
    const refs = s.results.map((r: any) => `${r.kind}:${r.ref}`);
    assert.ok(refs.includes('code:carc:1'), refs.join(','));
    assert.ok(refs.includes('playbook:DED01'));
    assert.ok(refs.includes('glossary:deductible'));
    const exact = (await ana.get('/api/kb/search?q=N130&types=code')).body.results;
    assert.equal(exact[0].ref, 'rarc:N130');
    const onlyArticles = (await ana.get('/api/kb/search?q=timely%20filing&types=article')).body.results;
    assert.ok(onlyArticles.length && onlyArticles.every((r: any) => r.kind === 'article'));
    assert.equal(onlyArticles[0].ref, 'medicare-timely-filing');
    const carcOnly = (await ana.get('/api/kb/search?q=authorization&types=code&codeType=carc')).body.results;
    assert.ok(carcOnly.length && carcOnly.every((r: any) => r.codeType === 'carc'));
    assert.equal((await ana.get('/api/kb/search?q=%22)%20OR%20*')).status, 200, 'FTS syntax in input is neutralized');
    const like = search(h.db, { userId: 'u_ana', displayName: '', tenantId: 'tn_demo', clientId: 'cl_ortho', roles: ['specialist'] }, { q: 'deductible amount', engine: 'like' });
    assert.equal(like.engine, 'like');
    assert.ok(like.results.some((r) => r.ref === 'carc:1'));

    const code = (await ana.get('/api/kb/codes/carc/1')).body;
    assert.equal(code.description, 'Deductible Amount');
    assert.equal(code.routes[0].scenarioId, 'DED01');
    assert.equal(code.source.dataset, 'x12.carc');
    assert.equal((await ana.get('/api/kb/codes/carc/ZZ99')).status, 404);
    assert.equal((await ana.get('/api/kb/codes/bogus/1')).status, 400);
    const page = (await ana.get('/api/kb/codes?type=carc&status=deactivated&pageSize=5')).body;
    assert.ok(page.total > 50 && page.items.length === 5 && page.items.every((i: any) => i.status === 'deactivated'));

    const ex = (await ana.get('/api/kb/explain?group=PR&carc=1')).body;
    assert.equal(ex.decision, 'scenario');
    assert.equal(ex.scenarioId, 'DED01');
    assert.equal(ex.playbook.id, 'DED01');
    assert.ok(ex.playbook.hardStops.length > 0);
    assert.equal(ex.carc.description, 'Deductible Amount');
    assert.equal(ex.group.name, 'Patient Responsibility');
    assert.ok(ex.caveats.some((c: string) => /may be billed to the patient, not that it must be/.test(c)));
    assert.ok(ex.caveats.some((c: string) => /requires business sign-off/.test(c)));

    const unknown = (await ana.post('/api/kb/explain', { group: 'CO', carc: '9999', rarcs: ['ZZ1'] })).body;
    assert.equal(unknown.decision, 'specialist_review');
    assert.equal(unknown.playbook, null);
    assert.ok(unknown.caveats.some((c: string) => /CARC 9999 is not in the loaded CARC list/.test(c)));
    assert.ok(unknown.caveats.some((c: string) => /RARC ZZ1 is not in the loaded RARC list/.test(c)));
    // Valid route but an unknown RARC still forces review.
    assert.equal((await ana.get('/api/kb/explain?group=PR&carc=1&rarcs=QQ9')).body.decision, 'specialist_review');
    // Deactivated CARC (15, stop 2018-05-01) forces review.
    const old = (await ana.get('/api/kb/explain?group=CO&carc=15')).body;
    assert.equal(old.decision, 'specialist_review');
    assert.ok(old.caveats.some((c: string) => /deactivated on 2018-05-01/.test(c)));
    assert.equal((await ana.get('/api/kb/explain')).status, 400);

    const pbs = (await ana.get('/api/kb/playbooks')).body;
    assert.deepEqual(pbs.map((p: any) => p.id), ['DED01', 'PEND01', 'DOC01', 'DUP01', 'COB01', 'TF01', 'AUTH01', 'MN01', 'BUN01']);
    assert.ok(pbs.every((p: any) => p.reviewStatus === 'draft' && p.routes.length > 0));
    const tf = (await ana.get('/api/kb/playbooks/TF01')).body;
    assert.ok(tf.hardStops.includes('No automatic write-off when a date looks expired.'));
    assert.equal((await ana.get('/api/kb/playbooks/NOPE')).status, 404);
    const art = (await ana.get('/api/kb/articles/medicare-timely-filing')).body;
    assert.ok(art.facts.every((f: any) => f.citation.url && f.citation.retrievedAt));
    assert.equal(art.reviewStatus, 'draft');
    assert.ok((await ana.get('/api/kb/glossary')).body.length >= 30);
  } finally { await h.close(); }
});

test('KB scope: payer directory is tenant/client isolated; reference data needs a valid scope', async () => {
  const h = await start();
  try {
    const anaOrtho = await h.as('u_ana');
    const anaDerm = await h.as('u_ana', 'tn_demo', 'cl_derm');
    const bea = await h.as('u_bea', 'tn_other', 'cl_other');
    const ada = await h.as('u_ada');

    const ortho = (await anaOrtho.get('/api/kb/payers')).body;
    assert.deepEqual(ortho.map((p: any) => p.payerId).sort(), ['demo-payer', 'demo-payer-b']);
    assert.ok(ortho.every((p: any) => p.synthetic === true && p.tenantId === 'tn_demo' && p.clientId === 'cl_ortho'));
    const derm = (await anaDerm.get('/api/kb/payers')).body;
    assert.deepEqual(derm.map((p: any) => p.payerId), ['demo-payer']);
    assert.equal(derm[0].tatCommitments[0].value, 21, 'client-specific override');
    assert.equal((await anaDerm.get('/api/kb/payers/demo-payer-b')).status, 404, 'other client of same tenant');

    const other = (await bea.get('/api/kb/payers')).body;
    assert.deepEqual(other.map((p: any) => `${p.tenantId}/${p.payerId}`), ['tn_other/demo-payer']);
    assert.equal((await bea.get('/api/kb/payers/demo-payer-b')).status, 404);
    assert.equal((await bea.get('/api/kb/search?q=555-0142&types=payer')).body.results.length, 0);
    assert.ok((await anaOrtho.get('/api/kb/search?q=555-0142&types=payer')).body.results.some((r: any) => r.ref === 'demo-payer-b'));
    assert.equal((await bea.get('/api/kb/search?q=demo%20payer')).body.results.filter((r: any) => r.kind === 'payer').length, 1);
    const beaSpoof = await h.as('u_bea', 'tn_demo', 'cl_ortho');
    assert.equal((await beaSpoof.get('/api/kb/payers')).body.error.code, 'scope_not_found');
    assert.equal((await beaSpoof.get('/api/kb/codes/carc/1')).status, 404, 'even global data requires a granted scope');

    // Auditor (read-only, cl_ortho only) can read reference data in scope but not cl_derm.
    assert.equal((await ada.get('/api/kb/codes/carc/1')).status, 200);
    assert.equal((await ada.get('/api/kb/payers')).body.length, 2);
    const adaDerm = await h.as('u_ada', 'tn_demo', 'cl_derm');
    assert.equal((await adaDerm.get('/api/kb/payers')).status, 404);

    assert.equal((await fetch(`${h.base}/api/kb/search?q=deductible`)).status, 401);
  } finally { await h.close(); }
});
