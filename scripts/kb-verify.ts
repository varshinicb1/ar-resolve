// npm run kb:verify — integrity checks for knowledge/*.json:
// header provenance, sha256 + count, duplicate keys, per-entry sources/citations,
// routing references to unknown or deactivated codes, the rule-pack selection map's code
// references (the routing source of truth, ADR 0060), and synthetic-only payers.
// Exit code 1 on any error. `--print-hashes` prints computed hashes (for a deliberate,
// reviewed dataset update; it never rewrites files).
import { KB_FILES, datasetHash, readDataset, type Dataset } from '../server/services/kb.ts';
import { ROUTING_SOURCE_MAP, ROUTING_TABLE, guardViolations, routingCodeRefs } from '../shared/kb/routing.ts';

export interface VerifyReport { errors: string[]; warnings: string[]; counts: Record<string, number> }

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['current', 'to_be_deactivated', 'deactivated', 'unverified']);

export function verifyKnowledge(root?: string): VerifyReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const codes = new Map<string, Record<string, any>>();
  let playbookIds = new Set<string>();

  for (const { file, kind } of KB_FILES) {
    let ds: Dataset;
    try { ds = readDataset(file, root); } catch (e) { errors.push(`${file}: unreadable (${(e as Error).message})`); continue; }
    const h = ds.header;
    for (const k of ['dataset', 'title', 'source', 'retrievedAt', 'method', 'sha256', 'coverage', 'license'] as const) {
      if (h?.[k] === undefined || h[k] === '') errors.push(`${file}: header.${k} missing`);
    }
    if (h.retrievedAt && !ISO.test(h.retrievedAt)) errors.push(`${file}: header.retrievedAt not ISO date`);
    if (!Array.isArray(ds.entries)) { errors.push(`${file}: entries is not an array`); continue; }
    const actual = datasetHash(ds.entries);
    if (actual !== h.sha256) errors.push(`${file}: sha256 mismatch (header ${String(h.sha256).slice(0, 12)}…, computed ${actual.slice(0, 12)}…)`);
    if (h.count !== ds.entries.length) errors.push(`${file}: header.count ${h.count} but ${ds.entries.length} entries`);
    if (process.argv.includes('--print-hashes')) console.log(`${file} ${actual}`);
    counts[h.dataset] = ds.entries.length;

    const keyOf = (e: Record<string, any>) => kind === 'codes' ? `${e.type}:${e.code}` : kind === 'payers' ? `${e.tenantId}/${e.clientId}/${e.payerId}` : e.id;
    const seen = new Set<string>();
    for (const e of ds.entries) {
      const key = keyOf(e);
      if (!key || key.includes('undefined')) { errors.push(`${file}: entry without key ${JSON.stringify(e).slice(0, 80)}`); continue; }
      if (seen.has(key)) errors.push(`${file}: duplicate ${key}`);
      seen.add(key);

      if (kind === 'codes') {
        codes.set(key, e);
        if (!e.sourceUrl) errors.push(`${file}: ${key} has no sourceUrl`);
        if (!STATUSES.has(e.status)) errors.push(`${file}: ${key} invalid status ${e.status}`);
        if (e.description && !e.descriptionSource) errors.push(`${file}: ${key} description without descriptionSource`);
        for (const d of ['startDate', 'lastModifiedDate', 'stopDate']) if (e[d] != null && !ISO.test(e[d])) errors.push(`${file}: ${key} ${d} not ISO`);
        if (e.status === 'unverified' && !e.verificationNote && e.type !== 'group') warnings.push(`${file}: ${key} unverified without note`);
        if (e.status !== 'unverified' && e.type !== 'group' && !e.startDate) errors.push(`${file}: ${key} has no start date but is not marked unverified`);
        if (e.stopDate && e.lastModifiedDate && e.lastModifiedDate > e.stopDate) warnings.push(`${file}: ${key} last-modified after stop date (as published)`);
      } else if (kind === 'articles') {
        if (!['draft', 'approved'].includes(e.reviewStatus)) errors.push(`${file}: ${key} reviewStatus must be draft|approved`);
        if (!Array.isArray(e.applicability) || !e.applicability.length) errors.push(`${file}: ${key} applicability missing`);
        if (!Array.isArray(e.facts) || !e.facts.length) errors.push(`${file}: ${key} has no facts`);
        for (const [i, f] of (e.facts ?? []).entries()) {
          if (!f.citation?.url || !f.citation?.source || !f.citation?.retrievedAt) errors.push(`${file}: ${key} fact ${i} lacks a full citation`);
        }
      } else if (kind === 'playbooks') {
        for (const k of ['title', 'objective', 'requiredEvidence', 'permittedProposals', 'hardStops', 'callPlan', 'noteTemplate', 'source', 'reviewStatus']) {
          if (e[k] === undefined || (Array.isArray(e[k]) && !e[k].length)) errors.push(`${file}: ${key} missing ${k}`);
        }
      } else if (kind === 'glossary') {
        if (!e.term || !e.definition) errors.push(`${file}: ${key} missing term/definition`);
        for (const l of e.links ?? []) if (!l.url) errors.push(`${file}: ${key} link without url`);
      } else if (kind === 'payers') {
        if (e.synthetic !== true) errors.push(`${file}: ${key} is not marked synthetic`);
        if (!e.tenantId || !e.clientId) errors.push(`${file}: ${key} must be tenant/client scoped`);
        for (const ch of e.channels ?? []) {
          if (ch.kind === 'phone' && !/^\+1-555-01\d\d$/.test(ch.value)) errors.push(`${file}: ${key} phone ${ch.value} is outside the fictional 555-01xx range`);
        }
      }
    }
    if (kind === 'playbooks') playbookIds = seen;
  }

  // Routing references.
  for (const ref of routingCodeRefs()) {
    const c = codes.get(`${ref.type}:${ref.code}`);
    if (!c) errors.push(`routing: ${ref.scenarioId} references unknown ${ref.type.toUpperCase()} ${ref.code}`);
    else if (c.status === 'deactivated') errors.push(`routing: ${ref.scenarioId} references deactivated ${ref.type.toUpperCase()} ${ref.code}`);
    else if (c.status !== 'current') warnings.push(`routing: ${ref.scenarioId} references ${ref.type.toUpperCase()} ${ref.code} with status ${c.status}`);
  }
  // The selection map is the routing source of truth: every CARC/RARC it routes on must be in the
  // loaded code lists and not deactivated, and every scenario it selects must have a playbook.
  const map = ROUTING_SOURCE_MAP;
  for (const e of map.entries) {
    for (const [type, code] of [['carc', e.match.carc], ['rarc', e.match.rarc]] as const) {
      if (code === undefined) continue;
      const c = codes.get(`${type}:${code}`);
      const where = `selection map ${map.id} v${map.version}: ${e.id} (${e.scenario})`;
      if (!c) errors.push(`${where} references unknown ${type.toUpperCase()} ${code}`);
      else if (c.status === 'deactivated') errors.push(`${where} references deactivated ${type.toUpperCase()} ${code}`);
      else if (c.status !== 'current') warnings.push(`${where} references ${type.toUpperCase()} ${code} with status ${c.status}`);
    }
    if (e.match.group !== undefined && !codes.has(`group:${e.match.group}`)) errors.push(`selection map ${map.id} v${map.version}: ${e.id} references unknown group ${e.match.group}`);
    if (!playbookIds.has(e.scenario)) errors.push(`selection map ${map.id} v${map.version}: scenario ${e.scenario} has no playbook`);
  }
  for (const v of guardViolations(map)) errors.push(`routing: ${v}`);
  counts['selection map carc rows'] = map.entries.filter((e) => e.match.carc !== undefined).length;
  for (const r of ROUTING_TABLE) {
    if (!playbookIds.has(r.scenarioId)) errors.push(`routing: scenario ${r.scenarioId} has no playbook`);
    for (const g of r.groups ?? []) if (!codes.has(`group:${g}`)) errors.push(`routing: unknown group ${g}`);
    if (r.signoff !== 'draft_requires_business_signoff') errors.push(`routing: ${r.scenarioId} must stay draft until sign-off is recorded`);
  }
  const carcClaims = new Map<string, string[]>();
  for (const r of ROUTING_TABLE) for (const c of r.carcs) for (const g of r.groups ?? ['*']) {
    const k = `${g}:${c}`;
    carcClaims.set(k, [...(carcClaims.get(k) ?? []), r.scenarioId]);
  }
  for (const [k, ids] of carcClaims) if (new Set(ids).size > 1) errors.push(`routing: ${k} maps to several scenarios (${ids.join(', ')})`);
  return { errors, warnings, counts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = verifyKnowledge();
  for (const [k, v] of Object.entries(r.counts)) console.log(`${k.padEnd(28)} ${v}`);
  for (const w of r.warnings) console.log(`warn  ${w}`);
  for (const e of r.errors) console.log(`ERROR ${e}`);
  console.log(r.errors.length ? `kb:verify FAILED (${r.errors.length} errors, ${r.warnings.length} warnings)` : `kb:verify ok (${r.warnings.length} warnings)`);
  process.exit(r.errors.length ? 1 : 0);
}
