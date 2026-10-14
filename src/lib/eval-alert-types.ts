/** Shared types for eval regression alerts, used by the API route and UI. */

export interface EvalRegressionAlert {
  alert_id: number;
  model: string;
  task: string;
  n_shot: number;
  metric: string;
  filter: string;
  higher_is_better: boolean;
  unit: string;
  status: "open" | "resolved";
  baseline_image: string;
  baseline_value: number;
  candidate_image: string;
  candidate_value: number;
  delta: number;
  delta_pct: number | null;
  significance: number | null;
  opened_at: string;
  resolved_at: string | null;
}

export interface EvalRegressionSummary {
  total: number;
  passed: number;
  regressed: number;
  improved: number;
  noisy: number;
  unchanged: number;
  missingBaseline: number;
  missingCandidate: number;
  error?: string;
}

export const EMPTY_SUMMARY: EvalRegressionSummary = {
  total: 0,
  passed: 0,
  regressed: 0,
  improved: 0,
  noisy: 0,
  unchanged: 0,
  missingBaseline: 0,
  missingCandidate: 0,
};

export interface EvalRegressionSnapshot {
  snapshot_id: number;
  baseline_image: string;
  candidate_image: string;
  status: "pass" | "regression" | "skipped" | "error";
  summary: EvalRegressionSummary;
  compare_url: string | null;
  checked_at: string;
}
