// E08 Voice routes: simulated payer calls, call policy and signed provider callbacks.
import type { ModuleApi } from '../app.ts';
import { tx } from '../../db/db.ts';
import { advanceCall, cancelCall, endHumanCall, handleVoiceCallback, startCall, takeOver } from '../../services/voice/engine.ts';
import { updatePolicy } from '../../services/voice/policy.ts';
import { accountCalls, callDetail, listCalls, voiceConfig } from '../../services/voice/views.ts';

export function register({ db, route, scoped, header }: ModuleApi): void {
  route('GET', '/api/calls', (ctx) => listCalls(db, scoped(ctx), ctx.query.get('filter') ?? 'all'));
  route('GET', '/api/calls/config', (ctx) => voiceConfig(db, scoped(ctx)));
  route('POST', '/api/calls/policy', (ctx) => tx(db, () => updatePolicy(db, scoped(ctx), ctx.body?.patch ?? {}, String(ctx.body?.reason ?? ''))));
  route('GET', '/api/calls/:id', (ctx) => callDetail(db, scoped(ctx), ctx.params.id));
  route('POST', '/api/calls/:id/advance', (ctx) => advanceCall(db, scoped(ctx), ctx.params.id, Number(ctx.body?.steps ?? 1)));
  route('POST', '/api/calls/:id/cancel', (ctx) => cancelCall(db, scoped(ctx), ctx.params.id, String(ctx.body?.reason ?? '')));
  route('POST', '/api/calls/:id/takeover', (ctx) => takeOver(db, scoped(ctx), ctx.params.id, String(ctx.body?.reason ?? '')));
  route('POST', '/api/calls/:id/end', (ctx) => endHumanCall(db, scoped(ctx), ctx.params.id, String(ctx.body?.notes ?? '')));
  route('GET', '/api/accounts/:id/calls', (ctx) => accountCalls(db, scoped(ctx), ctx.params.id));
  route('POST', '/api/accounts/:id/calls', (ctx) => startCall(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));
  // Signed status callback from the (simulated) telephony provider; no session.
  route('POST', '/api/webhooks/sim-voice', (ctx) => handleVoiceCallback(db, ctx.raw, header(ctx, 'x-sim-voice-signature'), header(ctx, 'x-sim-voice-timestamp')));
}
