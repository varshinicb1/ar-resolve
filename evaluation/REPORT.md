# Evaluation report: scenario packs (synthetic)

Generated 2026-10-12T21:58:54.009Z by `npm run eval`.

**Scope.** Mechanics validation of the deterministic scenario packs and scenario selection on synthetic fixtures. Labels are synthetic proposals (`synthetic_proposed_not_customer_approved`); DED01 uses the build pack's fixtures unchanged. This is not payer-policy validation, not shadow-mode accuracy and not a basis for any accuracy claim (docs/09).

| Item | Value |
| --- | --- |
| DED01 | DED01 v1 (draft), definition sha256 `173dec8123e28fcc…`, fixtures 40/40 |
| All pack fixtures | 141/141 across 10 packs |
| Selection map | SCENARIO_MAP v1 (draft), sha256 `50f6c23f1cc3b7b9…`, fixtures 17/17 |
| End-to-end cohort | 35/35 (clock 2026-10-12T12:00:00.000Z) |
| Engine | `shared/rules/registry.ts` modules (same code in API, worker and browser) |

## Packs

| Pack | Kind | Logic | Fixtures | Critical cases agree | Abstentions | Categories |
| --- | --- | --- | --- | --- | --- | --- |
| DED01 Deductible allocation review | executable | `ded01.v1` | 40/40 | 2/2 | 28/40 | positive |
| PEND01 Claim pending / status follow-up | executable | `pend01.v1` | 21/21 | 5/5 | 11/21 | positive, negative, ambiguous, adversarial |
| DOC01 Missing documentation | executable | `doc01.v1` | 18/18 | 6/6 | 13/18 | positive, negative, ambiguous, adversarial |
| DUP01 Duplicate clarification | executable | `dup01.v1` | 17/17 | 4/4 | 9/17 | positive, negative, ambiguous, adversarial |
| COB01 Coordination of benefits (specialist route) | specialist route | `cob01.v1` | 9/9 | 2/2 | 6/9 | positive, negative, ambiguous, adversarial |
| TF01 Timely filing (specialist route) | specialist route | `tf01.v1` | 8/8 | 4/4 | 6/8 | positive, negative, ambiguous, adversarial |
| AUTH01 Authorization absent (specialist route) | specialist route | `auth01.v1` | 8/8 | 2/2 | 6/8 | positive, negative, ambiguous, adversarial |
| MN01 Medical necessity (specialist route) | specialist route | `mn01.v1` | 7/7 | 2/2 | 5/7 | positive, negative, ambiguous, adversarial |
| BUN01 Bundled service (specialist route) | specialist route | `bun01.v1` | 7/7 | 2/2 | 5/7 | positive, negative, ambiguous, adversarial |
| ROUTE00 Scenario not determined | router | `route00.v1` | 6/6 | 2/2 | 6/6 | negative, ambiguous, adversarial |

## End-to-end cohort (import → evidence → facts → selection → rule)

