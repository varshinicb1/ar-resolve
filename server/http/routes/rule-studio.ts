// Rule studio routes (FR05/FR06, ADR 0020). Every route resolves scope server-side.
import type { ModuleApi } from '../app.ts';
import { invalid } from '../../util.ts';
import { requirePerm } from '../../services/auth.ts';
import { SCENARIO_MAP_V1 } from '../../../shared/rules/select.ts';
import { SCENARIO_MAP_SHA256 } from '../../services/scenario.ts';
import {
  createDraft, draftImpact, editDraft, getDraft, getVersion, listPacks, packDetail, publishVersion, retireVersion, reviewVersion,
  rollbackTo, submitVersion, validateDraft, versionImpact, withdrawDraft,
} from '../../services/rule-studio.ts';

function ver(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw invalid('version must be a positive integer');
  return n;
}

export function register({ db, route, scoped }: ModuleApi): void {
  const R = '/api/rule-studio';
  route('GET', `${R}/packs`, (ctx) => listPacks(db, scoped(ctx)));
  route('GET', `${R}/selection-map`, (ctx) => { requirePerm(scoped(ctx), 'view'); return { ...SCENARIO_MAP_V1, sha256: SCENARIO_MAP_SHA256 }; });
  route('GET', `${R}/packs/:ruleId`, (ctx) => packDetail(db, scoped(ctx), ctx.params.ruleId));
  route('GET', `${R}/packs/:ruleId/versions/:version`, (ctx) => getVersion(db, scoped(ctx), ctx.params.ruleId, ver(ctx.params.version)));
  route('GET', `${R}/packs/:ruleId/versions/:version/impact`, (ctx) => versionImpact(db, scoped(ctx), ctx.params.ruleId, ver(ctx.params.version)));
  route('POST', `${R}/packs/:ruleId/drafts`, (ctx) => createDraft(db, scoped(ctx), ctx.params.ruleId, ctx.body ?? {}));
  route('GET', `${R}/drafts/:draftId`, (ctx) => getDraft(db, scoped(ctx), ctx.params.draftId));
  route('GET', `${R}/drafts/:draftId/impact`, (ctx) => draftImpact(db, scoped(ctx), ctx.params.draftId));
  route('POST', `${R}/drafts/:draftId/edit`, (ctx) => editDraft(db, scoped(ctx), ctx.params.draftId, ctx.body ?? {}));
  route('POST', `${R}/drafts/:draftId/validate`, (ctx) => validateDraft(db, scoped(ctx), ctx.params.draftId));
  route('POST', `${R}/drafts/:draftId/withdraw`, (ctx) => withdrawDraft(db, scoped(ctx), ctx.params.draftId));
  route('POST', `${R}/packs/:ruleId/versions/:version/submit`, (ctx) => submitVersion(db, scoped(ctx), ctx.params.ruleId, ver(ctx.params.version)));
  route('POST', `${R}/packs/:ruleId/versions/:version/review`, (ctx) => reviewVersion(db, scoped(ctx), ctx.params.ruleId, ver(ctx.params.version), ctx.body ?? {}));
  route('POST', `${R}/packs/:ruleId/versions/:version/publish`, (ctx) => publishVersion(db, scoped(ctx), ctx.params.ruleId, ver(ctx.params.version), ctx.body ?? {}));
  route('POST', `${R}/packs/:ruleId/versions/:version/rollback`, (ctx) => rollbackTo(db, scoped(ctx), ctx.params.ruleId, ver(ctx.params.version), ctx.body ?? {}));
  route('POST', `${R}/packs/:ruleId/versions/:version/retire`, (ctx) => retireVersion(db, scoped(ctx), ctx.params.ruleId, ver(ctx.params.version), ctx.body ?? {}));
}
