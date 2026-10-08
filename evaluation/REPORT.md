# Evaluation report: DED01 draft v1 (synthetic)

Generated 2026-10-08T16:39:39.978Z by `npm run eval`.

**Scope.** Mechanics validation of the deterministic rule engine on synthetic fixtures. Labels are the build pack's synthetic proposals (`synthetic_proposed_not_customer_approved`). This is not payer-policy validation, not shadow-mode accuracy and not a basis for any accuracy claim (docs/09).

| Item | Value |
| --- | --- |
| Rule | DED01 v1 (draft), definition sha256 `173dec8123e28fcc…` |
| Engine | `shared/rules/ded01.ts` (same module in API, worker and browser) |
| Fixture set | evaluation/deductible-fixtures.json, 40 cases |
| Fixture agreement | 40/40 |
| Critical-severity cases | 2, all agree |
| Abstentions (collect_evidence or specialist_review) | 28/40 |

## End-to-end cohort (import → evidence → facts → rule)

| Account | Expected first outcome | Actual | Result |
| --- | --- | --- | --- |
| SYN-1041 | verify_crossover | verify_crossover | match |
| SYN-1042 | clarify_allocation | clarify_allocation | match |
| SYN-1043 | patient_responsibility_review | patient_responsibility_review | match |
| SYN-1044 | collect_evidence | collect_evidence | match |
| SYN-1045 | collect_evidence | collect_evidence | match |
| SYN-1046 | patient_responsibility_review | patient_responsibility_review | match |
| SYN-1047 | specialist_review | specialist_review | match |
| SYN-1048 | collect_evidence | collect_evidence | match |
| SYN-1049 | monitor_secondary | monitor_secondary | match |
| SYN-1050 | specialist_review | specialist_review | match |
| SYN-2001 | clarify_allocation | clarify_allocation | match |
| SYN-2002 | secondary_review | secondary_review | match |

## Fixture detail

| Case | Name | Severity | Expected | Actual |
| --- | --- | --- | --- | --- |
| DED-001 | Consistent allocation active secondary | normal | secondary_review | secondary_review |
| DED-002 | Deductible previously met | normal | clarify_allocation | clarify_allocation |
| DED-003 | Partial remaining deductible | normal | secondary_review | secondary_review |
| DED-004 | No secondary | normal | patient_responsibility_review | patient_responsibility_review |
| DED-005 | Unknown secondary | normal | collect_evidence | collect_evidence |
| DED-006 | Crossover unknown | normal | verify_crossover | verify_crossover |
| DED-007 | Already crossed | normal | monitor_secondary | monitor_secondary |
| DED-008 | Posting unverified | normal | collect_evidence | collect_evidence |
| DED-009 | Identity mismatch | critical | collect_evidence | collect_evidence |
| DED-010 | Unsupported accumulator plan | normal | specialist_review | specialist_review |
| DED-011 | Contradictory source | normal | specialist_review | specialist_review |
| DED-012 | EOB absent | normal | collect_evidence | collect_evidence |
| DED-013 | No claim reference | normal | collect_evidence | collect_evidence |
| DED-014 | Unexpected contractual adjustment group | normal | specialist_review | specialist_review |
| DED-015 | allowedCents missing | normal | collect_evidence | collect_evidence |
| DED-016 | allowedCents negative unsupported reversal | normal | specialist_review | specialist_review |
| DED-017 | allowedCents malformed | normal | specialist_review | specialist_review |
| DED-018 | allowedCents fractional cents | normal | specialist_review | specialist_review |
| DED-019 | limitCents missing | normal | collect_evidence | collect_evidence |
| DED-020 | limitCents negative unsupported reversal | normal | specialist_review | specialist_review |
| DED-021 | limitCents malformed | normal | specialist_review | specialist_review |
| DED-022 | limitCents fractional cents | normal | specialist_review | specialist_review |
| DED-023 | metBeforeCents missing | normal | collect_evidence | collect_evidence |
| DED-024 | metBeforeCents negative unsupported reversal | normal | specialist_review | specialist_review |
| DED-025 | metBeforeCents malformed | normal | specialist_review | specialist_review |
| DED-026 | metBeforeCents fractional cents | normal | specialist_review | specialist_review |
| DED-027 | appliedCents missing | normal | collect_evidence | collect_evidence |
| DED-028 | appliedCents negative unsupported reversal | normal | specialist_review | specialist_review |
| DED-029 | appliedCents malformed | normal | specialist_review | specialist_review |
| DED-030 | appliedCents fractional cents | normal | specialist_review | specialist_review |
| DED-031 | Zero allowed and zero deductible | normal | secondary_review | secondary_review |
| DED-032 | Zero deductible limit with applied amount | normal | clarify_allocation | clarify_allocation |
| DED-033 | Accumulator exceeds limit no new deductible | normal | secondary_review | secondary_review |
| DED-034 | Applied exceeds allowed | normal | clarify_allocation | clarify_allocation |
| DED-035 | One cent discrepancy | normal | clarify_allocation | clarify_allocation |
| DED-036 | None secondary with unknown crossover | normal | patient_responsibility_review | patient_responsibility_review |
| DED-037 | Unknown secondary cannot bill patient | critical | collect_evidence | collect_evidence |
| DED-038 | Blank allocation does not become zero | normal | collect_evidence | collect_evidence |
| DED-039 | Zero remaining allocation missing context | normal | collect_evidence | collect_evidence |
| DED-040 | Boolean amount is invalid | normal | specialist_review | specialist_review |

## Not established

Extraction accuracy, correct-action accuracy on real accounts, reviewer burden, payer coverage and any financial outcome. These require Gate B (shadow mode on authorized, expert-labeled data).
