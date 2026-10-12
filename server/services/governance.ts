// Ported from clinic-receptionist src/governance.ts (same owner): the PHI gate.
//
// Every layer that could send data outside this process declares its `vendors` (connectors,
// call engines, notification destinations, the extraction "model" layer, hosting). phiReadiness()
// lists what is missing before real patient data may flow: a signed BAA for each vendor in use,
// the encryption key for free text at rest, guarded call engines only, and a non-synthetic
// environment. A deployment-level AR_PHI_MODE=on refuses to start unless the deployment-level
// safeguards are present, and nothing ingests non-synthetic data or enables a live connector
// unless every safeguard holds for that tenant/client.
//
// Adapted for AR Resolve: the origin read BAA_SIGNED from an environment variable. Here the BAA
// register is data (vendor_baas, migration 070): versioned, append-only, scoped to tenant/client,
// written only by integration_admin and audited. It backs ADR 0030's live gate (the recorded
// customer authorization and BAA reference stay required; the register adds the vendor side).
// Recording a BAA as signed is a person's attestation; code cannot verify a contract.
import { type Db, all, one, run, tx } from '../db/db.ts';
import { AppError, canonicalJson, invalid, nowIso, sha256 } from '../util.ts';
import { audit } from './audit.ts';
import { requirePerm, type Scope } from './auth.ts';
import { sealingEnabled, phiKey } from './phi.ts';
import type { Settings } from '../core/registry.ts';
import { CALL_ENGINES, enabledEngines } from '../connectors/telephony/engines.ts';
import { allAdapters, adapterFor, getConfig, ENVIRONMENT_FOR_GATE, type ConnectorDescriptor } from '../connectors/framework.ts';
import { NOTIFY_CONNECTORS, enabledChannelVendors } from './notifications.ts';

export const GOVERNANCE_VERSION = 'phi-gate.v1';
export const BAA_STATUSES = ['signed', 'not_signed', 'in_negotiation', 'terminated'] as const;
export type BaaStatus = (typeof BAA_STATUSES)[number];

/**
 * Vendor ids per connector. A descriptor may declare `vendors` itself; otherwise this table is
 * used. Simulators and local intake declare none. Ids are register keys, not legal names.
 */
const CONNECTOR_VENDORS: Record<string, string[]> = {
  availity: ['availity'],
  optum_change_healthcare: ['optum'],
  epic: ['epic'],
  athenahealth: ['athenahealth'],
  sftp_edi: ['sftp_host'],
  twilio_voice: ['twilio'],
};

export function connectorVendors(d: ConnectorDescriptor): string[] {
  return (d as ConnectorDescriptor & { vendors?: string[] }).vendors ?? CONNECTOR_VENDORS[d.id] ?? [];
}

/** The extraction layer. AR Resolve extracts with deterministic parsers; no model vendor sees text. */
export const EXTRACTION_LAYER = { id: 'deterministic_extract', label: 'Deterministic transcript and document extraction (no model)', vendors: [] as string[] };

export function phiModeOn(settings: Settings = process.env): boolean {
  return (settings.AR_PHI_MODE ?? '').toLowerCase() === 'on';
}

