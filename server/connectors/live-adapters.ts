// Disabled live adapters. Each is a typed, configured boundary with an onboarding checklist
// and a health stub, and every execution throws LiveExecutionDisabled. Endpoint URLs are
// configuration: only paths read in public vendor documentation during this build are listed
// (documentedPaths, with the source); nothing else about a vendor is assumed.
import { LiveExecutionDisabled } from './executors.ts';
import { type ConnectorAdapter, type ConnectorDescriptor, registerAdapter } from './framework.ts';

const COMMON_CHECKLIST = [
  'Customer authorization recorded (connector_authorizations) with covered-service verification',
  'Business associate agreement and subprocessor review where PHI flows (docs/08)',
  'Complete connector onboarding record (docs/07: endpoint set, scopes, custodian, mappings, allowlist, region, retention, owner)',
  'Credentials held in a secrets manager by the named custodian (never in prompts, code or config files)',
  'Versioned field mapping applied to a synthetic round-trip test before PHI',
  'Sandbox evidence attached; rate limits and expected receipts documented',
  'Environment is not synthetic (shadow or assisted-live gate per docs/09)',
];

export interface LiveConfig { baseUrl: string | null; tokenUrl: string | null; clientId: string | null; credentialRef: string | null; extra: Record<string, string> }

function liveAdapter(d: Omit<ConnectorDescriptor, 'defaultMode' | 'liveCapable'>, checklist: string[]): ConnectorAdapter & { checklist: string[]; config: LiveConfig } {
  const descriptor: ConnectorDescriptor = { ...d, defaultMode: 'disabled_live', liveCapable: true };
  return {
    descriptor,
    checklist: [...COMMON_CHECKLIST, ...checklist],
    config: { baseUrl: null, tokenUrl: null, clientId: null, credentialRef: null, extra: {} },
    execute() {
      throw new LiveExecutionDisabled(`${d.displayName} is a disabled live adapter. No authorization, covered-service verification or credentials are recorded, and this environment is synthetic.`);
    },
    healthStub() {
      return { status: 'disabled', detail: 'Live adapter disabled: not probed. No endpoint or credentials are configured.' };
    },
  };
}

export const availity = liveAdapter({
  id: 'availity', displayName: 'Availity (clearinghouse REST APIs)', vendor: 'Availity', kind: 'clearinghouse',
  capabilities: ['read_eligibility', 'read_status', 'read_remittance'], transactions: ['270/271 (Coverages API)', '276/277 (Claim Statuses API)', '835 (Remittance Data API, beta)'],
  configFields: [{ key: 'baseUrl', label: 'API base URL (from the contract)' }, { key: 'tokenUrl', label: 'OAuth token URL' }, { key: 'clientId', label: 'Client ID' }, { key: 'credentialRef', label: 'Secret reference', secret: true }],
  documentedPaths: [
    { path: 'POST /v1/coverages, GET /v1/coverages/{id} (asynchronous: statusCode 0 "In Progress" until complete)', source: 'https://developer.availity.com/blog/2025/3/25/hipaa-transactions' },
    { path: 'https://api.availity.com/availity/v1/configurations', source: 'https://developer.availity.com/blog/2025/3/25/hipaa-transactions' },
  ],
  phi: true, requiresBaa: true,
  notes: ['Payer-level enrollment and additional contracts may be required per payer (payer list availability/enrollmentRequired).', 'Grant type not confirmed from the page read; to be taken from the contracted documentation.'],
  sources: [{ title: 'Availity HIPAA transactions (S17)', url: 'https://developer.availity.com/blog/2025/3/25/hipaa-transactions', retrievedAt: '2026-10-12' }],
}, ['Availity portal organization and API application registration', 'Per-payer enrollment confirmed for each payer ID', 'Asynchronous polling budget agreed (coverage requests can stay In Progress)']);

export const optum = liveAdapter({
  id: 'optum_change_healthcare', displayName: 'Optum / Change Healthcare (claim status, eligibility)', vendor: 'Optum (Change Healthcare)', kind: 'clearinghouse',
  capabilities: ['read_status', 'read_eligibility'], transactions: ['276/277 (Claim Status V2, JSON or raw X12)', '270/271'],
  configFields: [{ key: 'baseUrl', label: 'Sandbox or production base URL (from the contract)' }, { key: 'clientId', label: 'Client ID' }, { key: 'credentialRef', label: 'Secret reference', secret: true }],
  documentedPaths: [
    { path: 'Token: /apip/auth/v2/token (bearer token lifetime 3600 s)', source: 'https://developer.optum.com/eligibilityandclaims/docs/claim-status-v2-getting-started' },
    { path: 'POST claimstatus/v2/ ; claimstatus/v2/raw-x12 ; /claimstatus/v2/healthcheck', source: 'https://developer.optum.com/eligibilityandclaims/docs/claim-status-v2-getting-started' },
  ],
  phi: true, requiresBaa: true, notes: ['Base URLs were not stated on the page read; they come from the contract.'],
  sources: [{ title: 'Optum Claim Status V2 getting started', url: 'https://developer.optum.com/eligibilityandclaims/docs/claim-status-v2-getting-started', retrievedAt: '2026-10-12' }],
}, ['Trading partner service IDs mapped per payer', 'Healthcheck endpoint wired to the connector health probe']);

