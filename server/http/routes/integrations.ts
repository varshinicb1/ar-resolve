// Integrations workstream routes: connector registry and configuration, onboarding records,
// authorizations and the live gate, EDI upload/preview/ingest, simulated clearinghouse,
// FHIR pull, connector events and the generic signed webhook endpoint.
import { readdirSync, readFileSync } from 'node:fs';
import type { ModuleApi } from '../app.ts';
import { invalid } from '../../util.ts';
import { requirePerm, type Scope } from '../../services/auth.ts';
import '../../connectors/registry.ts';
import {
  ONBOARDING_FIELDS, adapterFor, allAdapters, getConfig, health, invoke, latestAuthorization, latestOnboarding, liveGate, newRequest, recentEvents, recordAuthorization,
  resetCircuit, saveOnboarding, setMode, updateSettings, type ActionClass, type Mode,
} from '../../connectors/framework.ts';
import { MAPPINGS, mapping } from '../../connectors/mappings.ts';
import { fileView, ingestEdi, listFiles, previewEdi } from '../../connectors/ingest.ts';
import { armFault, listChFaults, runEligibilityInquiry, runStatusInquiry } from '../../connectors/sim-clearinghouse.ts';
import { pullFhir } from '../../connectors/fhir/service.ts';
import { buildSimWebhook, endpointAccountFor, objectStates, receiveWebhook } from '../../connectors/webhooks.ts';
import { LIVE_ADAPTERS } from '../../connectors/live-adapters.ts';
import { tx } from '../../db/db.ts';

const FIXTURES = new URL('../../../fixtures/x12/', import.meta.url);

function connectorSummary(api: ModuleApi, s: Scope, id: string) {
  const a = adapterFor(id);
  const c = getConfig(api.db, s, id);
  const ob = latestOnboarding(api.db, s, id);
  const live = LIVE_ADAPTERS.find((l) => l.descriptor.id === id);
  return {
    ...a.descriptor, mode: c.mode, enabled: c.enabled, settings: c.settings, health: health(api.db, s, id),
    onboarding: ob ? { version: ob.version, completeness: ob.completeness, recordedAt: ob.recordedAt, recordedBy: ob.recordedBy } : { version: 0, completeness: { filled: 0, total: ONBOARDING_FIELDS.length, ratio: 0, missing: ONBOARDING_FIELDS.map((f) => f.key) } },
    authorization: latestAuthorization(api.db, s, id), checklist: live?.checklist ?? null,
  };
}

