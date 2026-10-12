// Shared setup for the operations suites (follow-ups, outcomes, write-back, controls, analytics).
import { setClock } from '../server/util.ts';
import { importCohort, accountByExt, type Client, type Harness } from './helpers.ts';

// A clock that starts at `iso` and moves with real time, so ordering by timestamp still works.
export function clockAt(iso: string): void {
  const base = Date.parse(iso);
  const t0 = Date.now();
  setClock(() => new Date(base + (Date.now() - t0)));
}
export function resetClock(): void { setClock(null); }

export async function investigated(h: Harness, ext = 'SYN-1042') {
  const ana = await h.as('u_ana');
  const rui = await h.as('u_rui');
  if (!(await ana.get('/api/accounts')).body.total) await importCohort(ana);
  const id = await accountByExt(ana, ext);
  await ana.post(`/api/accounts/${id}/investigate`);
  const v = (await ana.get(`/api/accounts/${id}`)).body;
  return { ana, rui, id, v, act: v.actions[0] };
}

export const approve = (c: Client, act: any, revision: number) =>
  c.post(`/api/actions/${act.actionId}/review`, { decision: 'approved', rationale: 'Accumulator shows deductible met before this claim', payloadSha256: act.payloadSha256, accountRevision: revision });

export const reviewWb = (c: Client, wb: { actionId: string; payloadSha256: string; accountRevision: number }, decision = 'approved') =>
  c.post(`/api/writebacks/${wb.actionId}/review`, { decision, rationale: 'Note matches verified facts', payloadSha256: wb.payloadSha256, accountRevision: wb.accountRevision });
