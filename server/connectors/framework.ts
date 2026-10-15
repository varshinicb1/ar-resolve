// Connector framework: the adapter contract from docs/07, a registry with per tenant/client
// configuration, the connector onboarding record, recorded authorizations, the live-mode
// enable gate, connector events, health and a circuit breaker.
//
// Every adapter call goes through invoke(): it checks configuration, mode and the circuit,
// enforces the time budget, records a connector event (the adapter contract response) and
// never turns an unknown outcome into success or failure.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { AppError, canonicalJson, conflict, invalid, newId, notFound, now, nowIso, sha256 } from '../util.ts';
import { audit } from '../services/audit.ts';
import type { Scope } from '../services/auth.ts';
import { LiveExecutionDisabled } from './executors.ts';
import { phiLiveReasons } from '../services/governance.ts';
import { isSyntheticDeployment } from '../config.ts';

export const ENVIRONMENT_FOR_GATE = (process.env.AR_ENVIRONMENT ?? 'synthetic') as 'synthetic' | 'shadow' | 'assisted_live';

export type ActionClass = 'read_status' | 'read_eligibility' | 'read_remittance' | 'read_clinical_financial' | 'ingest_file' | 'webhook_ingest' | 'submit_request' | 'call' | 'document' | 'writeback';
export type Outcome = 'success' | 'not_found' | 'rejected' | 'error' | 'timeout' | 'uncertain' | 'partially_completed' | 'refused';
export type Mode = 'local' | 'simulated' | 'disabled_live' | 'live';

export interface SourceRef { title: string; url: string; retrievedAt: string; note?: string }

export interface ConfigField { key: string; label: string; secret?: boolean; note?: string }

export interface ConnectorDescriptor {
  id: string;
  displayName: string;
  vendor: string;
  kind: 'edi_file' | 'clearinghouse' | 'fhir' | 'ehr_api' | 'pm_api' | 'sftp' | 'voice' | 'notification';
  defaultMode: Mode;
  liveCapable: boolean;
  capabilities: ActionClass[];
  transactions: string[];
  configFields: ConfigField[];
  documentedPaths?: { path: string; source: string }[];
  phi: boolean;
  requiresBaa: boolean;
  notes: string[];
  sources: SourceRef[];
}

// Adapter contract request (docs/07).
export interface ConnectorRequest {
  requestId: string;
  scope: { tenantId: string; clientId: string };
  accountId: string | null;
  accountRevision: number | null;
  idempotencyKey: string | null;
  actionClass: ActionClass;
  timeBudgetMs: number;
  payload: Record<string, unknown>;
}

// Adapter contract response (docs/07).
export interface ConnectorResponse {
  connectorEventId: string;
  connectorId: string;
  requestId: string;
  outcome: Outcome;
  externalRefs: Record<string, string>;
  evidenceLocator: Record<string, unknown> | null;
  sourceTime: string | null;
  receivedTime: string;
  rawSha256: string | null;
  normalized: unknown;
  latencyMs: number;
  error: string | null;
  raw?: string;
}

export interface AdapterResult {
  outcome: Exclude<Outcome, 'refused'>;
  externalRefs?: Record<string, string>;
  evidenceLocator?: Record<string, unknown> | null;
  sourceTime?: string | null;
  raw?: string | null;
  normalized?: unknown;
  latencyMs?: number;
  error?: string | null;
}

export interface AdapterContext { db: Db; scope: Scope; config: ConnectorConfig }

export interface ConnectorAdapter {
  descriptor: ConnectorDescriptor;
  execute(ctx: AdapterContext, req: ConnectorRequest): AdapterResult;
  // Adapters that perform network I/O (FHIR) implement the async form.
  executeAsync?(ctx: AdapterContext, req: ConnectorRequest): Promise<AdapterResult>;
  // Health stub for adapters that cannot be probed (live disabled).
  healthStub?(): { status: string; detail: string };
  // Real live adapters (ADR 0100) declare their own gate: every reason it returns refuses the call.
  // When present it replaces the disabled_live/live-mode branch and the per-scope enabled flag below.
  gate?(db: Db, scope: Scope, config: ConnectorConfig): string[];
}

