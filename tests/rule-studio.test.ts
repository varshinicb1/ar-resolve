import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, importCohort, accountByExt, type Client } from './helpers.ts';
import { setClock } from '../server/util.ts';
import { ENVIRONMENT } from '../server/http/app.ts';
import { draftsMayRun, PHASE0_ENVIRONMENT, resolveRunnable } from '../server/services/scenario.ts';
import { all } from '../server/db/db.ts';

// Status freshness is date-relative: run at the cohort's evaluation clock.
before(() => setClock(() => new Date('2026-10-12T12:00:00.000Z')));
after(() => setClock(null));

const R = '/api/rule-studio';

async function investigate(c: Client, ext: string) {
  const id = await accountByExt(c, ext);
  const r = await c.post(`/api/accounts/${id}/investigate`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { id, ...r.body };
}

test('Phase 0 rule: drafts run only because the environment is synthetic', async () => {
  assert.equal(PHASE0_ENVIRONMENT, ENVIRONMENT);
  assert.equal(draftsMayRun('synthetic'), true);
  assert.equal(draftsMayRun('assisted_live'), false);
  const h = await start();
  try {
    const scope = { tenantId: 'tn_demo', clientId: 'cl_ortho' };
    const live = resolveRunnable(h.db, scope, 'DED01', { env: 'assisted_live' });
    assert.equal(live.ok, false);
    assert.equal(!live.ok && live.reason, 'DRAFT_NOT_RUNNABLE');
    const syn = resolveRunnable(h.db, scope, 'DED01');
    assert.equal(syn.ok && syn.via, 'synthetic_draft_baseline');
  } finally { await h.close(); }
});

test('scenario selection routes each synthetic account to its pack end to end', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana', 'tn_demo', 'cl_multi');
    await importCohort(ana, 'cl_multi');
    const expectations: [string, string, string][] = [
      ['SYN-3101', 'PEND01', 'request_status_update'], ['SYN-3201', 'DOC01', 'submit_documents'], ['SYN-3301', 'DUP01', 'review_existing_disposition'],
      ['SYN-3401', 'COB01', 'cob_specialist_task'], ['SYN-3402', 'TF01', 'collect_evidence'], ['SYN-3304', 'ROUTE00', 'specialist_review'],
      ['SYN-3501', 'ROUTE00', 'specialist_review'], ['SYN-3502', 'ROUTE00', 'collect_evidence'], ['SYN-3105', 'PEND01', 'collect_evidence'],
    ];
    for (const [ext, rule, outcome] of expectations) {
      const r = await investigate(ana, ext);
      assert.deepEqual([ext, r.rule.id, r.outcome], [ext, rule, outcome]);
    }
    // Ambiguous selection is explained on the account, with both candidates.
    const amb = (await ana.get(`/api/accounts/${await accountByExt(ana, 'SYN-3304')}`)).body;
    assert.equal(amb.scenario.lastRun.selection.status, 'ambiguous');
    assert.deepEqual(amb.scenario.lastRun.selection.candidates, ['DED01', 'DUP01']);
    assert.equal(amb.account.state, 'specialist_review');
    assert.deepEqual(amb.facts.map((f: any) => f.key), ['lineAdjustments', 'remarkCodes', 'claimStatus']);
    // Identity mismatch from the status response blocks the account.
    assert.equal((await ana.get(`/api/accounts/${await accountByExt(ana, 'SYN-3105')}`)).body.account.state, 'blocked');
    // Specialist route shows its checklist.
    const tf = (await ana.get(`/api/accounts/${await accountByExt(ana, 'SYN-3402')}`)).body;
    assert.deepEqual(tf.latestRun.result.checklist.filter((c: any) => !c.satisfied).map((c: any) => c.key), ['filingRuleReference']);

    // Transcript instructions are evidence only: the call yields a payer commitment, nothing else.
    const id3101 = await accountByExt(ana, 'SYN-3101');
    const call = (await ana.post(`/api/accounts/${id3101}/calls/simulate`)).body;
    assert.equal(call.outcome, 'schedule_followup');
    const v = (await ana.get(`/api/accounts/${id3101}`)).body;
    assert.equal(v.actions[0].payload.request.followUpDate, '2026-10-30');
    assert.equal(v.facts.find((f: any) => f.key === 'payerCommitmentDate').status, 'reported');
    assert.ok(v.actions[0].payload.prohibited.includes('automatic_writeoff'));
    const id3305 = await accountByExt(ana, 'SYN-3305');
    await investigate(ana, 'SYN-3305');
    assert.equal((await ana.post(`/api/accounts/${id3305}/calls/simulate`)).body.outcome, 'review_existing_disposition');

    // Optional facts do not block approval; a DOC01 submission is approvable and dispatches through the outbox.
    const rui = await h.as('u_rui', 'tn_demo', 'cl_multi');
    const d = (await rui.get(`/api/accounts/${await accountByExt(ana, 'SYN-3201')}`)).body;
    const act = d.actions[0];
    assert.equal(act.kind, 'submit_documents');
    assert.deepEqual(act.checks.filter((c: any) => !c.pass), []);
    const ok = await rui.post(`/api/actions/${act.actionId}/review`, { decision: 'approved', rationale: 'Manifest matches the payer request', payloadSha256: act.payloadSha256, accountRevision: d.account.revision });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    // Extended facts are correctable with typed validation.
    const sam = await h.as('u_rui', 'tn_demo', 'cl_multi');
    const id3402 = await accountByExt(ana, 'SYN-3402');
    const rev = (await sam.get(`/api/accounts/${id3402}`)).body.account.revision;
    assert.equal((await sam.post(`/api/accounts/${id3402}/facts/filingRuleReference/correct`, { value: '', reason: 'Client contract section', expectedRevision: rev })).status, 400);
    const fixed = await sam.post(`/api/accounts/${id3402}/facts/filingRuleReference/correct`, { value: 'Synthetic contract 4.2', reason: 'Client supplied the filing rule', expectedRevision: rev });
    assert.equal(fixed.body.outcome, 'timely_filing_review_task');
  } finally { await h.close(); }
});

