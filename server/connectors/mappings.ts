// Versioned field mappings: which source element becomes which fact, and how. The
// definition is data (hashed and pinned in field_mapping_versions); the transform code in
// observations.ts implements exactly these rows. Changing a row means a new version.
import { type Db, one, run } from '../db/db.ts';
import { canonicalJson, nowIso, sha256 } from '../util.ts';

export interface FieldRow { fact: string; source: string; transform: string; sourceRef: string; assumption?: string }
export interface MappingDefinition { id: string; version: number; transactionKind: string; sourceClass: 'document' | 'structured'; fields: FieldRow[]; notes: string[] }

const X12_835 = 'x12.org 005010X221 Example 01; CMS 835 companion guide 5010A1 v3.0; CMS 4010A1 Part B 835 companion document';

export const MAPPINGS: MappingDefinition[] = [
  {
    id: 'x12-835-claim', version: 1, transactionKind: '835', sourceClass: 'document',
    fields: [
      { fact: 'claimReference', source: 'CLP01', transform: 'verbatim', sourceRef: X12_835 },
      { fact: 'eobPatientToken', source: 'NM1*QC NM109 (NM108=MI)', transform: 'verbatim', sourceRef: X12_835,
        assumption: 'Synthetic convention: the patient token is carried as the member identifier. Real files need a client crosswalk (Blocked on design partner).' },
      { fact: 'eobServiceDate', source: 'first SVC loop DTM*472, else claim DTM*232', transform: 'CCYYMMDD → YYYY-MM-DD', sourceRef: X12_835 },
      { fact: 'allowedCents', source: 'first SVC loop AMT*B6', transform: 'decimal dollars → integer cents', sourceRef: X12_835 },
      { fact: 'adjustmentGroup', source: 'first SVC loop CAS01 of the triplet with reason 1', transform: 'verbatim', sourceRef: `${X12_835}; x12.org CARC list (1 = Deductible Amount)` },
      { fact: 'appliedCents', source: 'first SVC loop CAS amount of the triplet with reason 1', transform: 'decimal dollars → integer cents; 0 when the line balances and no reason-1 triplet exists',
        sourceRef: `${X12_835}; x12.org CARC list`, assumption: 'Zero is derived only from a balanced line (charge - paid = sum of adjustments); an unbalanced line yields no observation.' },
      { fact: 'claimPaidCents', source: 'CLP04', transform: 'decimal dollars → integer cents', sourceRef: X12_835 },
      { fact: 'processedDate', source: 'DTM*405 (production date)', transform: 'CCYYMMDD → YYYY-MM-DD', sourceRef: 'Nevada Medicaid 835 companion guide v2.2 (DTM01 405 production)' },
    ],
    notes: ['CLP02 = 22 (reversal) claims never produce observations; they are reported and linked to the original by CLP07 (Minnesota Uniform Companion Guide v14.0 §2.2.1).',
      'PLB provider-level adjustments are reported per file, not attributed to an account.'],
  },
  {
    id: 'x12-277-status', version: 1, transactionKind: '277', sourceClass: 'structured',
    fields: [
      { fact: 'claimReference', source: 'REF*EJ (patient account number)', transform: 'verbatim', sourceRef: 'x12.org 005010X212 Example 1a/1b' },
      { fact: 'claimStatusCategory', source: 'first claim-level STC01-1', transform: 'verbatim', sourceRef: 'x12.org 005010X212 Example 1b; x12.org claim status category codes' },
      { fact: 'claimPaidCents', source: 'first claim-level STC05 when present', transform: 'decimal dollars → integer cents', sourceRef: 'x12.org 005010X212 Example 1b' },
    ],
    notes: ['277CA (005010X214) acknowledgments are stored with observation key claimAcknowledgment only: acceptance is not adjudication (docs/07).'],
  },
  {
    id: 'x12-271-benefits', version: 1, transactionKind: '271', sourceClass: 'structured',
    fields: [
      { fact: 'limitCents', source: 'EB01=C, EB02 IND (or empty), EB03 includes 30 (or empty), EB06 23 or empty, EB12 not N; EB07', transform: 'decimal dollars → integer cents',
        sourceRef: 'CMS HETS 270/271 companion guide v14.0 (EB*C**30*MB**23*257); UHC 270/271 companion guide v9.0 (EB*C*IND*33****500*****Y)' },
      { fact: 'deductibleRemainingCents', source: 'same as limit with EB06 29', transform: 'decimal dollars → integer cents',
        sourceRef: 'CMS HETS 270/271 companion guide v14.0 (EB*C**30*MB**29*0); UHC 270/271 companion guide v9.0 (EB06 29 remaining)' },
      { fact: 'metBeforeCents', source: 'limit - remaining', transform: 'derived, only when mappingOptions.deriveMetBeforeFromRemaining is on and DTP*291 covers the DOS',
        sourceRef: 'Derivation, not a payer statement', assumption: 'Remaining is reported as of the inquiry, which may include later claims. Off by default; a client must opt in.' },
      { fact: 'secondaryAtDos', source: 'EB01=R present', transform: '"active" (absence never maps to "none")',
        sourceRef: 'Minnesota best practice "Reporting other or additional payor information" (2019): EB01 R = Other or Additional Payor',
        assumption: 'EB01 R says another payer exists, not which is primary. Used only when mappingOptions.otherPayerMeansSecondary is on (default on for the synthetic client).' },
    ],
    notes: ['AAA rejections produce no observations. Family-level and out-of-network amounts are reported but not mapped.'],
  },
  {
    id: 'fhir-r4-eob', version: 1, transactionKind: 'ExplanationOfBenefit', sourceClass: 'document',
    fields: [
      { fact: 'claimReference', source: 'ExplanationOfBenefit.identifier[0].value', transform: 'verbatim', sourceRef: 'hl7.org/fhir/R4/explanationofbenefit.html' },
      { fact: 'eobPatientToken', source: 'Patient.identifier[0].value via ExplanationOfBenefit.patient', transform: 'token only; demographics discarded', sourceRef: 'hl7.org/fhir/R4/explanationofbenefit.html' },
      { fact: 'eobServiceDate', source: 'item[0].servicedDate', transform: 'verbatim date', sourceRef: 'hl7.org/fhir/R4/explanationofbenefit-definitions.html' },
      { fact: 'allowedCents', source: 'item[0].adjudication[category=eligible].amount.value', transform: 'decimal → integer cents', sourceRef: 'hl7.org/fhir/R4/codesystem-adjudication.html' },
      { fact: 'appliedCents', source: 'item[0].adjudication[category=deductible].amount.value', transform: 'decimal → integer cents', sourceRef: 'hl7.org/fhir/R4/codesystem-adjudication.html' },
    ],
    notes: ['FHIR base EOB has no CAS group code, so adjustmentGroup is not mapped from FHIR.'],
  },
  {
    id: 'fhir-r4-coverage', version: 1, transactionKind: 'Coverage', sourceClass: 'structured',
    fields: [{ fact: 'coverageStatus', source: 'Coverage.status', transform: 'verbatim (not a rule fact)', sourceRef: 'hl7.org/fhir/R4/coverage.html' }],
    notes: ['Coverage.order "does not imply primary, secondary etc." (FHIR R4), so secondaryAtDos is never derived from Coverage.'],
  },
];

export function mapping(id: string): MappingDefinition & { sha256: string } {
  const m = MAPPINGS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown mapping ${id}`);
  return { ...m, sha256: sha256(canonicalJson(m)) };
}

export function mappingRef(id: string) {
  const m = mapping(id);
  return { id: m.id, version: m.version, sha256: m.sha256 };
}

// Pins every mapping version used by this build (idempotent; immutable rows).
export function ensureMappings(db: Db) {
  for (const m of MAPPINGS) {
    const body = canonicalJson(m);
    const existing = one<{ sha256: string }>(db, 'SELECT sha256 FROM field_mapping_versions WHERE mapping_id=? AND version=?', m.id, m.version);
    if (!existing) run(db, 'INSERT INTO field_mapping_versions VALUES (?,?,?,?,?,?)', m.id, m.version, m.transactionKind, body, sha256(body), nowIso());
    else if (existing.sha256 !== sha256(body)) throw new Error(`Mapping ${m.id} v${m.version} changed without a version bump`);
  }
}