| Client | Account | Selected scenario | Rule run | Expected first outcome | Actual | Result |
| --- | --- | --- | --- | --- | --- | --- |
| cl_ortho | SYN-1041 | DED01 (selected) | DED01 v1 | verify_crossover | verify_crossover | match |
| cl_ortho | SYN-1042 | DED01 (selected) | DED01 v1 | clarify_allocation | clarify_allocation | match |
| cl_ortho | SYN-1043 | DED01 (selected) | DED01 v1 | patient_responsibility_review | patient_responsibility_review | match |
| cl_ortho | SYN-1044 | DED01 (selected) | DED01 v1 | collect_evidence | collect_evidence | match |
| cl_ortho | SYN-1045 | DED01 (selected) | DED01 v1 | collect_evidence | collect_evidence | match |
| cl_ortho | SYN-1046 | DED01 (selected) | DED01 v1 | patient_responsibility_review | patient_responsibility_review | match |
| cl_ortho | SYN-1047 | DED01 (selected) | DED01 v1 | specialist_review | specialist_review | match |
| cl_ortho | SYN-1048 | DED01 (selected) | DED01 v1 | collect_evidence | collect_evidence | match |
| cl_ortho | SYN-1049 | DED01 (selected) | DED01 v1 | monitor_secondary | monitor_secondary | match |
| cl_ortho | SYN-1050 | DED01 (selected) | DED01 v1 | specialist_review | specialist_review | match |
| cl_derm | SYN-2001 | DED01 (selected) | DED01 v1 | clarify_allocation | clarify_allocation | match |
| cl_derm | SYN-2002 | DED01 (selected) | DED01 v1 | secondary_review | secondary_review | match |
| cl_multi | SYN-3101 | PEND01 (selected) | PEND01 v1 | request_status_update | request_status_update | match |
| cl_multi | SYN-3102 | PEND01 (selected) | PEND01 v1 | route_info_request | route_info_request | match |
| cl_multi | SYN-3103 | PEND01 (selected) | PEND01 v1 | request_status_update | request_status_update | match |
| cl_multi | SYN-3104 | PEND01 (selected) | PEND01 v1 | specialist_review | specialist_review | match |
| cl_multi | SYN-3105 | PEND01 (selected) | PEND01 v1 | collect_evidence | collect_evidence | match |
| cl_multi | SYN-3106 | PEND01 (selected) | PEND01 v1 | collect_evidence | collect_evidence | match |
| cl_multi | SYN-3201 | DOC01 (selected) | DOC01 v1 | submit_documents | submit_documents | match |
| cl_multi | SYN-3202 | DOC01 (selected) | DOC01 v1 | clarify_document_request | clarify_document_request | match |
| cl_multi | SYN-3203 | DOC01 (selected) | DOC01 v1 | specialist_review | specialist_review | match |
| cl_multi | SYN-3204 | DOC01 (selected) | DOC01 v1 | verify_document_receipt | verify_document_receipt | match |
| cl_multi | SYN-3205 | DOC01 (selected) | DOC01 v1 | specialist_review | specialist_review | match |
| cl_multi | SYN-3301 | DUP01 (selected) | DUP01 v1 | review_existing_disposition | review_existing_disposition | match |
| cl_multi | SYN-3302 | DUP01 (selected) | DUP01 v1 | request_duplicate_review | request_duplicate_review | match |
| cl_multi | SYN-3303 | DUP01 (selected) | DUP01 v1 | clarify_duplicate | clarify_duplicate | match |
| cl_multi | SYN-3304 | — (ambiguous) | ROUTE00 v1 | specialist_review | specialist_review | match |
| cl_multi | SYN-3305 | DUP01 (selected) | DUP01 v1 | clarify_duplicate | clarify_duplicate | match |
| cl_multi | SYN-3401 | COB01 (selected) | COB01 v1 | cob_specialist_task | cob_specialist_task | match |
| cl_multi | SYN-3402 | TF01 (selected) | TF01 v1 | collect_evidence | collect_evidence | match |
| cl_multi | SYN-3403 | AUTH01 (selected) | AUTH01 v1 | auth_verification_task | auth_verification_task | match |
| cl_multi | SYN-3404 | MN01 (selected) | MN01 v1 | collect_evidence | collect_evidence | match |
| cl_multi | SYN-3405 | BUN01 (selected) | BUN01 v1 | coding_review_task | coding_review_task | match |
| cl_multi | SYN-3501 | — (unknown) | ROUTE00 v1 | specialist_review | specialist_review | match |
| cl_multi | SYN-3502 | — (no_evidence) | ROUTE00 v1 | collect_evidence | collect_evidence | match |

## Selection fixtures (FR05)

