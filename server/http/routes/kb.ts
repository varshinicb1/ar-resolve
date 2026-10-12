// Knowledge base routes. Read-only; any authenticated user with a resolved scope
// (all roles hold 'view'). Payer directory results are filtered to that scope.
import type { ModuleApi } from '../app.ts';
import {
  ensureKnowledge, explainAdjustment, getArticle, getCode, getPayer, getPlaybook, listArticles, listCodes,
  listGlossary, listPayers, listPlaybooks, listSources, search,
} from '../../services/kb.ts';

export function register({ db, route, scoped }: ModuleApi): void {
  ensureKnowledge(db);
  const csv = (v: string | null) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

  route('GET', '/api/kb/sources', (ctx) => listSources(db, scoped(ctx)));
  route('GET', '/api/kb/search', (ctx) => search(db, scoped(ctx), {
    q: ctx.query.get('q') ?? '', types: csv(ctx.query.get('types')), codeType: ctx.query.get('codeType') ?? undefined, limit: Number(ctx.query.get('limit') ?? 30),
  }));
  route('GET', '/api/kb/codes', (ctx) => listCodes(db, scoped(ctx), {
    type: ctx.query.get('type') ?? 'carc', status: ctx.query.get('status') ?? undefined, page: Number(ctx.query.get('page') ?? 1), pageSize: Number(ctx.query.get('pageSize') ?? 50),
  }));
  route('GET', '/api/kb/codes/:type/:code', (ctx) => getCode(db, scoped(ctx), ctx.params.type, ctx.params.code));
  route('GET', '/api/kb/explain', (ctx) => explainAdjustment(db, scoped(ctx), { group: ctx.query.get('group'), carc: ctx.query.get('carc'), rarcs: csv(ctx.query.get('rarcs')) }));
  route('POST', '/api/kb/explain', (ctx) => explainAdjustment(db, scoped(ctx), ctx.body ?? {}));
  route('GET', '/api/kb/playbooks', (ctx) => listPlaybooks(db, scoped(ctx)));
  route('GET', '/api/kb/playbooks/:id', (ctx) => getPlaybook(db, scoped(ctx), ctx.params.id));
  route('GET', '/api/kb/articles', (ctx) => listArticles(db, scoped(ctx)));
  route('GET', '/api/kb/articles/:id', (ctx) => getArticle(db, scoped(ctx), ctx.params.id));
  route('GET', '/api/kb/glossary', (ctx) => listGlossary(db, scoped(ctx)));
  route('GET', '/api/kb/payers', (ctx) => listPayers(db, scoped(ctx)));
  route('GET', '/api/kb/payers/:id', (ctx) => getPayer(db, scoped(ctx), ctx.params.id));
}
