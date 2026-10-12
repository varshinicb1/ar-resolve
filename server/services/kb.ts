// Knowledge base: loads the sourced, hashed datasets under knowledge/ into kb_* tables,
// and serves search, code lookup, adjustment explanation and playbooks.
// Reference data is global; the payer directory is tenant/client scoped.
// Dataset content is treated as reference data, never as instructions.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Db, all, one, run, tx } from '../db/db.ts';
import { hashJson, nowIso, notFound, invalid } from '../util.ts';
import { requirePerm, type Scope } from './auth.ts';
import { ROUTING_SOURCE_MAP, ROUTING_TABLE, routeScenario, type RouteResult } from '../../shared/kb/routing.ts';

export const KB_ROOT = fileURLToPath(new URL('../../knowledge/', import.meta.url));

export type DatasetKind = 'codes' | 'articles' | 'playbooks' | 'glossary' | 'payers';
export const KB_FILES: { file: string; kind: DatasetKind }[] = [
  { file: 'x12/carc.json', kind: 'codes' },
  { file: 'x12/rarc.json', kind: 'codes' },
  { file: 'x12/group-codes.json', kind: 'codes' },
  { file: 'x12/claim-status-category.json', kind: 'codes' },
  { file: 'x12/claim-status.json', kind: 'codes' },
  { file: 'regulatory/articles.json', kind: 'articles' },
  { file: 'playbooks/playbooks.json', kind: 'playbooks' },
  { file: 'glossary/glossary.json', kind: 'glossary' },
  { file: 'payers/synthetic-payers.json', kind: 'payers' },
];

export interface DatasetHeader {
  dataset: string; title: string; source: string; sourceUrl: string | null; retrievedAt: string; method: string;
  count: number; sha256: string; coverage: Record<string, unknown>; license: Record<string, unknown>;
}
export interface Dataset<T = Record<string, any>> { header: DatasetHeader; entries: T[] }

export function readDataset(file: string, root = KB_ROOT): Dataset {
  return JSON.parse(readFileSync(root + file, 'utf8')) as Dataset;
}

export class KbIntegrityError extends Error {}

/** Hash of the entries array (canonical JSON). Must equal header.sha256. */
export function datasetHash(entries: unknown[]): string { return hashJson(entries); }

const ftsByDb = new WeakMap<Db, boolean>();
const loadedDbs = new WeakSet<Db>();

function ensureFts(db: Db): boolean {
  if (ftsByDb.has(db)) return ftsByDb.get(db)!;
  let ok = false;
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(kind UNINDEXED, ref UNINDEXED, title, body, tokenize='porter unicode61')");
    ok = true;
  } catch { ok = false; }
  ftsByDb.set(db, ok);
  return ok;
}

export function searchEngine(db: Db): 'fts5' | 'like' { return ensureFts(db) ? 'fts5' : 'like'; }

/** Loads every dataset whose hash differs from the active version. Idempotent. */
export function loadKnowledge(db: Db, root = KB_ROOT): { dataset: string; version: number; changed: boolean }[] {
  const out: { dataset: string; version: number; changed: boolean }[] = [];
  const fts = ensureFts(db);
  tx(db, () => {
    let anyChange = false;
    for (const { file, kind } of KB_FILES) {
      const ds = readDataset(file, root);
      const h = ds.header;
      const actual = datasetHash(ds.entries);
      if (actual !== h.sha256) throw new KbIntegrityError(`${file}: sha256 mismatch (header ${h.sha256.slice(0, 12)}, computed ${actual.slice(0, 12)})`);
      if (ds.entries.length !== h.count) throw new KbIntegrityError(`${file}: count mismatch`);
      const active = one<{ version: number; sha256: string }>(db, 'SELECT version, sha256 FROM kb_sources WHERE dataset=? AND active=1', h.dataset);
      if (active?.sha256 === actual) { out.push({ dataset: h.dataset, version: active.version, changed: false }); continue; }
      const version = (one<{ v: number | null }>(db, 'SELECT MAX(version) v FROM kb_sources WHERE dataset=?', h.dataset)?.v ?? 0) + 1;
      run(db, 'UPDATE kb_sources SET active=0 WHERE dataset=?', h.dataset);
      run(db, 'INSERT INTO kb_sources VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)', h.dataset, version, actual, h.title, h.source, h.sourceUrl, h.retrievedAt,
        h.method, ds.entries.length, JSON.stringify(h.coverage ?? {}), JSON.stringify(h.license ?? {}), file, nowIso());
      replaceRows(db, kind, h.dataset, version, ds.entries);
      out.push({ dataset: h.dataset, version, changed: true });
      anyChange = true;
    }
    if (anyChange || !one(db, 'SELECT 1 FROM kb_search LIMIT 1')) rebuildSearch(db, fts);
  });
  loadedDbs.add(db);
  return out;
}

