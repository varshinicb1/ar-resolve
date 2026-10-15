// Connect providers (ADR 0110): keys and modes for the live connectors, entered in the app.
// Every route needs integration_admin; writes are audited without values. Recording a customer
// authorization stays on POST /api/integrations/connectors/:id/authorization.
import type { ModuleApi } from '../app.ts';
import '../../connectors/registry.ts';
import { connectSettings, saveMode, saveValues, settingHistory, testProvider, useConnectorSettings } from '../../connectors/live/connector-settings.ts';

export function register(api: ModuleApi) {
  const { db, route, scoped, config } = api;
  useConnectorSettings(db, { synthetic: config.synthetic, dbPath: config.dbPath });

  route('GET', '/api/integrations/connect', (ctx) => connectSettings(db, scoped(ctx)));
  route('GET', '/api/integrations/connect/:provider/history', (ctx) => ({ changes: settingHistory(db, scoped(ctx), ctx.params.provider) }));
  route('PUT', '/api/integrations/connect/:provider/values', (ctx) => saveValues(db, scoped(ctx), ctx.params.provider, ctx.body ?? {}));
  route('PUT', '/api/integrations/connect/:provider/mode', (ctx) => saveMode(db, scoped(ctx), ctx.params.provider, ctx.body ?? {}));
  route('POST', '/api/integrations/connect/:provider/test', (ctx) => testProvider(db, scoped(ctx), ctx.params.provider));
}
