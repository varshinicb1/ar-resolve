import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, importCohort, accountByExt } from './helpers.ts';
import { all } from '../server/db/db.ts';

test('import validates rows, rejects ambiguity and is idempotent', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    const samples = (await ana.get('/api/imports/samples')).body;
    const preview = (await ana.post('/api/imports/preview', { sourceName: 'bad.csv', csv: samples.ambiguous.csv })).body;
    const byLine = Object.fromEntries(preview.rows.map((r: any) => [r.line, r]));
    assert.equal(byLine[2].status, 'rejected'); // duplicated external_id within file
    assert.equal(byLine[3].status, 'rejected');
    assert.match(byLine[4].errors.join(), /service_date/); // 2026-02-30
    assert.match(byLine[5].errors.join(), /balance_cents/); // 12.50
    assert.match(byLine[6].errors.join(), /payer_id/);
    assert.equal(preview.committed, false);
    assert.equal((await ana.get('/api/accounts')).body.total, 0, 'preview writes nothing');
    const first = await importCohort(ana);
    assert.equal(first.summary.accepted, 10);
    const again = await importCohort(ana);
    assert.deepEqual(again.summary, { accepted: 0, rejected: 0, duplicates: 10 });
  } finally { await h.close(); }
});

test('identity conflict blocks the account, the proposal and calls', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    await importCohort(ana);
    const id = await accountByExt(ana, 'SYN-1044');
    const r = (await ana.post(`/api/accounts/${id}/investigate`)).body;
    assert.equal(r.state, 'blocked');
    assert.equal(r.actionId, null);
    const v = (await ana.get(`/api/accounts/${id}`)).body;
    const identity = v.facts.find((f: any) => f.key === 'identityVerified');
    assert.equal(identity.value, false);
    assert.ok(identity.locator.checks.some((c: any) => c.field === 'patient token' && !c.match));
    assert.equal((await ana.post(`/api/accounts/${id}/calls/simulate`)).status, 409);
  } finally { await h.close(); }
});

test('missing evidence abstains instead of guessing', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    await importCohort(ana);
    const id = await accountByExt(ana, 'SYN-1048');
    const r = (await ana.post(`/api/accounts/${id}/investigate`)).body;
    assert.equal(r.outcome, 'collect_evidence');
    assert.equal(r.actionId, null);
    const v = (await ana.get(`/api/accounts/${id}`)).body;
    for (const k of ['allowedCents', 'appliedCents', 'adjustmentGroup']) assert.equal(v.facts.find((f: any) => f.key === k).status, 'missing');
    assert.equal(v.facts.find((f: any) => f.key === 'allowedCents').value, null, 'missing is not zero');
  } finally { await h.close(); }
});

test('contradictory sources: conflict, supersede, correct, recompute', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    const rui = await h.as('u_rui');
    await importCohort(ana);
    const id = await accountByExt(ana, 'SYN-1046');
    const first = (await ana.post(`/api/accounts/${id}/investigate`)).body;
    assert.equal(first.outcome, 'patient_responsibility_review');
    const call = (await ana.post(`/api/accounts/${id}/calls/simulate`)).body;
    assert.equal(call.outcome, 'specialist_review');
    assert.deepEqual(call.reasonCodes, ['SOURCE_CONFLICT']);
    assert.deepEqual(call.superseded, [first.actionId]);
    let v = (await ana.get(`/api/accounts/${id}`)).body;
    const met = v.facts.find((f: any) => f.key === 'metBeforeCents');
    assert.equal(met.status, 'conflicting');
    assert.deepEqual(met.candidates.map((c: any) => c.value).sort(), [120000, 150000]);
    assert.equal(v.actions.find((a: any) => a.actionId === first.actionId).state, 'superseded');

    // Correction needs a reason and the current revision.
    assert.equal((await rui.post(`/api/accounts/${id}/facts/metBeforeCents/correct`, { value: 120000, reason: '', expectedRevision: v.account.revision })).status, 400);
    assert.equal((await rui.post(`/api/accounts/${id}/facts/metBeforeCents/correct`, { value: 120000, reason: 'Accumulator snapshot is the adjudication-time source', expectedRevision: v.account.revision - 1 })).status, 409);
    assert.equal((await rui.post(`/api/accounts/${id}/facts/metBeforeCents/correct`, { value: 1200.5, reason: 'Accumulator snapshot', expectedRevision: v.account.revision })).status, 400);
    const fixed = (await rui.post(`/api/accounts/${id}/facts/metBeforeCents/correct`, { value: 120000, reason: 'Accumulator snapshot is the adjudication-time source', expectedRevision: v.account.revision })).body;
    assert.equal(fixed.outcome, 'patient_responsibility_review');
    assert.ok(fixed.actionId && fixed.actionId !== first.actionId);
    v = (await ana.get(`/api/accounts/${id}`)).body;
    const corrected = v.facts.find((f: any) => f.key === 'metBeforeCents');
    assert.equal(corrected.status, 'verified');
    assert.equal(corrected.value, 120000);
    // Original observations are preserved alongside the correction.
    assert.equal(corrected.candidates.length, 3);
    assert.ok(v.timeline.some((e: any) => e.eventType === 'fact_corrected'));
  } finally { await h.close(); }
});

test('reported call facts complete the record; transcript instructions are inert', async () => {
  const h = await start();
  try {
    const ana = await h.as('u_ana');
    await importCohort(ana);
    const id = await accountByExt(ana, 'SYN-1045');
    assert.equal((await ana.post(`/api/accounts/${id}/investigate`)).body.outcome, 'collect_evidence');
    const call = (await ana.post(`/api/accounts/${id}/calls/simulate`)).body;
    assert.equal(call.outcome, 'secondary_review');
    const v = (await ana.get(`/api/accounts/${id}`)).body;
    assert.equal(v.facts.find((f: any) => f.key === 'metBeforeCents').status, 'reported');
    const transcript = v.evidence.find((e: any) => e.kind === 'call_transcript');
    assert.ok(transcript.content.turns.some((t: any) => /write-off/.test(t.text)), 'injection text is stored as evidence');
    const kinds = all<{ kind: string }>(h.db, 'SELECT kind FROM proposed_actions').map((r) => r.kind);
    assert.ok(!kinds.some((k) => /write|bill|code/.test(k)), 'no prohibited action proposed');
    const obsKeys = all<{ fact_key: string }>(h.db, `SELECT fact_key FROM observations WHERE evidence_id = ?`, transcript.evidenceId).map((r) => r.fact_key).sort();
    assert.deepEqual(obsKeys, ['limitCents', 'metBeforeCents'], 'only structured extracts become observations');
  } finally { await h.close(); }
});