export function hostingVendors(settings: Settings = process.env): string[] {
  return (settings.AR_HOSTING_VENDORS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// ---------------------------------------------------------------- vendor / BAA register

interface BaaRow { tenant_id: string; client_id: string; vendor_id: string; version: number; status: BaaStatus; baa_ref: string | null; covered_services: string;
  effective_on: string | null; expires_on: string | null; notes: string; record_sha256: string; recorded_by: string; recorded_at: string }

const toBaa = (r: BaaRow) => ({ vendorId: r.vendor_id, version: r.version, status: r.status, baaRef: r.baa_ref, coveredServices: JSON.parse(r.covered_services) as string[],
  effectiveOn: r.effective_on, expiresOn: r.expires_on, notes: r.notes, sha256: r.record_sha256, recordedBy: r.recorded_by, recordedAt: r.recorded_at });
export type BaaRecord = ReturnType<typeof toBaa>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function latestBaa(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>, vendorId: string): BaaRecord | null {
  const r = one<BaaRow>(db, 'SELECT * FROM vendor_baas WHERE tenant_id=? AND client_id=? AND vendor_id=? ORDER BY version DESC LIMIT 1', scope.tenantId, scope.clientId, vendorId);
  return r ? toBaa(r) : null;
}

/** A BAA counts only while it is recorded as signed, has started and has not expired. */
export function baaInForce(b: BaaRecord | null, today = nowIso().slice(0, 10)): boolean {
  if (!b || b.status !== 'signed') return false;
  if (b.effectiveOn && b.effectiveOn > today) return false;
  return !b.expiresOn || b.expiresOn >= today;
}

export function signedVendors(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId'>): Set<string> {
  const rows = all<BaaRow>(db, `SELECT b.* FROM vendor_baas b WHERE b.tenant_id=? AND b.client_id=? AND b.version = (SELECT MAX(version) FROM vendor_baas x
    WHERE x.tenant_id=b.tenant_id AND x.client_id=b.client_id AND x.vendor_id=b.vendor_id)`, scope.tenantId, scope.clientId);
  return new Set(rows.map(toBaa).filter((b) => baaInForce(b)).map((b) => b.vendorId));
}

export function recordBaa(db: Db, scope: Scope, vendorId: string, body: Record<string, unknown>) {
  requirePerm(scope, 'integration_admin');
  if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(vendorId)) throw invalid('vendorId must be lowercase letters, digits, - or _');
  const status = String(body.status ?? '') as BaaStatus;
  if (!BAA_STATUSES.includes(status)) throw invalid(`status must be one of ${BAA_STATUSES.join(', ')}`);
  const baaRef = body.baaRef === undefined || body.baaRef === null || body.baaRef === '' ? null : String(body.baaRef).trim();
  const effectiveOn = body.effectiveOn ? String(body.effectiveOn) : null;
  const expiresOn = body.expiresOn ? String(body.expiresOn) : null;
  if (effectiveOn && !validDate(effectiveOn)) throw invalid('effectiveOn must be a date (YYYY-MM-DD)');
  if (expiresOn && !validDate(expiresOn)) throw invalid('expiresOn must be a date (YYYY-MM-DD)');
  if (effectiveOn && expiresOn && expiresOn <= effectiveOn) throw invalid('expiresOn must be after effectiveOn');
  const services = body.coveredServices === undefined ? [] : body.coveredServices;
  if (!Array.isArray(services) || services.length > 20 || !services.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 120)) throw invalid('coveredServices must be a list of up to 20 service names');
  const notes = String(body.notes ?? '').trim().slice(0, 2000);
  if (status === 'signed') {
    if (!baaRef || baaRef.length < 3) throw invalid('A signed BAA needs baaRef (where the executed agreement is filed)');
    if (!effectiveOn) throw invalid('A signed BAA needs effectiveOn');
    if (!services.length) throw invalid('A signed BAA needs the covered services, as listed in the agreement');
  }
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 10) throw invalid('A reason of at least 10 characters is required');
  return tx(db, () => {
    const prev = latestBaa(db, scope, vendorId);
    const version = (prev?.version ?? 0) + 1;
    const record = { vendorId, status, baaRef, coveredServices: services.map((s: string) => s.trim()), effectiveOn, expiresOn, notes };
    const hash = sha256(canonicalJson(record));
    run(db, 'INSERT INTO vendor_baas VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', scope.tenantId, scope.clientId, vendorId, version, status, baaRef, JSON.stringify(record.coveredServices),
      effectiveOn, expiresOn, notes, hash, scope.userId, nowIso());
    audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'vendor_baa', objectId: vendorId, eventType: 'vendor_baa_recorded',
      details: { version, status, previousStatus: prev?.status ?? null, sha256: hash, reason, attestation: 'Recorded by a person; the code cannot verify a contract.' } });
    return latestBaa(db, scope, vendorId)!;
  });
}

export function baaHistory(db: Db, scope: Scope, vendorId: string): BaaRecord[] {
  requirePerm(scope, 'integration_admin');
  return all<BaaRow>(db, 'SELECT * FROM vendor_baas WHERE tenant_id=? AND client_id=? AND vendor_id=? ORDER BY version DESC', scope.tenantId, scope.clientId, vendorId).map(toBaa);
}

// ---------------------------------------------------------------- readiness

export interface LayerUse { layer: 'hosting' | 'connector' | 'engine' | 'notification' | 'extraction'; id: string; label: string; vendors: string[]; carriesPhi: boolean; inUse: boolean; guarded?: boolean }
export interface ReadinessCheck { id: string; label: string; ok: boolean; detail: string }
export interface PhiReadiness {
  version: string; phiMode: 'on' | 'off'; environment: string; ready: boolean; missing: string[]; checks: ReadinessCheck[]; layers: LayerUse[];
  vendors: { vendorId: string; requiredBy: string[]; required: boolean; baa: BaaRecord | null; inForce: boolean }[];
}