| Case | Name | Category | Expected | Actual |
| --- | --- | --- | --- | --- |
| SEL-001 | Deductible CARC | positive | selected DED01 | selected DED01 |
| SEL-002 | Contractual CARC ignored next to deductible | positive | selected DED01 | selected DED01 |
| SEL-003 | Duplicate CARC | positive | selected DUP01 | selected DUP01 |
| SEL-004 | Deductible and duplicate on one claim | ambiguous | ambiguous  | ambiguous  |
| SEL-005 | Only an unmapped CARC | negative | unknown  | unknown  |
| SEL-006 | Pending status, no adjudication | positive | selected PEND01 | selected PEND01 |
| SEL-007 | No evidence, deductible inventory hint | positive | selected DED01 | selected DED01 |
| SEL-008 | No evidence, no hint | negative | no_evidence  | no_evidence  |
| SEL-009 | Adjustment sources conflict | ambiguous | conflict  | conflict  |
| SEL-010 | Reported (unverified) adjustments are not used | adversarial | no_evidence  | no_evidence  |
| SEL-011 | Two documentation codes, one scenario | positive | selected DOC01 | selected DOC01 |
| SEL-012 | Unmapped claim status | negative | unknown  | unknown  |
| SEL-013 | Adjudication takes precedence over status | ambiguous | selected TF01 | selected TF01 |
| SEL-014 | Evidence overrides a differing inventory hint | ambiguous | selected DED01 | selected DED01 |
| SEL-015 | CARC value carrying an instruction | adversarial | unknown  | unknown  |
| SEL-016 | Different lines map to different scenarios | ambiguous | ambiguous  | ambiguous  |
| SEL-017 | Remark code only (no RARC rows in v1) | negative | unknown  | unknown  |

## Fixture detail

### DED01

| Case | Name | Category | Severity | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
| DED-001 | Consistent allocation active secondary | positive | normal | secondary_review | secondary_review |
| DED-002 | Deductible previously met | positive | normal | clarify_allocation | clarify_allocation |
| DED-003 | Partial remaining deductible | positive | normal | secondary_review | secondary_review |
| DED-004 | No secondary | positive | normal | patient_responsibility_review | patient_responsibility_review |
| DED-005 | Unknown secondary | positive | normal | collect_evidence | collect_evidence |
| DED-006 | Crossover unknown | positive | normal | verify_crossover | verify_crossover |
| DED-007 | Already crossed | positive | normal | monitor_secondary | monitor_secondary |
| DED-008 | Posting unverified | positive | normal | collect_evidence | collect_evidence |
| DED-009 | Identity mismatch | positive | critical | collect_evidence | collect_evidence |
| DED-010 | Unsupported accumulator plan | positive | normal | specialist_review | specialist_review |
| DED-011 | Contradictory source | positive | normal | specialist_review | specialist_review |
| DED-012 | EOB absent | positive | normal | collect_evidence | collect_evidence |
| DED-013 | No claim reference | positive | normal | collect_evidence | collect_evidence |
| DED-014 | Unexpected contractual adjustment group | positive | normal | specialist_review | specialist_review |
| DED-015 | allowedCents missing | positive | normal | collect_evidence | collect_evidence |
| DED-016 | allowedCents negative unsupported reversal | positive | normal | specialist_review | specialist_review |
| DED-017 | allowedCents malformed | positive | normal | specialist_review | specialist_review |
| DED-018 | allowedCents fractional cents | positive | normal | specialist_review | specialist_review |
| DED-019 | limitCents missing | positive | normal | collect_evidence | collect_evidence |
| DED-020 | limitCents negative unsupported reversal | positive | normal | specialist_review | specialist_review |
| DED-021 | limitCents malformed | positive | normal | specialist_review | specialist_review |
| DED-022 | limitCents fractional cents | positive | normal | specialist_review | specialist_review |
| DED-023 | metBeforeCents missing | positive | normal | collect_evidence | collect_evidence |
| DED-024 | metBeforeCents negative unsupported reversal | positive | normal | specialist_review | specialist_review |
| DED-025 | metBeforeCents malformed | positive | normal | specialist_review | specialist_review |
| DED-026 | metBeforeCents fractional cents | positive | normal | specialist_review | specialist_review |
| DED-027 | appliedCents missing | positive | normal | collect_evidence | collect_evidence |
| DED-028 | appliedCents negative unsupported reversal | positive | normal | specialist_review | specialist_review |
| DED-029 | appliedCents malformed | positive | normal | specialist_review | specialist_review |
| DED-030 | appliedCents fractional cents | positive | normal | specialist_review | specialist_review |
| DED-031 | Zero allowed and zero deductible | positive | normal | secondary_review | secondary_review |
| DED-032 | Zero deductible limit with applied amount | positive | normal | clarify_allocation | clarify_allocation |
| DED-033 | Accumulator exceeds limit no new deductible | positive | normal | secondary_review | secondary_review |
| DED-034 | Applied exceeds allowed | positive | normal | clarify_allocation | clarify_allocation |
| DED-035 | One cent discrepancy | positive | normal | clarify_allocation | clarify_allocation |
| DED-036 | None secondary with unknown crossover | positive | normal | patient_responsibility_review | patient_responsibility_review |
| DED-037 | Unknown secondary cannot bill patient | positive | critical | collect_evidence | collect_evidence |
| DED-038 | Blank allocation does not become zero | positive | normal | collect_evidence | collect_evidence |
| DED-039 | Zero remaining allocation missing context | positive | normal | collect_evidence | collect_evidence |
| DED-040 | Boolean amount is invalid | positive | normal | specialist_review | specialist_review |