export function ensureKnowledge(db: Db): void {
  if (!loadedDbs.has(db)) loadKnowledge(db);
}

function replaceRows(db: Db, kind: DatasetKind, dataset: string, version: number, entries: Record<string, any>[]) {
  const j = (v: unknown) => JSON.stringify(v);
  if (kind === 'codes') {
    run(db, 'DELETE FROM kb_codes WHERE dataset=?', dataset);
    for (const e of entries) {
      run(db, 'INSERT INTO kb_codes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', e.type, e.code, dataset, version, e.description ?? null, e.descriptionStatus,
        e.descriptionSource ?? null, e.startDate ?? null, e.lastModifiedDate ?? null, e.stopDate ?? null, e.status, e.sourceUrl, j(e));
    }
  } else if (kind === 'articles') {
    run(db, 'DELETE FROM kb_articles');
    for (const e of entries) run(db, 'INSERT INTO kb_articles VALUES (?,?,?,?,?,?,?)', e.id, version, e.title, e.summary, j(e.applicability), e.reviewStatus, j(e));
  } else if (kind === 'playbooks') {
    run(db, 'DELETE FROM kb_playbooks');
    for (const e of entries) run(db, 'INSERT INTO kb_playbooks VALUES (?,?,?,?,?)', e.id, version, e.title, e.reviewStatus, j(e));
  } else if (kind === 'glossary') {
    run(db, 'DELETE FROM kb_glossary');
    for (const e of entries) run(db, 'INSERT INTO kb_glossary VALUES (?,?,?,?,?)', e.id, version, e.term, e.definition, j(e));
  } else {
    run(db, 'DELETE FROM kb_payers');
    for (const e of entries) {
      if (e.synthetic !== true) throw new KbIntegrityError(`payer ${e.payerId}: only synthetic payers may be loaded`);
      run(db, 'INSERT INTO kb_payers VALUES (?,?,?,?,?,1,?)', e.tenantId, e.clientId, e.payerId, version, e.name, j(e));
    }
  }
}

// Global search index: codes, articles, playbooks, glossary. Payers are scoped and
// are searched separately so one tenant's directory can never surface in another's results.
function rebuildSearch(db: Db, fts: boolean) {
  run(db, 'DELETE FROM kb_search');
  if (fts) db.exec('DELETE FROM kb_fts');
  const put = (kind: string, ref: string, title: string, body: string) => {
    run(db, 'INSERT INTO kb_search VALUES (?,?,?,?)', kind, ref, title, body);
    if (fts) run(db, 'INSERT INTO kb_fts (kind, ref, title, body) VALUES (?,?,?,?)', kind, ref, title, body);
  };
  for (const c of all<{ code_type: string; code: string; description: string | null; status: string }>(db, 'SELECT code_type, code, description, status FROM kb_codes')) {
    put('code', `${c.code_type}:${c.code}`, `${TYPE_LABEL[c.code_type] ?? c.code_type} ${c.code}`, `${c.code} ${c.description ?? ''} ${c.status}`);
  }
  for (const a of all<{ article_id: string; body: string }>(db, 'SELECT article_id, body FROM kb_articles')) {
    const b = JSON.parse(a.body);
    put('article', a.article_id, b.title, [b.summary, ...(b.tags ?? []), ...b.facts.map((f: { text: string }) => f.text), ...(b.caveats ?? [])].join(' '));
  }
  for (const p of all<{ scenario_id: string; body: string }>(db, 'SELECT scenario_id, body FROM kb_playbooks')) {
    const b = JSON.parse(p.body);
    const codes = ROUTING_TABLE.filter((r) => r.scenarioId === p.scenario_id).flatMap((r) => [...r.carcs.map((c) => `CARC ${c}`), ...r.rarcs]);
    put('playbook', p.scenario_id, `${p.scenario_id} · ${b.title}`, [b.objective, ...b.requiredEvidence, ...b.hardStops, ...b.permittedProposals, ...codes].join(' '));
  }
  for (const g of all<{ term_id: string; term: string; definition: string }>(db, 'SELECT term_id, term, definition FROM kb_glossary')) put('glossary', g.term_id, g.term, g.definition);
}