const REGISTRY = new Map<string, ConnectorAdapter>();

export function registerAdapter(a: ConnectorAdapter) {
  REGISTRY.set(a.descriptor.id, a);
}

export function adapterFor(id: string): ConnectorAdapter {
  const a = REGISTRY.get(id);
  if (!a) throw notFound('Connector');
  return a;
}

export function allAdapters(): ConnectorAdapter[] {
  return [...REGISTRY.values()];
}

// ---------------------------------------------------------------- configuration

export interface ConnectorConfig { connectorId: string; mode: Mode; enabled: boolean; settings: Record<string, unknown>; mappingId: string | null; mappingVersion: number | null; updatedBy: string; updatedAt: string }

interface ConfigRow { connector_id: string; mode: Mode; enabled: number; settings: string; mapping_id: string | null; mapping_version: number | null; updated_by: string; updated_at: string }

const toConfig = (r: ConfigRow): ConnectorConfig => ({ connectorId: r.connector_id, mode: r.mode, enabled: !!r.enabled, settings: JSON.parse(r.settings), mappingId: r.mapping_id,
  mappingVersion: r.mapping_version, updatedBy: r.updated_by, updatedAt: r.updated_at });

export const DEFAULT_SETTINGS: Record<string, Record<string, unknown>> = {
  sim_clearinghouse: { structuredStatusFirst: false, latencyMs: 120, mappingOptions: { deriveMetBeforeFromRemaining: false, otherPayerMeansSecondary: true } },
  // payerCrosswalk: X12 payer identifier (N1*PR N104, else ISA06 sender) -> internal payer id. SYNTHETIC default (ADR 0060).
  edi_upload: { mappingOptions: { deriveMetBeforeFromRemaining: false, otherPayerMeansSecondary: true }, payerCrosswalk: { DEMOPAYER: 'demo-payer' } },
  sim_fhir: { latencyMs: 40 },
};

export function getConfig(db: Db, scope: Scope, connectorId: string): ConnectorConfig {
  const a = adapterFor(connectorId);
  const row = one<ConfigRow>(db, 'SELECT * FROM connector_configs WHERE tenant_id=? AND client_id=? AND connector_id=?', scope.tenantId, scope.clientId, connectorId);
  if (row) return toConfig(row);
  return { connectorId, mode: a.descriptor.defaultMode, enabled: a.descriptor.defaultMode !== 'disabled_live' && (a.descriptor.defaultMode !== 'simulated' || isSyntheticDeployment()), settings: structuredClone(DEFAULT_SETTINGS[connectorId] ?? {}),
    mappingId: null, mappingVersion: null, updatedBy: 'system', updatedAt: '' };
}

