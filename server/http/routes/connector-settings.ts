// Connect providers (ADR 0110): keys and modes for the live connectors, entered in the app.
// Every route needs integration_admin; writes are audited without values. Recording a customer
// authorization stays on POST /api/integrations/connectors/:id/authorization.
import type { ModuleApi } from '../app.ts';
import type { Scope } from '../../services/auth.ts';
import { forbidden } from '../../util.ts';
import '../../connectors/registry.ts';
import { connectSettings, saveMode, saveValues, settingHistory, testProvider, useConnectorSettings } from '../../connectors/live/connector-settings.ts';

/**
 * Provider keys are deployment-wide, but integration_admin is granted per client. Outside
 * synthetic, only users named in AR_DEPLOYMENT_ADMINS may touch them (on top of integration_admin,
 * which the service checks); an empty list locks the
 * page (fail closed) rather than letting any client's supervisor change every client's keys.
 */
export function requireDeploymentAdmin(s: Scope, opts: { synthetic: boolean; deploymentAdmins: string[] }): Scope {
  if (opts.synthetic) return s;
  if (!opts.deploymentAdmins.includes(s.userId)) {
    throw forbidden('Provider keys are deployment-wide. Only users listed in AR_DEPLOYMENT_ADMINS may view or change them.');
  }
  return s;
}

export function register(api: ModuleApi) {
  const { db, route, config } = api;
  useConnectorSettings(db, { synthetic: config.synthetic, dbPath: config.dbPath });
  const scoped = (ctx: Parameters<typeof api.scoped>[0]) => requireDeploymentAdmin(api.scoped(ctx), config);

  route('GET', '/api/integrations/connect', (ctx) => connectSettings(db, scoped(ctx)));
  route('GET', '/api/integrations/connect/:provider/history', (ctx) => ({ changes: settingHistory(db, scoped(ctx), ctx.params.provider) }));
  route('PUT', '/api/integrations/connect/:provider/values', (ctx) => saveValues(db, scoped(ctx), ctx.params.provider, ctx.body ?? {}));
  route('PUT', '/api/integrations/connect/:provider/mode', (ctx) => saveMode(db, scoped(ctx), ctx.params.provider, ctx.body ?? {}));
  route('POST', '/api/integrations/connect/:provider/test', (ctx) => testProvider(db, scoped(ctx), ctx.params.provider));
}