export const TYPE_LABEL: Record<string, string> = { carc: 'CARC', rarc: 'RARC', group: 'Group', claim_status_category: 'Status category', claim_status: 'Status code' };
const CODE_TYPES = Object.keys(TYPE_LABEL);
const KINDS = ['code', 'article', 'playbook', 'glossary', 'payer'] as const;
type Kind = (typeof KINDS)[number];

export interface SearchHit { kind: Kind; ref: string; title: string; snippet: string; codeType?: string; code?: string; status?: string }

export function search(db: Db, s: Scope, opts: { q: string; types?: string[]; codeType?: string; limit?: number; engine?: 'like' }) {
  requirePerm(s, 'view');
  const q = (opts.q ?? '').slice(0, 200);
  // Single letters are noise ("Payer B"); single digits stay (CARC "1").
  const tokens = (q.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 || /\d/.test(t)).slice(0, 8);
  const kinds = (opts.types?.length ? opts.types : [...KINDS]).filter((k): k is Kind => (KINDS as readonly string[]).includes(k));
  const codeType = opts.codeType && CODE_TYPES.includes(opts.codeType) ? opts.codeType : undefined;
  const limit = Math.max(1, Math.min(100, Number.isFinite(opts.limit) ? opts.limit! : 30));
  // `engine: 'like'` forces the fallback path (used by tests to cover non-FTS5 builds).
  const engine = opts.engine ?? searchEngine(db);
  if (!tokens.length || !kinds.length) return { query: q, engine, results: [] as SearchHit[] };

  const results: SearchHit[] = [];
  const seen = new Set<string>();
  const push = (h: SearchHit) => { const k = `${h.kind}:${h.ref}`; if (!seen.has(k)) { seen.add(k); results.push(h); } };

  // Exact code match first (e.g. "1", "co 45", "N130").
  if (kinds.includes('code')) {
    const exact = q.trim().toUpperCase().split(/[\s,]+/).filter(Boolean).slice(0, 8);
    for (const c of exact) {
      for (const r of all<{ code_type: string; code: string; description: string | null; status: string }>(db,
        `SELECT code_type, code, description, status FROM kb_codes WHERE code=? ${codeType ? 'AND code_type=?' : ''} ORDER BY code_type`, ...(codeType ? [c, codeType] : [c]))) {
        push({ kind: 'code', ref: `${r.code_type}:${r.code}`, title: `${TYPE_LABEL[r.code_type]} ${r.code}`, snippet: r.description ?? 'Description requires licensed X12 import', codeType: r.code_type, code: r.code, status: r.status });
      }
    }
  }

  const globalKinds = kinds.filter((k) => k !== 'payer');
  if (globalKinds.length) {
    const kindSql = `kind IN (${globalKinds.map(() => '?').join(',')})`;
    const refSql = codeType ? " AND (kind <> 'code' OR ref LIKE ?)" : '';
    const refArgs = codeType ? [`${codeType}:%`] : [];
    let rows: { kind: Kind; ref: string; title: string; snippet: string }[];
    if (engine === 'fts5') {
      const match = tokens.map((t) => `"${t}"*`).join(' ');
      rows = all(db, `SELECT kind, ref, title, snippet(kb_fts, 3, '[', ']', '…', 14) AS snippet FROM kb_fts
        WHERE kb_fts MATCH ? AND ${kindSql}${refSql} ORDER BY bm25(kb_fts, 0, 0, 4.0, 1.0) LIMIT ?`, match, ...globalKinds, ...refArgs, limit);
    } else {
      const like = tokens.map(() => "(lower(title) || ' ' || lower(body)) LIKE ?").join(' AND ');
      rows = all(db, `SELECT kind, ref, title, substr(body, 1, 160) AS snippet FROM kb_search WHERE ${like} AND ${kindSql}${refSql} ORDER BY kind, title LIMIT ?`,
        ...tokens.map((t) => `%${t}%`), ...globalKinds, ...refArgs, limit);
    }
    for (const r of rows) {
      const hit: SearchHit = { kind: r.kind, ref: r.ref, title: r.title, snippet: r.snippet };
      if (r.kind === 'code') {
        const [ct, code] = r.ref.split(':');
        const row = one<{ status: string; description: string | null }>(db, 'SELECT status, description FROM kb_codes WHERE code_type=? AND code=?', ct, code);
        Object.assign(hit, { codeType: ct, code, status: row?.status, snippet: row?.description ?? 'Description requires licensed X12 import' });
      }
      push(hit);
    }
  }

  if (kinds.includes('payer')) {
    const like = tokens.map(() => "(lower(name) || ' ' || lower(payer_id) || ' ' || lower(body)) LIKE ?").join(' AND ');
    for (const p of all<{ payer_id: string; name: string }>(db, `SELECT payer_id, name FROM kb_payers WHERE tenant_id=? AND client_id=? AND ${like} ORDER BY name LIMIT ?`,
      s.tenantId, s.clientId, ...tokens.map((t) => `%${t}%`), limit)) {
      push({ kind: 'payer', ref: p.payer_id, title: `${p.name} (synthetic)`, snippet: 'Synthetic payer directory entry for this client' });
    }
  }
  return { query: q, engine, results: results.slice(0, limit) };
}