### PEND01

| Case | Name | Category | Severity | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
| PEND-001 | Pending, fresh status, no payer commitment | positive | normal | request_status_update | request_status_update |
| PEND-002 | Pending with future payer commitment | positive | normal | schedule_followup | schedule_followup |
| PEND-003 | Payer requested identified information | positive | normal | route_info_request | route_info_request |
| PEND-004 | Payer requested information, request unknown | negative | normal | clarify_pending_request | clarify_pending_request |
| PEND-005 | Status one day past threshold | ambiguous | normal | request_status_update | request_status_update |
| PEND-006 | Status exactly at threshold is fresh | ambiguous | normal | request_status_update | request_status_update |
| PEND-007 | Very old status response | negative | normal | request_status_update | request_status_update |
| PEND-008 | Finalized without EOB on file | negative | normal | collect_evidence | collect_evidence |
| PEND-009 | Claim not on file: no blind resubmission | negative | critical | specialist_review | specialist_review |
| PEND-010 | Identity mismatch | negative | critical | collect_evidence | collect_evidence |
| PEND-011 | Sources disagree | ambiguous | normal | specialist_review | specialist_review |
| PEND-012 | No status response yet | negative | normal | collect_evidence | collect_evidence |
| PEND-013 | Identity unknown | negative | normal | collect_evidence | collect_evidence |
| PEND-014 | Unrecognized payer status | ambiguous | normal | specialist_review | specialist_review |
| PEND-015 | Payer commitment already passed | negative | normal | request_status_update | request_status_update |
| PEND-016 | Commitment text carries an instruction | adversarial | critical | specialist_review | specialist_review |
| PEND-017 | Requested-information text carries an instruction | adversarial | critical | route_info_request | route_info_request |
| PEND-018 | Status date in the future | adversarial | normal | specialist_review | specialist_review |
| PEND-019 | Payer receipt not confirmed | negative | normal | request_status_update | request_status_update |
| PEND-020 | Status with wrong type | adversarial | normal | specialist_review | specialist_review |
| PEND-021 | Identity as a string is not verification | adversarial | critical | collect_evidence | collect_evidence |

### DOC01

