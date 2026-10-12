// ADR 0060 cross-workstream routes: verbal payer requests (voice <-> review guard).
import type { ModuleApi } from '../app.ts';
import { listVerbalRequests, releaseVerbalRequest } from '../../services/verbal-requests.ts';

export function register({ db, route, scoped }: ModuleApi): void {
  route('GET', '/api/accounts/:id/verbal-requests', (ctx) => listVerbalRequests(db, scoped(ctx), ctx.params.id));
  route('POST', '/api/verbal-requests/:answerId/release', (ctx) => releaseVerbalRequest(db, scoped(ctx), ctx.params.answerId, String(ctx.body?.reason ?? '')));
}