/** Every layer, with its vendors and whether it would carry PHI for this scope right now. */
export function layersFor(db: Db, scope: Pick<Scope, 'tenantId' | 'clientId' | 'userId'> & Scope, settings: Settings = process.env): LayerUse[] {
  const layers: LayerUse[] = [];
  const hosting = hostingVendors(settings);
  layers.push({ layer: 'hosting', id: 'hosting', label: 'Hosting, database and backups (AR_HOSTING_VENDORS)', vendors: hosting, carriesPhi: true, inUse: true });
  layers.push({ layer: 'extraction', id: EXTRACTION_LAYER.id, label: EXTRACTION_LAYER.label, vendors: EXTRACTION_LAYER.vendors, carriesPhi: true, inUse: true });
  for (const a of allAdapters()) {
    const d = a.descriptor;
    const mode = getConfig(db, scope, d.id).mode;
    layers.push({ layer: 'connector', id: d.id, label: d.displayName, vendors: connectorVendors(d), carriesPhi: d.phi, inUse: mode === 'live' });
  }
  const enabled = new Set(enabledEngines(settings).map((e) => e.id));
  for (const e of CALL_ENGINES.list()) layers.push({ layer: 'engine', id: e.id, label: e.label ?? e.id, vendors: [...e.vendors], carriesPhi: true, inUse: enabled.has(e.id), guarded: e.guarded });
  const channelVendors = enabledChannelVendors(db, scope);
  for (const c of NOTIFY_CONNECTORS.list()) {
    const used = channelVendors.get(c.id);
    // Notifications carry opaque ids only unless a channel asks for details (notifications.ts).
    layers.push({ layer: 'notification', id: c.id, label: c.label ?? c.id, vendors: [...new Set([...c.vendors, ...(used?.extraVendors ?? [])])], carriesPhi: !!used?.details, inUse: !!used });
  }
  return layers;
}

/**
 * What stands between this deployment/scope and real patient data. `forConnector` adds that
 * connector's vendors as required (the live gate asks about one connector at a time).
 */