export const epic = liveAdapter({
  id: 'epic', displayName: 'Epic (FHIR and financial interfaces)', vendor: 'Epic', kind: 'ehr_api',
  capabilities: ['read_clinical_financial', 'read_remittance', 'writeback'], transactions: ['FHIR R4 read (Coverage, ExplanationOfBenefit)', 'Incoming Health Care Claim Payment/Advice (X12 835)', 'Outgoing Claims Status Request (X12 276/277)'],
  configFields: [{ key: 'baseUrl', label: 'FHIR base URL of the customer instance' }, { key: 'tokenUrl', label: 'SMART token endpoint' }, { key: 'clientId', label: 'Backend app client ID' }, { key: 'credentialRef', label: 'Private key reference', secret: true }],
  phi: true, requiresBaa: true,
  notes: ['open.epic.com lists financial interfaces (835 incoming, 276/277 outgoing, 277CA, 999) but not access requirements; entitlement is customer- and contract-specific.',
    'A FHIR demo does not establish write-back or financial endpoint access (docs/07).'],
  sources: [{ title: 'Epic Claims and Remittance interfaces (S15)', url: 'https://open.epic.com/Financial/Claims', retrievedAt: '2026-10-12' },
    { title: 'SMART Backend Services v2.2.0', url: 'https://hl7.org/fhir/smart-app-launch/backend-services.html', retrievedAt: '2026-10-12' }],
}, ['Exact Epic version, hosting arrangement and enabled endpoints inventoried', 'App registered and approved by the customer; JWKS published', 'Write-back target (task or note field) approved separately from read access']);

export const athena = liveAdapter({
  id: 'athenahealth', displayName: 'athenahealth (API)', vendor: 'athenahealth', kind: 'pm_api',
  capabilities: ['read_clinical_financial', 'writeback'], transactions: ['Practice management API (scoped)'],
  configFields: [{ key: 'baseUrl', label: 'API base URL (preview or production, from the contract)' }, { key: 'tokenUrl', label: 'Token URL' }, { key: 'clientId', label: 'Client ID' }, { key: 'credentialRef', label: 'Secret reference', secret: true }],
  phi: true, requiresBaa: true,
  notes: ['The authorization overview page could not be read in this session (client-rendered); scopes, token lifetime and endpoints are unverified and left as configuration.'],
  sources: [{ title: 'athenahealth authorization overview (S16) — not readable in this session', url: 'https://docs.athenahealth.com/api/guides/authorization-overview', retrievedAt: '2026-10-12' }],
}, ['Practice ID(s) and scope list confirmed with the customer', 'Preview environment round-trip test before production']);

export const sftpEdi = liveAdapter({
  id: 'sftp_edi', displayName: 'Generic SFTP EDI drop (835/277/271 files)', vendor: 'Customer or clearinghouse SFTP', kind: 'sftp',
  capabilities: ['read_remittance', 'read_status', 'read_eligibility', 'ingest_file'], transactions: ['835', '277', '277CA', '271', '999'],
  configFields: [{ key: 'baseUrl', label: 'Host and port' }, { key: 'extra.inboundPath', label: 'Inbound directory' }, { key: 'credentialRef', label: 'Key reference', secret: true }, { key: 'extra.hostKey', label: 'Pinned host key fingerprint' }],
  phi: true, requiresBaa: true,
  notes: ['Files would flow into the same EDI ingestion (preview, identity match, evidence) used by the upload API.'],
  sources: [{ title: 'Build pack docs/07 integrations and data contracts', url: 'docs/07_INTEGRATIONS_AND_DATA_CONTRACTS.md', retrievedAt: 'build pack' }],
}, ['Host key pinned; key-based auth only', 'File naming, archive and retention agreed', 'Duplicate file detection by sha256 (already enforced by edi_files)']);

export const twilio = liveAdapter({
  id: 'twilio_voice', displayName: 'Twilio (voice)', vendor: 'Twilio', kind: 'voice',
  capabilities: ['call'], transactions: ['Outbound payer calls (start, cancel, transfer, retrieve result)'],
  configFields: [{ key: 'clientId', label: 'Account SID' }, { key: 'credentialRef', label: 'Auth token reference', secret: true }, { key: 'extra.callerId', label: 'Caller ID number' }],
  phi: true, requiresBaa: true,
  notes: ['Twilio states customers must execute a BAA before building workflows that contain PHI, and that a BAA requires the Security or Enterprise edition; only HIPAA Eligible Products and Services may carry PHI (eligible product list not verified here).',
    'Telephony also needs TCPA, recording and disclosure review (docs/07 telephony checklist).'],
  sources: [{ title: 'Twilio HIPAA (S20)', url: 'https://www.twilio.com/en-us/hipaa', retrievedAt: '2026-10-12' }],
}, ['BAA executed on Security or Enterprise edition', 'Voice, recording and transcription confirmed on the HIPAA eligible products list', 'Callback signature verification wired through the webhook framework', 'Legal review: TCPA, call recording consent, disclosure']);

export const LIVE_ADAPTERS = [availity, optum, epic, athena, sftpEdi, twilio];
for (const a of LIVE_ADAPTERS) registerAdapter(a);
