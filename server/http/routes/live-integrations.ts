// Real-integrations workstream routes (ADR 0100): live connector overview (mode, env var presence,
// authorization, gate, last smoke result), authorization revocation, and account-driven live reads.
// Payer writes are not exposed here: they stay on proposal -> approval -> outbox.
import type { ModuleApi } from '../app.ts';
import { requirePerm } from '../../services/auth.ts';
import '../../connectors/registry.ts';
import { revokeAuthorization } from '../../connectors/live/gate.ts';
import { liveClaimStatus, liveEligibility, liveOverview, pollStediRemittance, twilioTestCall } from '../../connectors/live/service.ts';

export function register(api: ModuleApi) {
  const { db, route, scoped } = api;
  const admin = (ctx: Parameters<typeof scoped>[0]) => { const s = scoped(ctx); requirePerm(s, 'integration_admin'); return s; };

  route('GET', '/api/integrations/live', (ctx) => ({ providers: liveOverview(db, admin(ctx)) }));
  route('POST', '/api/integrations/live/connectors/:id/revoke', (ctx) => revokeAuthorization(db, admin(ctx), ctx.params.id, ctx.body ?? {}));
  route('POST', '/api/integrations/live/accounts/:id/eligibility', (ctx) => liveEligibility(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));
  route('POST', '/api/integrations/live/accounts/:id/claim-status', (ctx) => liveClaimStatus(db, scoped(ctx), ctx.params.id, ctx.body ?? {}));
  route('POST', '/api/integrations/live/stedi/remittance/poll', (ctx) => pollStediRemittance(db, admin(ctx), ctx.body ?? {}));
  route('POST', '/api/integrations/live/twilio/test-call', (ctx) => twilioTestCall(db, admin(ctx), ctx.body ?? {}));
}