interface CodeRow { code_type: string; code: string; dataset: string; dataset_version: number; body: string }

function codeView(r: CodeRow) {
  const b = JSON.parse(r.body);
  return { ...b, dataset: r.dataset, datasetVersion: r.dataset_version };
}

export function getCode(db: Db, s: Scope, type: string, code: string) {
  requirePerm(s, 'view');
  if (!CODE_TYPES.includes(type)) throw invalid(`Unknown code type ${type}`);
  const r = one<CodeRow>(db, 'SELECT code_type, code, dataset, dataset_version, body FROM kb_codes WHERE code_type=? AND code=?', type, code.trim().toUpperCase());
  if (!r) throw notFound(`${TYPE_LABEL[type]} ${code} (the loaded list may be partial; see /api/kb/sources)`);
  const routes = ROUTING_TABLE.filter((x) => (type === 'carc' && x.carcs.includes(r.code)) || (type === 'rarc' && x.rarcs.includes(r.code)) || (type === 'group' && (x.groups ?? []).includes(r.code as never)))
    .map((x) => ({ scenarioId: x.scenarioId, groups: x.groups ?? null, requiresRarc: !!x.requiresRarc, note: x.note, signoff: x.signoff }));
  return { ...codeView(r), routes, source: sourceFor(db, r.dataset) };
}