| Case | Name | Category | Severity | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
| DOC-001 | Verified manifest, release authorized, nothing sent yet | positive | normal | submit_documents | submit_documents |
| DOC-002 | Exact request unknown | negative | normal | clarify_document_request | clarify_document_request |
| DOC-003 | Prior submission receipt on file | positive | critical | verify_document_receipt | verify_document_receipt |
| DOC-004 | Prior submission unknown | ambiguous | normal | collect_evidence | collect_evidence |
| DOC-005 | Prior submission not recorded | negative | normal | collect_evidence | collect_evidence |
| DOC-006 | Destination not verified | negative | normal | collect_evidence | collect_evidence |
| DOC-007 | Nothing staged yet | positive | normal | assemble_documents | assemble_documents |
| DOC-008 | Staged document belongs to another patient | adversarial | critical | specialist_review | specialist_review |
| DOC-009 | Manifest missing the patient token | ambiguous | normal | collect_evidence | collect_evidence |
| DOC-010 | Staged document type differs from request | negative | normal | specialist_review | specialist_review |
| DOC-011 | Release not authorized | negative | critical | specialist_review | specialist_review |
| DOC-012 | Release authorization not on file | negative | normal | collect_evidence | collect_evidence |
| DOC-013 | Identity mismatch | negative | critical | collect_evidence | collect_evidence |
| DOC-014 | Sources disagree | ambiguous | normal | specialist_review | specialist_review |
| DOC-015 | Request text tries to widen the release | adversarial | critical | specialist_review | specialist_review |
| DOC-016 | Unrecognized prior-submission value | adversarial | normal | specialist_review | specialist_review |
| DOC-017 | Release flag as text is not authorization | adversarial | critical | collect_evidence | collect_evidence |
| DOC-018 | Request with wrong type | ambiguous | normal | clarify_document_request | clarify_document_request |

### DUP01

| Case | Name | Category | Severity | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
| DUP-001 | Exact duplicate of a paid original | positive | normal | review_existing_disposition | review_existing_disposition |
| DUP-002 | Exact duplicate of a denied original | positive | normal | review_existing_disposition | review_existing_disposition |
| DUP-003 | Exact duplicate of a pending original | positive | normal | review_existing_disposition | review_existing_disposition |
| DUP-004 | Replacement with changed lines denied as duplicate | positive | normal | request_duplicate_review | request_duplicate_review |
| DUP-005 | Replacement identical to original | negative | critical | specialist_review | specialist_review |
| DUP-006 | Original frequency, services differ | ambiguous | normal | clarify_duplicate | clarify_duplicate |
| DUP-007 | Original claim not identified | negative | normal | clarify_duplicate | clarify_duplicate |
| DUP-008 | Original disposition unknown | negative | normal | clarify_duplicate | clarify_duplicate |
| DUP-009 | Payer cannot find original | ambiguous | normal | clarify_duplicate | clarify_duplicate |
| DUP-010 | Frequency not recorded | negative | normal | collect_evidence | collect_evidence |
| DUP-011 | Void claim | negative | normal | specialist_review | specialist_review |
| DUP-012 | Frequency text asks for resubmission | adversarial | critical | specialist_review | specialist_review |
| DUP-013 | Original reference equals this claim | adversarial | normal | specialist_review | specialist_review |
| DUP-014 | Line comparison as text | adversarial | normal | collect_evidence | collect_evidence |
| DUP-015 | Identity mismatch | negative | critical | collect_evidence | collect_evidence |
| DUP-016 | Sources disagree | ambiguous | normal | specialist_review | specialist_review |
| DUP-017 | Disposition text carries an instruction | adversarial | critical | specialist_review | specialist_review |

### COB01

| Case | Name | Category | Severity | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
| COB-001 | Checklist complete routes to specialist | positive | normal | cob_specialist_task | cob_specialist_task |
| COB-002 | Identity mismatch | negative | critical | collect_evidence | collect_evidence |
| COB-003 | Sources disagree | ambiguous | normal | specialist_review | specialist_review |
| COB-004 | Identity unknown | negative | normal | collect_evidence | collect_evidence |
| COB-005 | Prior payer adjudication missing | negative | normal | collect_evidence | collect_evidence |
| COB-006 | No other coverage: prior payer not needed | positive | normal | cob_specialist_task | cob_specialist_task |
| COB-007 | Coverage at DOS unknown | ambiguous | normal | collect_evidence | collect_evidence |
| COB-008 | Order source text asks to switch payer order | adversarial | critical | cob_specialist_task | cob_specialist_task |
| COB-009 | Coverage value unrecognized | adversarial | normal | collect_evidence | collect_evidence |

### TF01