test('rule studio lifecycle: draft, validate, separated review, publish pins, rollback, retire', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana', 'tn_demo', 'cl_multi');
    const sam = await h.as('u_sam', 'tn_demo', 'cl_multi'); // supervisor + rule_approver
    const lee = await h.as('u_lee', 'tn_demo', 'cl_multi'); // reviewer + rule_approver
    const rui = await h.as('u_rui', 'tn_demo', 'cl_multi'); // reviewer, no rule_approver
    await importCohort(ana, 'cl_multi');

    // An account with a proposal in flight on the synthetic draft baseline v1.
    const pinnedRun = await investigate(ana, 'SYN-3103');
    assert.deepEqual([pinnedRun.rule.id, pinnedRun.rule.version, pinnedRun.rule.via, pinnedRun.outcome], ['PEND01', 1, 'synthetic_draft_baseline', 'request_status_update']);

    const packs = (await ana.get(`${R}/packs`)).body;
    assert.equal(packs.packs.length, 10);
    assert.equal(packs.packs.find((p: any) => p.ruleId === 'DED01').active.via, 'synthetic_draft_baseline');
    assert.deepEqual(packs.permissions, { author: false, approve: false, view: true });

    // Authoring permissions.
    assert.equal((await ana.post(`${R}/packs/PEND01/drafts`, {})).status, 403, 'specialist cannot author');
    const draft = (await sam.post(`${R}/packs/PEND01/drafts`, { baseVersion: 1 })).body;
    assert.equal(draft.definition.scope.client, 'cl_multi');

    // Data only: logic, actions and executable text are not editable.
    const bad = await sam.post(`${R}/drafts/${draft.draftId}/edit`, { expectedEditSeq: 1, patch: { logicModule: 'evil.v1', evaluate: 'return "submit"' } });
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.body.error.details.errors), /logicModule is not editable/);
    assert.equal((await sam.post(`${R}/drafts/${draft.draftId}/edit`, { expectedEditSeq: 1, patch: { params: { statusMaxAgeDays: 999 } } })).status, 400);
    assert.equal((await sam.post(`${R}/drafts/${draft.draftId}/edit`, { expectedEditSeq: 1, patch: { prohibitedActions: ['claim_resubmission'] } })).status, 400, 'cannot drop reviewed prohibitions');
    const edited = await sam.post(`${R}/drafts/${draft.draftId}/edit`, { expectedEditSeq: 1, patch: { params: { statusMaxAgeDays: 60 }, outcomeLabels: { request_status_update: 'Ask payer for status' } } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(edited.body.diff.map((d: any) => d.path).sort(), ['outcomeLabels', 'params.statusMaxAgeDays', 'scope.client', 'scope.tenant']);
    assert.equal((await sam.post(`${R}/drafts/${draft.draftId}/edit`, { expectedEditSeq: 1, patch: { owner: 'Someone' } })).status, 409, 'stale edit');

    // Before/after impact: fixtures stay green; the in-flight account is reported as pinned.
    const impact = (await sam.get(`${R}/drafts/${draft.draftId}/impact`)).body;
    assert.equal(impact.fixtures.failing, 0);
    const row = impact.accounts.rows.find((r: any) => r.externalId === 'SYN-3103');
    assert.deepEqual([row.before, row.after, row.pinned.version], ['request_status_update', 'request_status_update', 1]);
    assert.ok(row.beforeReasons.includes('STATUS_STALE') && !row.afterReasons.includes('STATUS_STALE'));

    // Validate freezes an immutable version.
    const val = (await sam.post(`${R}/drafts/${draft.draftId}/validate`)).body;
    assert.equal(val.ok, true, JSON.stringify(val.report));
    assert.equal(val.version, 2);
    assert.equal(val.report.fixtures.passed, val.report.fixtures.total);
    assert.equal((await sam.post(`${R}/drafts/${draft.draftId}/edit`, { expectedEditSeq: 2, patch: { owner: 'x' } })).status, 409, 'frozen');
    assert.throws(() => all(h.db, `UPDATE rule_versions SET definition='{}' WHERE rule_id='PEND01' AND version=2`), /immutable/);

    // Not approved yet: cannot publish.
    assert.equal((await lee.post(`${R}/packs/PEND01/versions/2/publish`, { reason: 'Too early' })).body.error.code, 'not_approved');
    assert.equal((await sam.post(`${R}/packs/PEND01/versions/2/submit`)).status, 200);
    // Separation of duties and the rule_approver permission.
    assert.equal((await sam.post(`${R}/packs/PEND01/versions/2/review`, { decision: 'approve', rationale: 'I wrote it, looks good' })).status, 403, 'author cannot approve');
    assert.equal((await rui.post(`${R}/packs/PEND01/versions/2/review`, { decision: 'approve', rationale: 'Looks good' })).status, 403, 'no rule_approver permission');
    const approved = await lee.post(`${R}/packs/PEND01/versions/2/review`, { decision: 'approve', rationale: 'Threshold matches client policy memo' });
    assert.equal(approved.body.status, 'approved');
    const pub = await lee.post(`${R}/packs/PEND01/versions/2/publish`, { reason: 'Client freshness policy is 60 days' });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.active.version, 2);

    // Runs pin to the version they started with; new work uses the published version.
    const again = await investigate(ana, 'SYN-3103');
    assert.deepEqual([again.rule.version, again.rule.via], [1, 'pinned']);
    const fresh = await investigate(ana, 'SYN-3106');
    assert.deepEqual([fresh.rule.version, fresh.rule.via], [2, 'activation']);
    const runs = all<{ rule_version: number }>(h.db, `SELECT w.rule_version FROM workflow_runs w JOIN accounts a USING (tenant_id, client_id, account_id) WHERE a.external_id='SYN-3106'`);
    assert.deepEqual(runs.map((r) => r.rule_version), [2]);

    // An invalid draft can never become a version.
    const d3 = (await sam.post(`${R}/packs/PEND01/drafts`, { baseVersion: 2 })).body;
    await sam.post(`${R}/drafts/${d3.draftId}/edit`, { expectedEditSeq: 1, patch: { effectiveFrom: '2027-01-01' } });
    const invalidVal = (await sam.post(`${R}/drafts/${d3.draftId}/validate`)).body;
    assert.equal(invalidVal.ok, false);
    assert.match(invalidVal.report.compatibility.errors.join(), /effective dates/);
    assert.equal(invalidVal.version, null);
    assert.equal((await lee.post(`${R}/packs/PEND01/versions/3/publish`, { reason: 'Should not exist' })).status, 404);

    // v3 (valid) then rollback to v2.
    const d4 = (await sam.post(`${R}/packs/PEND01/drafts`, { baseVersion: 2 })).body;
    await sam.post(`${R}/drafts/${d4.draftId}/edit`, { expectedEditSeq: 1, patch: { params: { statusMaxAgeDays: 30 } } });
    const v3 = (await sam.post(`${R}/drafts/${d4.draftId}/validate`)).body.version;
    assert.equal(v3, 3);
    await sam.post(`${R}/packs/PEND01/versions/3/submit`);
    await lee.post(`${R}/packs/PEND01/versions/3/review`, { decision: 'approve', rationale: 'Thirty days per memo' });
    assert.equal((await lee.post(`${R}/packs/PEND01/versions/3/publish`, { reason: 'Tighten freshness' })).body.active.version, 3);
    assert.equal((await lee.post(`${R}/packs/PEND01/versions/1/rollback`, { reason: 'Back to baseline' })).body.error.code, 'built_in_version');
    const rb = await lee.post(`${R}/packs/PEND01/versions/2/rollback`, { reason: 'Memo withdrawn; restore 60 days' });
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    assert.equal(rb.body.active.version, 2);
    const detail = (await lee.get(`${R}/packs/PEND01`)).body;
    assert.deepEqual(detail.activations.map((a: any) => [a.version, a.kind]), [[2, 'rollback'], [3, 'publish'], [2, 'publish']]);

    // A future activation does not take effect early.
    const d5 = (await sam.post(`${R}/packs/PEND01/drafts`, { baseVersion: 2 })).body;
    await sam.post(`${R}/drafts/${d5.draftId}/edit`, { expectedEditSeq: 1, patch: { owner: 'Synthetic AR operations lead' } });
    await sam.post(`${R}/drafts/${d5.draftId}/validate`);
    await sam.post(`${R}/packs/PEND01/versions/4/submit`);
    await lee.post(`${R}/packs/PEND01/versions/4/review`, { decision: 'approve', rationale: 'Owner named' });
    const future = await lee.post(`${R}/packs/PEND01/versions/4/publish`, { reason: 'Scheduled', activeFrom: '2026-11-01T00:00:00Z' });
    assert.equal(future.body.active.version, 2);
    assert.equal(future.body.active.scheduled[0].version, 4);
    assert.equal((await lee.post(`${R}/packs/PEND01/versions/2/publish`, { reason: 'Backdated', activeFrom: '2026-01-01T00:00:00Z' })).status, 400);

    // Retire stops new runs: the active version is retired, so selection abstains via ROUTE00.
    assert.equal((await lee.post(`${R}/packs/PEND01/versions/2/retire`, { reason: 'Superseded by policy review' })).status, 200);
    const stopped = await investigate(ana, 'SYN-3102');
    assert.deepEqual([stopped.rule.id, stopped.outcome, stopped.scenario.status], ['ROUTE00', 'specialist_review', 'not_runnable']);
    assert.ok(stopped.reasonCodes.includes('RULE_NOT_RUNNABLE'));
    assert.equal((await lee.post(`${R}/packs/PEND01/versions/2/publish`, { reason: 'Bring it back' })).body.error.code, 'retired');

    // Retiring the baseline the in-flight proposal used blocks its approval.
    const v = (await rui.get(`/api/accounts/${pinnedRun.id}`)).body;
    const act = v.actions[0];
    assert.equal(act.checks.find((c: any) => c.id === 'rule').pass, true);
    await lee.post(`${R}/packs/PEND01/versions/1/retire`, { reason: 'Baseline no longer permitted' });
    const v2 = (await rui.get(`/api/accounts/${pinnedRun.id}`)).body;
    assert.equal(v2.actions[0].checks.find((c: any) => c.id === 'rule').pass, false);
    const denied = await rui.post(`/api/actions/${act.actionId}/review`, { decision: 'approved', rationale: 'Status is stale, ask payer', payloadSha256: act.payloadSha256, accountRevision: v2.account.revision });
    assert.equal(denied.body.error.code, 'prerequisites_failed');

    // Everything is audited.
    const events = all<{ event_type: string }>(h.db, `SELECT event_type FROM audit_events WHERE object_type IN ('rule_version','rule_draft') ORDER BY seq`).map((e) => e.event_type);
    for (const e of ['rule_draft_created', 'rule_draft_edited', 'rule_version_validated', 'rule_validation_failed', 'rule_submitted', 'rule_approved', 'rule_published', 'rule_rolled_back', 'rule_retired']) {
      assert.ok(events.includes(e), e);
    }
  } finally { await h.close(); }
});