function saveConfig(db: Db, scope: Scope, c: ConnectorConfig) {
  run(db, `INSERT INTO connector_configs VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (tenant_id, client_id, connector_id) DO UPDATE SET
    mode=excluded.mode, enabled=excluded.enabled, settings=excluded.settings, mapping_id=excluded.mapping_id, mapping_version=excluded.mapping_version,
    updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
  scope.tenantId, scope.clientId, c.connectorId, c.mode, c.enabled ? 1 : 0, canonicalJson(c.settings), c.mappingId, c.mappingVersion, scope.userId, nowIso());
}

// Settings are validated per known key; unknown keys are refused rather than stored.
const SETTING_RULES: Record<string, (v: unknown) => boolean> = {
  structuredStatusFirst: (v) => typeof v === 'boolean',
  latencyMs: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 60_000,
  payerCrosswalk: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length <= 200
    && Object.entries(v as object).every(([k, x]) => /^[A-Z0-9 -]{1,80}$/.test(k) && typeof x === 'string' && /^[\w-]{1,40}$/.test(x)),
  mappingOptions: (v) => !!v && typeof v === 'object' && Object.entries(v as object).every(([k, x]) => ['deriveMetBeforeFromRemaining', 'otherPayerMeansSecondary'].includes(k) && typeof x === 'boolean'),
};

export function updateSettings(db: Db, scope: Scope, connectorId: string, patch: Record<string, unknown>, enabled?: boolean): ConnectorConfig {
  for (const [k, v] of Object.entries(patch)) {
    if (!SETTING_RULES[k]) throw invalid(`Unknown setting: ${k}`);
    if (!SETTING_RULES[k](v)) throw invalid(`Invalid value for ${k}`);
  }
  return tx(db, () => {
    const c = getConfig(db, scope, connectorId);
    const before = { settings: c.settings, enabled: c.enabled };
    c.settings = { ...c.settings, ...patch };
    if (enabled !== undefined) {
      if (enabled && c.mode === 'disabled_live') throw conflict('live_disabled', 'A live-disabled connector cannot be enabled. Use the enable gate.');
      c.enabled = enabled;
    }
    saveConfig(db, scope, c);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'connector', objectId: connectorId, eventType: 'connector_settings_changed',
      details: { before, after: { settings: c.settings, enabled: c.enabled } } });
    return c;
  });
}

// ---------------------------------------------------------------- onboarding record (docs/07)

export const ONBOARDING_FIELDS: { key: string; label: string }[] = [
  { key: 'customerAuthorization', label: 'Customer authorization (who authorized, document reference)' },
  { key: 'subprocessorStatus', label: 'Subprocessor status' },
  { key: 'endpointSet', label: 'Exact endpoint set' },
  { key: 'scopes', label: 'Scopes' },
  { key: 'credentialsCustodian', label: 'Credentials custodian' },
  { key: 'accountMapping', label: 'Account mapping' },
  { key: 'providerIdentifiers', label: 'Provider identifiers' },
  { key: 'payerIds', label: 'Payer IDs' },
  { key: 'sandboxEvidence', label: 'Sandbox evidence' },
  { key: 'expectedReceipts', label: 'Expected receipts' },
  { key: 'allowedActions', label: 'Allowed actions' },
  { key: 'callScripts', label: 'Call scripts' },
  { key: 'destinationAllowlist', label: 'Destination allowlist' },
  { key: 'region', label: 'Region' },
  { key: 'retention', label: 'Retention' },
  { key: 'operationalOwner', label: 'Operational owner' },
  { key: 'fieldMappingVersion', label: 'Field mapping version' },
  { key: 'syntheticRoundTripTest', label: 'Synthetic round-trip test reference' },
];

export function completeness(record: Record<string, unknown>): { filled: number; total: number; ratio: number; missing: string[] } {
  const missing = ONBOARDING_FIELDS.filter((f) => typeof record[f.key] !== 'string' || !(record[f.key] as string).trim()).map((f) => f.key);
  const total = ONBOARDING_FIELDS.length;
  return { filled: total - missing.length, total, ratio: (total - missing.length) / total, missing };
}

export function latestOnboarding(db: Db, scope: Scope, connectorId: string) {
  const r = one<{ version: number; record: string; sha256: string; completeness: number; recorded_by: string; recorded_at: string }>(db,
    'SELECT version, record, sha256, completeness, recorded_by, recorded_at FROM connector_onboarding WHERE tenant_id=? AND client_id=? AND connector_id=? ORDER BY version DESC LIMIT 1',
    scope.tenantId, scope.clientId, connectorId);
  if (!r) return null;
  const record = JSON.parse(r.record) as Record<string, unknown>;
  return { version: r.version, record, sha256: r.sha256, completeness: completeness(record), recordedBy: r.recorded_by, recordedAt: r.recorded_at };
}

export function saveOnboarding(db: Db, scope: Scope, connectorId: string, record: Record<string, unknown>) {
  adapterFor(connectorId);
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw invalid('record must be an object');
  const clean: Record<string, string> = {};
  for (const f of ONBOARDING_FIELDS) {
    const v = record[f.key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw invalid(`${f.key} must be text`);
    if (v.length > 2000) throw invalid(`${f.key} is too long`);
    clean[f.key] = v.trim();
  }
  const unknown = Object.keys(record).filter((k) => !ONBOARDING_FIELDS.some((f) => f.key === k));
  if (unknown.length) throw invalid(`Unknown onboarding fields: ${unknown.join(', ')}`);
  return tx(db, () => {
    const prev = latestOnboarding(db, scope, connectorId);
    const version = (prev?.version ?? 0) + 1;
    const body = canonicalJson(clean);
    const c = completeness(clean);
    run(db, 'INSERT INTO connector_onboarding VALUES (?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, connectorId, version, body, sha256(body), c.ratio, scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'connector', objectId: connectorId, eventType: 'connector_onboarding_recorded',
      details: { version, sha256: sha256(body), completeness: c.ratio, missing: c.missing } });
    return latestOnboarding(db, scope, connectorId)!;
  });
}

// ---------------------------------------------------------------- authorization and the live enable gate

export function recordAuthorization(db: Db, scope: Scope, connectorId: string, body: { authorizationRef?: unknown; coveredServiceVerified?: unknown; baaRef?: unknown; notes?: unknown }) {
  const a = adapterFor(connectorId);
  const ref = String(body.authorizationRef ?? '').trim();
  if (ref.length < 3) throw invalid('authorizationRef is required (the customer authorization document reference)');
  if (typeof body.coveredServiceVerified !== 'boolean') throw invalid('coveredServiceVerified must be true or false');
  const baa = body.baaRef ? String(body.baaRef).trim() : null;
  if (a.descriptor.requiresBaa && body.coveredServiceVerified && !baa) throw invalid('This connector processes PHI: a BAA reference is required to mark the service as covered');
  return tx(db, () => {
    const id = newId('auth');
    run(db, 'INSERT INTO connector_authorizations VALUES (?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, connectorId, id, ref, body.coveredServiceVerified ? 1 : 0, baa,
      String(body.notes ?? '').slice(0, 2000), scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'connector', objectId: connectorId, eventType: 'connector_authorization_recorded',
      details: { authorizationId: id, authorizationRef: ref, coveredServiceVerified: !!body.coveredServiceVerified, baaRef: baa } });
    return { authorizationId: id };
  });
}

export function latestAuthorization(db: Db, scope: Scope, connectorId: string) {
  return one<{ authorization_id: string; authorization_ref: string; covered_service_verified: number; baa_ref: string | null; recorded_by: string; recorded_at: string }>(db,
    'SELECT * FROM connector_authorizations WHERE tenant_id=? AND client_id=? AND connector_id=? ORDER BY recorded_at DESC, rowid DESC LIMIT 1', scope.tenantId, scope.clientId, connectorId) ?? null;
}

// Returns every reason live mode is refused. Empty means the gate would open.
export function liveGate(db: Db, scope: Scope, connectorId: string): string[] {
  const a = adapterFor(connectorId);
  const reasons: string[] = [];
  if (!a.descriptor.liveCapable) reasons.push('This connector has no live implementation (simulator or local intake only).');
  const auth = latestAuthorization(db, scope, connectorId);
  if (!auth) reasons.push('No customer authorization is recorded for this client.');
  else if (!auth.covered_service_verified) reasons.push('Covered-service verification is not recorded.');
  if (a.descriptor.requiresBaa && !auth?.baa_ref) reasons.push('A BAA reference is required before PHI can flow through this vendor.');
  const ob = latestOnboarding(db, scope, connectorId);
  if (!ob) reasons.push('No connector onboarding record exists.');
  else if (ob.completeness.missing.length) reasons.push(`Onboarding record incomplete: ${ob.completeness.missing.join(', ')}.`);
  if (ENVIRONMENT_FOR_GATE === 'synthetic') reasons.push('This environment is synthetic. Live integrations cannot be enabled here (docs/08).');
  reasons.push(...phiLiveReasons(db, scope, connectorId)); // PHI gate and vendor BAA register (ADR 0070)
  return reasons;
}

export function setMode(db: Db, scope: Scope, connectorId: string, mode: Mode) {
  const a = adapterFor(connectorId);
  if (!['local', 'simulated', 'disabled_live', 'live'].includes(mode)) throw invalid('Unknown mode');
  return tx(db, () => {
    const c = getConfig(db, scope, connectorId);
    if (mode === 'live') {
      const reasons = liveGate(db, scope, connectorId);
      audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'connector', objectId: connectorId,
        eventType: reasons.length ? 'connector_live_refused' : 'connector_live_enabled', details: { reasons } });
      if (reasons.length) throw new AppError(409, 'live_gate_closed', 'Live mode refused', { reasons });
    }
    if (mode !== 'live' && mode !== a.descriptor.defaultMode && mode !== 'disabled_live') throw invalid(`This connector supports ${a.descriptor.defaultMode} or disabled_live`);
    const before = c.mode;
    c.mode = mode;
    if (mode === 'disabled_live') c.enabled = false;
    saveConfig(db, scope, c);
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'connector', objectId: connectorId, eventType: 'connector_mode_changed', details: { before, after: mode } });
    return c;
  });
}

// ---------------------------------------------------------------- events, circuit breaker, health

const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;

function circuit(db: Db, scope: Scope, connectorId: string) {
  return one<{ state: 'closed' | 'open' | 'half_open'; consecutive_failures: number; opened_at: string | null }>(db,
    'SELECT state, consecutive_failures, opened_at FROM connector_circuits WHERE tenant_id=? AND client_id=? AND connector_id=?', scope.tenantId, scope.clientId, connectorId)
    ?? { state: 'closed' as const, consecutive_failures: 0, opened_at: null };
}

function setCircuit(db: Db, scope: Scope, connectorId: string, state: string, failures: number, openedAt: string | null) {
  run(db, `INSERT INTO connector_circuits VALUES (?,?,?,?,?,?,?) ON CONFLICT (tenant_id, client_id, connector_id) DO UPDATE SET state=excluded.state,
    consecutive_failures=excluded.consecutive_failures, opened_at=excluded.opened_at, updated_at=excluded.updated_at`, scope.tenantId, scope.clientId, connectorId, state, failures, openedAt, nowIso());
}

export function resetCircuit(db: Db, scope: Scope, connectorId: string) {
  setCircuit(db, scope, connectorId, 'closed', 0, null);
  audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'connector', objectId: connectorId, eventType: 'connector_circuit_reset', details: {} });
}

export function recordEvent(db: Db, scope: Scope, connectorId: string, req: ConnectorRequest, res: Omit<ConnectorResponse, 'connectorEventId' | 'connectorId' | 'requestId'>): ConnectorResponse {
  const eventId = newId('cev');
  run(db, 'INSERT INTO connector_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, eventId, connectorId, req.requestId, req.accountId, req.accountRevision,
    req.idempotencyKey, req.actionClass, res.outcome, canonicalJson(res.externalRefs), res.evidenceLocator ? canonicalJson(res.evidenceLocator) : null, res.sourceTime, res.receivedTime,
    res.rawSha256, canonicalJson(res.normalized ?? null), Math.round(res.latencyMs), res.error, scope.userId);
  return { connectorEventId: eventId, connectorId, requestId: req.requestId, ...res };
}

export function newRequest(scope: Scope, actionClass: ActionClass, payload: Record<string, unknown>, o: { accountId?: string | null; accountRevision?: number | null; idempotencyKey?: string | null; timeBudgetMs?: number } = {}): ConnectorRequest {
  return { requestId: newId('req'), scope: { tenantId: scope.tenantId, clientId: scope.clientId }, accountId: o.accountId ?? null, accountRevision: o.accountRevision ?? null,
    idempotencyKey: o.idempotencyKey ?? null, actionClass, timeBudgetMs: o.timeBudgetMs ?? 10_000, payload };
}

type Pre = { refused: ConnectorResponse } | { adapter: ConnectorAdapter; config: ConnectorConfig };

function precheck(db: Db, scope: Scope, connectorId: string, req: ConnectorRequest): Pre {
  const a = adapterFor(connectorId);
  const config = getConfig(db, scope, connectorId);
  const refuse = (error: string) => ({ refused: recordEvent(db, scope, connectorId, req, { outcome: 'refused', externalRefs: {}, evidenceLocator: null, sourceTime: null, receivedTime: nowIso(), rawSha256: null, normalized: null, latencyMs: 0, error }) });
  if (req.scope.tenantId !== scope.tenantId || req.scope.clientId !== scope.clientId) throw new AppError(403, 'scope_mismatch', 'Connector request scope does not match the caller');
  if (!a.descriptor.capabilities.includes(req.actionClass)) return refuse(`Action class ${req.actionClass} is not supported by ${connectorId}`);
  if (a.gate) {
    const reasons = a.gate(db, scope, config); // ADR 0100
    if (reasons.length) return refuse(`LiveExecutionDisabled: ${reasons.join(' ')}`);
  } else if (config.mode === 'disabled_live' || (config.mode === 'live' && liveGate(db, scope, connectorId).length)) {
    // Live adapters still run their execute() so they can throw LiveExecutionDisabled themselves.
    try { a.execute({ db, scope, config }, req); } catch (err) { if (err instanceof LiveExecutionDisabled) return refuse(`LiveExecutionDisabled: ${err.message}`); throw err; }
    return refuse('Live mode is not enabled for this connector');
  }
  if (config.mode === 'simulated' && !isSyntheticDeployment()) return refuse('Simulators do not run outside the synthetic environment (ADR 0090)');
  if (!config.enabled && !a.gate) return refuse('Connector is disabled for this client');
  const c = circuit(db, scope, connectorId);
  if (c.state === 'open') {
    const age = now().getTime() - Date.parse(c.opened_at ?? nowIso());
    if (age < CIRCUIT_COOLDOWN_MS) return refuse(`Circuit open after ${c.consecutive_failures} consecutive failures; retry after cooldown`);
    setCircuit(db, scope, connectorId, 'half_open', c.consecutive_failures, c.opened_at);
  }
  return { adapter: a, config };
}

function finish(db: Db, scope: Scope, connectorId: string, req: ConnectorRequest, r: AdapterResult, started: number): ConnectorResponse {
  const latency = r.latencyMs ?? Date.now() - started;
  if (latency > req.timeBudgetMs && r.outcome !== 'timeout') {
    // A read that exceeded its budget is reported as a timeout; the late answer is not used.
    r = { outcome: 'timeout', error: `Exceeded time budget ${req.timeBudgetMs} ms (took ${latency} ms)`, latencyMs: latency };
  }
  const failed = r.outcome === 'error' || r.outcome === 'timeout';
  const after = circuit(db, scope, connectorId);
  if (failed) {
    const n = after.consecutive_failures + 1;
    const open = n >= CIRCUIT_THRESHOLD || after.state === 'half_open';
    setCircuit(db, scope, connectorId, open ? 'open' : 'closed', n, open ? nowIso() : null);
    if (open && after.state !== 'open') audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'connector', objectId: connectorId, eventType: 'connector_circuit_opened', details: { failures: n } }); // notification hook (ADR 0070)
  } else if (after.state !== 'closed' || after.consecutive_failures) setCircuit(db, scope, connectorId, 'closed', 0, null);
  return recordEvent(db, scope, connectorId, req, {
    outcome: r.outcome, externalRefs: r.externalRefs ?? {}, evidenceLocator: r.evidenceLocator ?? null, sourceTime: r.sourceTime ?? null, receivedTime: nowIso(),
    rawSha256: r.raw ? sha256(r.raw) : null, normalized: r.normalized ?? null, latencyMs: latency, error: r.error ?? null, raw: r.raw ?? undefined,
  });
}

const failure = (err: unknown, started: number): AdapterResult => ({ outcome: 'error', error: (err as Error).message, latencyMs: Date.now() - started });

// The single entry point for calling an adapter.
export function invoke(db: Db, scope: Scope, connectorId: string, req: ConnectorRequest): ConnectorResponse {
  const pre = precheck(db, scope, connectorId, req);
  if ('refused' in pre) return pre.refused;
  const started = Date.now();
  let r: AdapterResult;
  try { r = pre.adapter.execute({ db, scope, config: pre.config }, req); } catch (err) {
    if (err instanceof LiveExecutionDisabled) throw err;
    r = failure(err, started);
  }
  return finish(db, scope, connectorId, req, r, started);
}

// Async form for network adapters. The database work before and after is synchronous.
export async function invokeAsync(db: Db, scope: Scope, connectorId: string, req: ConnectorRequest): Promise<ConnectorResponse> {
  const pre = precheck(db, scope, connectorId, req);
  if ('refused' in pre) return pre.refused;
  if (!pre.adapter.executeAsync) throw new AppError(500, 'not_async', `${connectorId} has no async execution`);
  const started = Date.now();
  let r: AdapterResult;
  try {
    r = await Promise.race([
      pre.adapter.executeAsync({ db, scope, config: pre.config }, req),
      new Promise<AdapterResult>((res) => setTimeout(() => res({ outcome: 'timeout', error: `No answer within ${req.timeBudgetMs} ms`, latencyMs: req.timeBudgetMs }), req.timeBudgetMs).unref()),
    ]);
  } catch (err) { r = failure(err, started); }
  return finish(db, scope, connectorId, req, r, started);
}

export function health(db: Db, scope: Scope, connectorId: string) {
  const a = adapterFor(connectorId);
  const config = getConfig(db, scope, connectorId);
  if (config.mode === 'disabled_live' && a.healthStub) return { ...a.healthStub(), status: 'disabled', lastSuccess: null, errorRate: null, avgLatencyMs: null, p95LatencyMs: null, events: 0, circuit: 'closed' };
  const rows = all<{ outcome: Outcome; latency_ms: number; received_time: string }>(db,
    'SELECT outcome, latency_ms, received_time FROM connector_events WHERE tenant_id=? AND client_id=? AND connector_id=? ORDER BY received_time DESC, rowid DESC LIMIT 50', scope.tenantId, scope.clientId, connectorId);
  const c = circuit(db, scope, connectorId);
  const considered = rows.filter((r) => r.outcome !== 'refused');
  const failures = considered.filter((r) => r.outcome === 'error' || r.outcome === 'timeout').length;
  const lat = considered.map((r) => r.latency_ms).sort((x, y) => x - y);
  const lastSuccess = rows.find((r) => r.outcome === 'success' || r.outcome === 'partially_completed' || r.outcome === 'not_found')?.received_time ?? null;
  const errorRate = considered.length ? failures / considered.length : null;
  const status = c.state === 'open' ? 'circuit_open' : !config.enabled ? 'disabled' : !considered.length ? 'no_traffic' : (errorRate ?? 0) > 0.25 ? 'degraded' : 'healthy';
  return { status, detail: '', lastSuccess, errorRate, avgLatencyMs: lat.length ? Math.round(lat.reduce((s, x) => s + x, 0) / lat.length) : null,
    p95LatencyMs: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : null, events: rows.length, circuit: c.state };
}

export function recentEvents(db: Db, scope: Scope, connectorId: string | null, limit = 25) {
  const rows = all<Record<string, unknown> & { external_refs: string; evidence_locator: string | null; normalized: string }>(db,
    `SELECT event_id, connector_id, request_id, account_id, account_revision, action_class, outcome, external_refs, evidence_locator, source_time, received_time, raw_sha256, latency_ms, error, created_by, normalized
     FROM connector_events WHERE tenant_id=? AND client_id=? ${connectorId ? 'AND connector_id=?' : ''} ORDER BY received_time DESC, rowid DESC LIMIT ?`,
    ...(connectorId ? [scope.tenantId, scope.clientId, connectorId, limit] : [scope.tenantId, scope.clientId, limit]));
  return rows.map((r) => ({ ...r, external_refs: JSON.parse(r.external_refs), evidence_locator: r.evidence_locator ? JSON.parse(r.evidence_locator) : null, normalized: JSON.parse(r.normalized) }));
}