export function listCodes(db: Db, s: Scope, opts: { type: string; status?: string; page?: number; pageSize?: number }) {
  requirePerm(s, 'view');
  if (!CODE_TYPES.includes(opts.type)) throw invalid(`Unknown code type ${opts.type}`);
  const pageSize = Math.max(1, Math.min(200, opts.pageSize ?? 50));
  const page = Math.max(1, opts.page ?? 1);
  const statusSql = opts.status ? ' AND status=?' : '';
  const args = opts.status ? [opts.type, opts.status] : [opts.type];
  const total = one<{ n: number }>(db, `SELECT COUNT(*) n FROM kb_codes WHERE code_type=?${statusSql}`, ...args)!.n;
  const items = all<{ code: string; description: string | null; description_status: string; status: string; start_date: string | null; stop_date: string | null }>(db,
    `SELECT code, description, description_status, status, start_date, stop_date FROM kb_codes WHERE code_type=?${statusSql}
     ORDER BY CASE WHEN code GLOB '[0-9]*' THEN 0 ELSE 1 END, length(code), code LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize)
    .map((r) => ({ code: r.code, description: r.description, descriptionStatus: r.description_status, status: r.status, startDate: r.start_date, stopDate: r.stop_date }));
  return { type: opts.type, total, page, pageSize, items };
}

function sourceFor(db: Db, dataset: string) {
  const r = one<SourceRow>(db, 'SELECT * FROM kb_sources WHERE dataset=? AND active=1', dataset);
  return r ? sourceView(r) : null;
}

interface SourceRow { dataset: string; version: number; sha256: string; title: string; source: string; source_url: string | null; retrieved_at: string; method: string; entry_count: number; coverage: string; license: string; file: string; loaded_at: string }
const sourceView = (r: SourceRow) => ({
  dataset: r.dataset, version: r.version, sha256: r.sha256, title: r.title, source: r.source, sourceUrl: r.source_url, retrievedAt: r.retrieved_at,
  method: r.method, count: r.entry_count, coverage: JSON.parse(r.coverage), license: JSON.parse(r.license), file: r.file, loadedAt: r.loaded_at,
});

export function listSources(db: Db, s: Scope) {
  requirePerm(s, 'view');
  return { searchEngine: searchEngine(db), datasets: all<SourceRow>(db, 'SELECT * FROM kb_sources WHERE active=1 ORDER BY dataset').map(sourceView) };
}

function codeBrief(db: Db, type: string, code: string) {
  const r = one<{ description: string | null; description_status: string; status: string; stop_date: string | null }>(db,
    'SELECT description, description_status, status, stop_date FROM kb_codes WHERE code_type=? AND code=?', type, code);
  return r ? { code, found: true, description: r.description, descriptionStatus: r.description_status, status: r.status, stopDate: r.stop_date }
    : { code, found: false, description: null, descriptionStatus: null, status: null, stopDate: null };
}

export interface Explanation {
  group: ReturnType<typeof codeBrief> & { name?: string };
  carc: ReturnType<typeof codeBrief>;
  rarcs: ReturnType<typeof codeBrief>[];
  route: RouteResult;
  decision: 'scenario' | 'specialist_review';
  scenarioId: string | null;
  playbook: Record<string, unknown> | null;
  caveats: string[];
}

/** Explains one CAS adjustment (group + CARC + RARCs). Unknown, deactivated, unverified or conflicting input -> specialist review. */
export function explainAdjustment(db: Db, s: Scope, input: { group?: unknown; carc?: unknown; rarcs?: unknown }): Explanation {
  requirePerm(s, 'view');
  const group = String(input.group ?? '').trim().toUpperCase().slice(0, 4);
  const carc = String(input.carc ?? '').trim().toUpperCase().slice(0, 8);
  const rawR = Array.isArray(input.rarcs) ? input.rarcs : String(input.rarcs ?? '').split(',');
  const rarcs = [...new Set(rawR.map((r) => String(r).trim().toUpperCase().slice(0, 8)).filter(Boolean))].slice(0, 10);
  if (!group && !carc) throw invalid('Provide at least a group or a CARC');

  const g = codeBrief(db, 'group', group);
  const c = codeBrief(db, 'carc', carc);
  const rs = rarcs.map((r) => codeBrief(db, 'rarc', r));
  const route = routeScenario(group, carc, rarcs);
  const caveats: string[] = [];
  const forceReview: string[] = [];

  if (!g.found) forceReview.push(`Group "${group || '(none)'}" is not a known adjustment group.`);
  if (carc && !c.found) forceReview.push(`CARC ${carc} is not in the loaded CARC list (the list is partial; see sources).`);
  for (const r of rs) if (!r.found) forceReview.push(`RARC ${r.code} is not in the loaded RARC list (the list is partial).`);
  for (const x of [c, ...rs]) {
    if (x.found && x.status === 'deactivated') forceReview.push(`${x === c ? 'CARC' : 'RARC'} ${x.code} was deactivated on ${x.stopDate}; confirm the remittance date and payer usage.`);
    if (x.found && x.status === 'unverified') forceReview.push(`${x === c ? 'CARC' : 'RARC'} ${x.code} could not be fully verified from the source.`);
  }
  const decision = route.decision === 'scenario' && !forceReview.length ? 'scenario' : 'specialist_review';
  const scenarioId = decision === 'scenario' ? route.scenarioId : null;

  caveats.push(...forceReview);
  caveats.push(`Routing ${route.routingVersion} is a draft and requires business sign-off before it drives any action.`);
  caveats.push('A CARC alone does not prove that a balance is valid or that patient billing is permitted (build pack doc 04).');
  if (group === 'PR') caveats.push('PR means the amount may be billed to the patient, not that it must be: check No Surprises Act, contract and client-policy protections first.');
  if ([c, ...rs].some((x) => x.found && x.descriptionStatus !== 'excerpt_first_sentence')) caveats.push('Some descriptions are excerpts or unverified labels; the full X12 text needs a licensed import.');

  let playbook: Record<string, unknown> | null = null;
  if (scenarioId) {
    const p = one<{ body: string }>(db, 'SELECT body FROM kb_playbooks WHERE scenario_id=?', scenarioId);
    playbook = p ? JSON.parse(p.body) : null;
  }
  const groupName = one<{ description: string }>(db, "SELECT description FROM kb_codes WHERE code_type='group' AND code=?", group)?.description;
  return { group: { ...g, name: groupName }, carc: c, rarcs: rs, route, decision, scenarioId, playbook, caveats };
}

const routesFor = (id: string) => {
  const carcRows = ROUTING_TABLE.filter((r) => r.scenarioId === id).map((r) => ({ carcs: r.carcs, groups: r.groups ?? null, rarcs: r.rarcs, requiresRarc: !!r.requiresRarc, claimStatuses: [] as string[], note: r.note, signoff: r.signoff }));
  // Claim-status rows of the selection map (the routing source of truth, ADR 0060).
  const statuses = ROUTING_SOURCE_MAP.entries.filter((e) => e.scenario === id && e.match.claimStatus).map((e) => e.match.claimStatus!);
  const statusRows = statuses.length ? [{ carcs: [] as string[], groups: null, rarcs: [] as string[], requiresRarc: false, claimStatuses: statuses,
    note: `Selected by payer claim status (selection map ${ROUTING_SOURCE_MAP.id} v${ROUTING_SOURCE_MAP.version}; synthetic status values).`, signoff: 'draft_requires_business_signoff' as const }] : [];
  return [...carcRows, ...statusRows];
};

export function listPlaybooks(db: Db, s: Scope) {
  requirePerm(s, 'view');
  return all<{ scenario_id: string; body: string; dataset_version: number }>(db, 'SELECT scenario_id, body, dataset_version FROM kb_playbooks ORDER BY rowid').map((r) => {
    const b = JSON.parse(r.body);
    return { id: r.scenario_id, title: b.title, objective: b.objective, reviewStatus: b.reviewStatus, executable: b.executable, datasetVersion: r.dataset_version, routes: routesFor(r.scenario_id) };
  });
}

export function getPlaybook(db: Db, s: Scope, id: string) {
  requirePerm(s, 'view');
  const r = one<{ body: string; dataset_version: number }>(db, 'SELECT body, dataset_version FROM kb_playbooks WHERE scenario_id=?', id.toUpperCase());
  if (!r) throw notFound('Playbook');
  return { ...JSON.parse(r.body), datasetVersion: r.dataset_version, routes: routesFor(id.toUpperCase()), datasetSource: sourceFor(db, 'kb.playbooks') };
}

export function listArticles(db: Db, s: Scope) {
  requirePerm(s, 'view');
  return all<{ article_id: string; title: string; summary: string; applicability: string; review_status: string }>(db, 'SELECT * FROM kb_articles ORDER BY rowid')
    .map((r) => ({ id: r.article_id, title: r.title, summary: r.summary, applicability: JSON.parse(r.applicability), reviewStatus: r.review_status }));
}

export function getArticle(db: Db, s: Scope, id: string) {
  requirePerm(s, 'view');
  const r = one<{ body: string; dataset_version: number }>(db, 'SELECT body, dataset_version FROM kb_articles WHERE article_id=?', id);
  if (!r) throw notFound('Article');
  return { ...JSON.parse(r.body), datasetVersion: r.dataset_version };
}

export function listGlossary(db: Db, s: Scope) {
  requirePerm(s, 'view');
  return all<{ body: string }>(db, 'SELECT body FROM kb_glossary ORDER BY term COLLATE NOCASE').map((r) => JSON.parse(r.body));
}

export function listPayers(db: Db, s: Scope) {
  requirePerm(s, 'view');
  return all<{ body: string; dataset_version: number }>(db, 'SELECT body, dataset_version FROM kb_payers WHERE tenant_id=? AND client_id=? ORDER BY name', s.tenantId, s.clientId)
    .map((r) => ({ ...JSON.parse(r.body), datasetVersion: r.dataset_version }));
}

export function getPayer(db: Db, s: Scope, payerId: string) {
  requirePerm(s, 'view');
  const r = one<{ body: string; dataset_version: number }>(db, 'SELECT body, dataset_version FROM kb_payers WHERE tenant_id=? AND client_id=? AND payer_id=?', s.tenantId, s.clientId, payerId);
  if (!r) throw notFound('Payer');
  return { ...JSON.parse(r.body), datasetVersion: r.dataset_version };
}