export function phiReadiness(db: Db, scope: Scope, settings: Settings = process.env, forConnector?: string): PhiReadiness {
  const layers = layersFor(db, scope, settings);
  const signed = signedVendors(db, scope);
  const checks: ReadinessCheck[] = [];
  const environment = ENVIRONMENT_FOR_GATE;
  checks.push({ id: 'environment', label: 'Environment is not synthetic', ok: environment !== 'synthetic', detail: `AR_ENVIRONMENT=${environment}` });
  let keyOk = false;
  let keyDetail = 'AR_PHI_KEY is not set: free text (transcripts, notes, notification payloads) would be stored in plaintext';
  try { keyOk = phiKey(settings) !== null; if (keyOk) keyDetail = 'AR_PHI_KEY is set (AES-256-GCM sealing on)'; } catch (e) { keyDetail = (e as Error).message; }
  checks.push({ id: 'encryption_key', label: 'Encryption key for free text at rest', ok: keyOk, detail: keyDetail });
  const hosting = hostingVendors(settings);
  checks.push({ id: 'hosting_declared', label: 'Hosting vendor declared', ok: hosting.length > 0, detail: hosting.length ? hosting.join(', ') : 'AR_HOSTING_VENDORS is not set; no hosting provider is selected' });
  const unguarded = layers.filter((l) => l.layer === 'engine' && l.inUse && l.guarded === false);
  checks.push({ id: 'guarded_engines', label: 'Every enabled call engine runs the code Guard', ok: unguarded.length === 0,
    detail: unguarded.length ? `Unguarded: ${unguarded.map((l) => l.id).join(', ')}` : 'All enabled engines are guarded' });
  checks.push({ id: 'extraction_vendors', label: 'Extraction layer vendors', ok: true, detail: 'Deterministic parsers; no model vendor receives text' });

  const requiredBy = new Map<string, string[]>();
  const need = (v: string, by: string) => requiredBy.set(v, [...(requiredBy.get(v) ?? []), by]);
  for (const l of layers) if (l.inUse && l.carriesPhi) for (const v of l.vendors) need(v, `${l.layer}:${l.id}`);
  if (forConnector) for (const v of connectorVendors(adapterFor(forConnector).descriptor)) need(v, `connector:${forConnector}`);
  const allVendors = new Set<string>([...requiredBy.keys(), ...layers.flatMap((l) => l.vendors)]);
  const vendors = [...allVendors].sort().map((v) => ({ vendorId: v, requiredBy: requiredBy.get(v) ?? [], required: requiredBy.has(v), baa: latestBaa(db, scope, v), inForce: signed.has(v) }));
  const missingBaas = vendors.filter((v) => v.required && !v.inForce);
  checks.push({ id: 'baas', label: 'BAA in force for every vendor in use', ok: missingBaas.length === 0,
    detail: missingBaas.length ? `Missing: ${missingBaas.map((v) => `${v.vendorId} (${v.requiredBy.join(', ')})`).join('; ')}` : 'Every required vendor has a signed BAA on record' });
  checks.push({ id: 'phi_mode', label: 'AR_PHI_MODE=on (deployment declares it handles real patient data)', ok: phiModeOn(settings), detail: `AR_PHI_MODE=${settings.AR_PHI_MODE ?? 'off'}` });

  const missing = checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`);
  return { version: GOVERNANCE_VERSION, phiMode: phiModeOn(settings) ? 'on' : 'off', environment, ready: missing.length === 0, missing, checks, layers, vendors };
}

/**
 * Deployment-level check run before the server starts. With AR_PHI_MODE=on the process refuses to
 * start unless the safeguards that do not depend on tenant data are in place. BAAs are tenant data
 * and are checked by the live gate and the ingest gate.
 */
export function startupProblems(settings: Settings = process.env, environment: string = ENVIRONMENT_FOR_GATE): string[] {
  if (!phiModeOn(settings)) return [];
  const problems: string[] = [];
  if (environment === 'synthetic') problems.push('AR_PHI_MODE=on but AR_ENVIRONMENT is synthetic');
  if (!sealingEnabled(settings)) problems.push('AR_PHI_MODE=on but AR_PHI_KEY is missing or invalid');
  if (!hostingVendors(settings).length) problems.push('AR_PHI_MODE=on but AR_HOSTING_VENDORS is not declared');
  for (const e of enabledEngines(settings)) if (!e.guarded) problems.push(`AR_PHI_MODE=on but call engine ${e.id} is enabled and unguarded`);
  return problems;
}

/** Reasons the PHI gate adds to a connector's live gate (framework.liveGate). */
export function phiLiveReasons(db: Db, scope: Scope, connectorId: string, settings: Settings = process.env): string[] {
  const d = adapterFor(connectorId).descriptor;
  if (!d.liveCapable) return [];
  const r = phiReadiness(db, scope, settings, connectorId);
  return r.missing.filter((m) => !m.startsWith('Environment is not synthetic')).map((m) => `PHI gate: ${m}`);
}

/** Ingest gate. Synthetic data always passes; anything else needs AR_PHI_MODE=on and full readiness. */
export function assertMayIngest(db: Db, scope: Scope, o: { source: string; synthetic: boolean; why: string }, settings: Settings = process.env): void {
  if (o.synthetic) return;
  const r = phiReadiness(db, scope, settings);
  const reasons = !phiModeOn(settings) ? ['AR_PHI_MODE is off: this deployment accepts synthetic data only', ...r.missing.filter((m) => !m.startsWith('AR_PHI_MODE'))] : r.missing;
  if (!reasons.length) return;
  audit(db, { tenantId: scope.tenantId, clientId: scope.clientId, actorId: scope.userId, objectType: 'phi_gate', objectId: o.source, eventType: 'phi_gate_refused',
    details: { source: o.source, why: o.why, reasons: reasons.length } });
  throw new AppError(409, 'phi_gate_closed', 'This data is not marked synthetic and the deployment is not ready for patient data', { source: o.source, why: o.why, reasons });
}

// Synthetic markers used by the generated cohort. Data is treated as synthetic only when every
// identifier carries them; anything else is treated as possibly real.
const SYN_EXT = /^SYN[A-Z]?-/;
const SYN_CLAIM = /^SYN[A-Z]?-C/;
const SYN_PT = /^PT-/;

export function isSyntheticInventoryRow(r: Record<string, string>): boolean {
  const ext = r.external_id ?? '';
  const claim = r.claim_reference ?? '';
  const pt = r.patient_token ?? '';
  return (!ext || SYN_EXT.test(ext)) && (!claim || SYN_CLAIM.test(claim)) && (!pt || SYN_PT.test(pt));
}

/**
 * X12 interchange usage indicator ISA15: "P" = Production, "T" = Test (Nevada Medicaid 835
 * companion guide, https://www.medicaid.nv.gov/Downloads/provider/companionguide835.pdf, page 4,
 * retrieved 2026-10-12). A production interchange is treated as possibly real.
 */
export function isSyntheticInterchange(usage: string): boolean {
  return usage === 'T';
}