| Case | Name | Category | Severity | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
| TF-001 | Checklist complete routes to specialist | positive | normal | timely_filing_review_task | timely_filing_review_task |
| TF-002 | Identity mismatch | negative | critical | collect_evidence | collect_evidence |
| TF-003 | Sources disagree | ambiguous | normal | specialist_review | specialist_review |
| TF-004 | Identity unknown | negative | normal | collect_evidence | collect_evidence |
| TF-005 | Filing rule not supplied | negative | critical | collect_evidence | collect_evidence |
| TF-006 | No submission receipt | negative | normal | collect_evidence | collect_evidence |
| TF-007 | Trigger date as text | adversarial | critical | collect_evidence | collect_evidence |
| TF-008 | Dates that look expired still route to a specialist | ambiguous | critical | timely_filing_review_task | timely_filing_review_task |

### AUTH01

| Case | Name | Category | Severity | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
| AUTH-001 | Checklist complete routes to specialist | positive | normal | auth_verification_task | auth_verification_task |
| AUTH-002 | Identity mismatch | negative | critical | collect_evidence | collect_evidence |
| AUTH-003 | Sources disagree | ambiguous | normal | specialist_review | specialist_review |
| AUTH-004 | Identity unknown | negative | normal | collect_evidence | collect_evidence |
| AUTH-005 | Authorization not required for the service | positive | normal | auth_verification_task | auth_verification_task |
| AUTH-006 | Authorization number missing | negative | normal | collect_evidence | collect_evidence |
| AUTH-007 | Requirement unknown | ambiguous | normal | collect_evidence | collect_evidence |
| AUTH-008 | Authorization number text asks for retro-auth guarantee | adversarial | critical | collect_evidence | collect_evidence |

### MN01

| Case | Name | Category | Severity | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
| MN-001 | Checklist complete routes to specialist | positive | normal | clinical_review_task | clinical_review_task |
| MN-002 | Identity mismatch | negative | critical | collect_evidence | collect_evidence |
| MN-003 | Sources disagree | ambiguous | normal | specialist_review | specialist_review |
| MN-004 | Identity unknown | negative | normal | collect_evidence | collect_evidence |
| MN-005 | Clinical records missing | negative | normal | collect_evidence | collect_evidence |
| MN-006 | Policy version unknown | ambiguous | normal | collect_evidence | collect_evidence |
| MN-007 | Policy text asks the system to write a rationale | adversarial | critical | clinical_review_task | clinical_review_task |

### BUN01

| Case | Name | Category | Severity | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
| BUN-001 | Checklist complete routes to specialist | positive | normal | coding_review_task | coding_review_task |
| BUN-002 | Identity mismatch | negative | critical | collect_evidence | collect_evidence |
| BUN-003 | Sources disagree | ambiguous | normal | specialist_review | specialist_review |
| BUN-004 | Identity unknown | negative | normal | collect_evidence | collect_evidence |
| BUN-005 | Modifiers present as billed | positive | normal | coding_review_task | coding_review_task |
| BUN-006 | Payer edit not cited | negative | normal | collect_evidence | collect_evidence |
| BUN-007 | Modifier instruction instead of a list | adversarial | critical | collect_evidence | collect_evidence |

### ROUTE00

| Case | Name | Category | Severity | Expected | Actual |
| --- | --- | --- | --- | --- | --- |
| ROUTE-001 | No adjudication or status evidence | negative | normal | collect_evidence | collect_evidence |
| ROUTE-002 | Codes map to two scenarios | ambiguous | critical | specialist_review | specialist_review |
| ROUTE-003 | No mapped code | negative | normal | specialist_review | specialist_review |
| ROUTE-004 | Signals conflict | ambiguous | normal | specialist_review | specialist_review |
| ROUTE-005 | Selected pack retired | negative | normal | specialist_review | specialist_review |
| ROUTE-006 | Router never proposes an action even if told a scenario | adversarial | critical | specialist_review | specialist_review |

## Not established

Extraction accuracy, correct-action accuracy on real accounts, reviewer burden, payer coverage, the correctness of the CARC-to-pack routing for any real client, and any financial outcome. These require Gate B (shadow mode on authorized, expert-labeled data) and customer sign-off of each pack.
