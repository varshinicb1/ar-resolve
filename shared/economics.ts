// Capacity and unit-economics calculator. A line-for-line port of the build pack's
// evaluation/calculate.py (doc 14). Every input is an editable ASSUMPTION copied
// from evaluation/economics-assumptions.json; none is a vendor quote, a measured
// cost or a result. Shared by the API and the browser.

export interface EconomicsAssumptions {
  monthly_accounts: number; attempts_per_account: number; occupied_minutes_per_attempt: number; active_minutes_per_attempt: number;
  telecom_cost_per_occupied_minute: number; speech_cost_per_active_minute: number; model_cost_per_attempt: number; status_cost_per_account: number;
  review_share: number; review_minutes: number; reviewer_hourly_cost: number; infra_cost_per_account: number; support_cost_per_account: number;
  resolution_rate: number; price_per_resolution: number; target_contribution_margin: number; call_attempt_target: number; shift_hours: number; utilization: number;
}

export interface EconomicsResult {
  direct_cost_per_account: number; revenue_per_account: number; contribution_per_account: number; contribution_margin: number;
  price_floor_per_resolution: number; monthly_contribution: number; required_concurrent_lines: number;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function calculate(a: EconomicsAssumptions): EconomicsResult {
  const perAttempt = a.occupied_minutes_per_attempt * a.telecom_cost_per_occupied_minute + a.active_minutes_per_attempt * a.speech_cost_per_active_minute + a.model_cost_per_attempt;
  const cost = a.attempts_per_account * perAttempt + a.status_cost_per_account + a.review_share * a.review_minutes / 60 * a.reviewer_hourly_cost
    + a.infra_cost_per_account + a.support_cost_per_account;
  const revenue = a.resolution_rate * a.price_per_resolution;
  return {
    direct_cost_per_account: r4(cost),
    revenue_per_account: r4(revenue),
    contribution_per_account: r4(revenue - cost),
    contribution_margin: revenue ? r4((revenue - cost) / revenue) : 0,
    price_floor_per_resolution: r4(cost / (a.resolution_rate * (1 - a.target_contribution_margin))),
    monthly_contribution: r2((revenue - cost) * a.monthly_accounts),
    required_concurrent_lines: Math.ceil(a.call_attempt_target * a.occupied_minutes_per_attempt / (a.shift_hours * 60 * a.utilization)),
  };
}

// The same three cases calculate.py writes to economics-results.csv.
export function variants(base: EconomicsAssumptions): Record<string, EconomicsAssumptions> {
  return {
    base,
    stress: { ...base, review_share: 0.5, review_minutes: 8, occupied_minutes_per_attempt: 25, resolution_rate: 0.55 },
    high_quality_low_review: { ...base, review_share: 0.1, review_minutes: 3, resolution_rate: 0.8 },
  };
}

export const ASSUMPTION_LABELS: Record<keyof EconomicsAssumptions, string> = {
  monthly_accounts: 'Accounts per month', attempts_per_account: 'Call attempts per account', occupied_minutes_per_attempt: 'Occupied minutes per attempt (IVR, hold, talk)',
  active_minutes_per_attempt: 'Billed speech/model-active minutes per attempt', telecom_cost_per_occupied_minute: 'Telecom $ per occupied minute',
  speech_cost_per_active_minute: 'Speech $ per active minute', model_cost_per_attempt: 'Model $ per attempt', status_cost_per_account: 'Status/portal $ per account',
  review_share: 'Share of accounts needing human review', review_minutes: 'Review minutes per reviewed account', reviewer_hourly_cost: 'Reviewer $ per hour',
  infra_cost_per_account: 'Infrastructure/security $ per account', support_cost_per_account: 'Delivery support $ per account', resolution_rate: 'Verified resolution rate',
  price_per_resolution: 'Price per verified resolution ($)', target_contribution_margin: 'Target contribution margin', call_attempt_target: 'Call attempts per shift (capacity)',
  shift_hours: 'Shift hours', utilization: 'Effective line utilization',
};

export const ECONOMICS_DISCLAIMER = 'Illustrative assumptions from the build pack (doc 14). Not vendor rate quotes, measured costs or results. Contribution excludes acquisition, development, fixed compliance, implementation and overhead; it is not net profit or gross margin.';