test('rule studio scope isolation', async () => {
  const h = await start();
  try {
    const sam = await h.as('u_sam', 'tn_demo', 'cl_multi');
    const lee = await h.as('u_lee', 'tn_demo', 'cl_multi');
    const d = (await sam.post(`${R}/packs/DOC01/drafts`, {})).body;
    await sam.post(`${R}/drafts/${d.draftId}/validate`);
    await sam.post(`${R}/packs/DOC01/versions/2/submit`);
    await lee.post(`${R}/packs/DOC01/versions/2/review`, { decision: 'approve', rationale: 'Same as baseline' });
    assert.equal((await lee.post(`${R}/packs/DOC01/versions/2/publish`, { reason: 'Activate for cl_multi' })).status, 200);

    // Other tenant: nothing visible, nothing actionable, spoofed scope does not exist.
    const bea = await h.as('u_bea', 'tn_other', 'cl_other');
    assert.equal((await bea.get(`${R}/packs/DOC01/versions/2`)).status, 404);
    assert.equal((await bea.get(`${R}/drafts/${d.draftId}`)).status, 404);
    assert.equal((await bea.post(`${R}/packs/DOC01/versions/2/retire`, { reason: 'Hostile retire' })).status, 403);
    const beaPacks = (await bea.get(`${R}/packs`)).body.packs.find((p: any) => p.ruleId === 'DOC01');
    assert.deepEqual(beaPacks.versions.map((v: any) => v.version), [1]);
    const spoof = await h.as('u_bea', 'tn_demo', 'cl_multi');
    assert.equal((await spoof.get(`${R}/packs`)).body.error.code, 'scope_not_found');
    // Same tenant, other client: version 2 is not visible and not active there.
    const leeOrtho = await h.as('u_lee', 'tn_demo', 'cl_ortho');
    assert.equal((await leeOrtho.get(`${R}/packs/DOC01/versions/2`)).status, 404);
    assert.equal((await leeOrtho.post(`${R}/packs/DOC01/versions/2/publish`, { reason: 'Cross-client publish' })).status, 404);
    const orthoDoc = (await leeOrtho.get(`${R}/packs/DOC01`)).body;
    assert.equal(orthoDoc.active.via, 'synthetic_draft_baseline');
    assert.deepEqual(orthoDoc.activations, []);
    // Auditor (cl_ortho only) can read but not author or approve; has no cl_multi scope at all.
    const ada = await h.as('u_ada', 'tn_demo', 'cl_ortho');
    assert.equal((await ada.get(`${R}/packs`)).status, 200);
    assert.equal((await ada.post(`${R}/packs/DED01/drafts`, {})).status, 403);
    assert.equal((await ada.post(`${R}/packs/DED01/versions/1/retire`, { reason: 'Auditor retire' })).status, 403);
    const adaMulti = await h.as('u_ada', 'tn_demo', 'cl_multi');
    assert.equal((await adaMulti.get(`${R}/packs/DOC01`)).body.error.code, 'scope_not_found');
    // Retiring a built-in baseline in one scope leaves other scopes untouched.
    const leeDerm = await h.as('u_lee', 'tn_demo', 'cl_derm');
    assert.equal((await leeDerm.post(`${R}/packs/DED01/versions/1/retire`, { reason: 'Derm pauses deductible pack' })).status, 200);
    assert.equal((await leeDerm.get(`${R}/packs/DED01`)).body.active.runnable, false);
    assert.equal((await leeOrtho.get(`${R}/packs/DED01`)).body.active.runnable, true);
  } finally { await h.close(); }
});
