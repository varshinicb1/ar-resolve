// Registers every connector adapter. Import this module once (routes do) before using the framework.
import { registerAdapter } from './framework.ts';
import './sim-clearinghouse.ts';
import './fhir/service.ts';
import './live-adapters.ts';
import './webhooks.ts';

registerAdapter({
  descriptor: {
    id: 'edi_upload', displayName: 'EDI file intake (835 / 277 / 277CA / 271 / 999)', vendor: 'Local upload', kind: 'edi_file', defaultMode: 'local', liveCapable: false,
    capabilities: ['ingest_file'], transactions: ['835', '277', '277CA', '271', '999'], configFields: [{ key: 'mappingOptions', label: '271 mapping options' }], phi: false, requiresBaa: false,
    notes: ['Synthetic files only in this environment. Upload, preview with identity matching, then ingest bound to the previewed sha256.',
      'A real 835/277 feed needs the licensed X12 TR3s and the payer companion guides (docs/07).'],
    sources: [{ title: 'x12.org public EDI examples (005010X221, X212, X279, X231, X214)', url: 'https://x12.org/examples', retrievedAt: '2026-10-12' },
      { title: 'CMS 835 companion guide (5010A1, v3.0, 2012)', url: 'https://www.cms.gov/medicare/billing/electronicbillingeditrans/downloads/5010a1835cg.pdf', retrievedAt: '2026-10-12' },
      { title: 'CMS HETS 270/271 companion guide v14.0 (2025-11)', url: 'https://www.cms.gov/files/document/hets2025-4-hets-270-271-companion-guide-v14-0.pdf', retrievedAt: '2026-10-12' }],
  },
  execute() { return { outcome: 'success' }; },
});

export { allAdapters } from './framework.ts';