export function register(api: ModuleApi) {
  const { db, route, scoped } = api;
  const admin = (ctx: Parameters<typeof scoped>[0]) => { const s = scoped(ctx); requirePerm(s, 'integration_admin'); return s; };

  route('GET', '/api/integrations', (ctx) => {
    const s = admin(ctx);
    return {
      connectors: allAdapters().map((a) => connectorSummary(api, s, a.descriptor.id)),
      mappings: MAPPINGS.map((m) => ({ id: m.id, version: m.version, transactionKind: m.transactionKind, sha256: mapping(m.id).sha256, fields: m.fields.length })),
      events: recentEvents(db, s, null, 30),
      files: listFiles(db, s),
      faults: listChFaults(db, s),
      webhookStates: objectStates(db, s),
      onboardingFields: ONBOARDING_FIELDS,
    };
  });
  route('GET', '/api/integrations/connectors/:id', (ctx) => {
    const s = admin(ctx);
    return { ...connectorSummary(api, s, ctx.params.id), onboardingRecord: latestOnboarding(db, s, ctx.params.id), liveGate: liveGate(db, s, ctx.params.id), events: recentEvents(db, s, ctx.params.id, 50) };
  });
  route('GET', '/api/integrations/mappings/:id', (ctx) => { admin(ctx); return mapping(ctx.params.id); });
  route('POST', '/api/integrations/connectors/:id/onboarding', (ctx) => saveOnboarding(db, admin(ctx), ctx.params.id, ctx.body?.record ?? {}));
  route('POST', '/api/integrations/connectors/:id/authorization', (ctx) => recordAuthorization(db, admin(ctx), ctx.params.id, ctx.body ?? {}));
  route('POST', '/api/integrations/connectors/:id/mode', (ctx) => setMode(db, admin(ctx), ctx.params.id, String(ctx.body?.mode ?? '') as Mode));
  route('POST', '/api/integrations/connectors/:id/settings', (ctx) => {
    const s = admin(ctx);
    adapterFor(ctx.params.id);
    return updateSettings(db, s, ctx.params.id, (ctx.body?.settings ?? {}) as Record<string, unknown>, typeof ctx.body?.enabled === 'boolean' ? ctx.body.enabled : undefined);
  });
  route('POST', '/api/integrations/connectors/:id/circuit/reset', (ctx) => { const s = admin(ctx); tx(db, () => resetCircuit(db, s, ctx.params.id)); return health(db, s, ctx.params.id); });
  // Exercise a connector's boundary without data: live adapters must refuse.
  route('POST', '/api/integrations/connectors/:id/probe', (ctx) => {
    const s = admin(ctx);
    const a = adapterFor(ctx.params.id);
    const actionClass = (ctx.body?.actionClass ?? a.descriptor.capabilities[0]) as ActionClass;
    return tx(db, () => invoke(db, s, ctx.params.id, newRequest(s, actionClass, { probe: true })));
  });

  // ---- EDI upload
  route('GET', '/api/integrations/edi/samples', (ctx) => {
    const s = admin(ctx);
    const names = readdirSync(FIXTURES).filter((n) => n.endsWith('.edi') && (n.includes(s.clientId) || !/cl_\w+/.test(n))).sort();
    return names.map((name) => ({ name, content: readFileSync(new URL(name, FIXTURES), 'utf8') }));
  });
  route('POST', '/api/integrations/edi/preview', (ctx) => previewEdi(db, scoped(ctx), ctx.body ?? {}));
  route('POST', '/api/integrations/edi/ingest', (ctx) => ingestEdi(db, scoped(ctx), ctx.body ?? {}));
  route('GET', '/api/integrations/edi/files', (ctx) => listFiles(db, admin(ctx)));
  route('GET', '/api/integrations/edi/files/:id', (ctx) => fileView(db, admin(ctx), ctx.params.id));

  // ---- simulated clearinghouse and FHIR (research steps)
  route('POST', '/api/integrations/accounts/:id/status-inquiry', (ctx) => runStatusInquiry(db, scoped(ctx), ctx.params.id));
  route('POST', '/api/integrations/accounts/:id/eligibility-inquiry', (ctx) => runEligibilityInquiry(db, scoped(ctx), ctx.params.id));
  route('POST', '/api/integrations/accounts/:id/fhir-pull', (ctx) => pullFhir(db, scoped(ctx), ctx.params.id));
  route('POST', '/api/integrations/sim-clearinghouse/faults', (ctx) => armFault(db, scoped(ctx), ctx.body?.fault, ctx.body?.remaining));

  // ---- webhooks: signed inbound endpoint (no session) and a simulator for the UI
  route('POST', '/api/webhooks/connectors/:provider', (ctx) => receiveWebhook(db, ctx.params.provider, ctx.raw, (k) => api.header(ctx, k)));
  route('POST', '/api/integrations/webhooks/simulate', (ctx) => {
    const s = admin(ctx);
    const account = endpointAccountFor(db, s, 'sim_clearinghouse');
    if (!account) throw invalid('No simulated clearinghouse endpoint for this client');
    const payload = { eventId: String(ctx.body?.eventId ?? `simch-${Date.now()}`), occurredAt: String(ctx.body?.occurredAt ?? new Date().toISOString()), type: 'claim_status',
      claimReference: String(ctx.body?.claimReference ?? ''), statusCategory: String(ctx.body?.statusCategory ?? 'P1'), correction: ctx.body?.correction === true };
    const w = buildSimWebhook(db, account, payload);
    const h = (k: string) => (w.headers as Record<string, string>)[k];
    const first = receiveWebhook(db, 'sim_clearinghouse', w.raw, h);
    const replay = ctx.body?.sendDuplicate ? receiveWebhook(db, 'sim_clearinghouse', w.raw, h) : null;
    return { first, replay };
  });
}
