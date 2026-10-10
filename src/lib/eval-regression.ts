/**
 * Regression detection for eval accuracy benchmarks (lm_eval + BFCL).
 *
 * Compares the latest nightly eval results against a dynamic baseline
 * (latest release image).  When total === 0 (no metrics compared) the run
 * is skipped.  Coverage gaps (missingCandidate > 0) are normal and do not
 * suppress evidence — per-key resolution is handled by planEpisodes().
 */

import { loadEvalRows } from "@/lib/eval-data";
import { compareEvalRows, type DeltaItem } from "@/lib/compare";
import {
  resolveEvalBaseline,
  resolveLatestNightlyImageFromRows,
  type EvalBaseline,
} from "@/lib/eval-baseline";
import { describeImage } from "@/lib/commit-from-image";

import type { EvalRegressionSummary } from "./eval-alert-types";

export type RegressionStatus = "pass" | "regression" | "skipped";

export type RegressionSummary = EvalRegressionSummary;

export interface RegressionResult {
  status: RegressionStatus;
  baselineImage: string;
  baselineLabel: string;
  candidateImage: string;
  candidateLabel: string;
  evalSigma: number;
  checkedAt: string;
  summary: RegressionSummary;
  regressions: DeltaItem[];
  improvements: DeltaItem[];
  allDeltas: DeltaItem[];
  compareUrl: string;
}

/**
 * Pure classification over a list of deltas.  Exported for testing.
 *
 * Returns "skipped" only when `total === 0` (no metrics compared at all).
 * Coverage gaps (missingCandidate > 0) are normal — nightlies run a subset
 * of the baseline matrix — and are reported but do not suppress evidence.
 * The cron route resolves alerts only for keys actually compared (per-key
 * evidence), so uncovered keys stay open rather than falsely resolving.
 */
export function classifyDeltas(
  deltas: DeltaItem[],
  missingCandidate: number,
): { status: RegressionStatus; summary: RegressionSummary } {
  const regressions = deltas.filter((d) => d.status === "regression");
  const improvements = deltas.filter((d) => d.status === "improvement");
  const noisy = deltas.filter((d) => d.status === "noisy");
  const unchanged = deltas.filter((d) => d.status === "unchanged");

  const total = deltas.length;

  let status: RegressionStatus;
  if (total === 0) {
    status = "skipped";
  } else if (regressions.length > 0) {
    status = "regression";
  } else {
    status = "pass";
  }

  return {
    status,
    summary: {
      total,
      passed: unchanged.length + noisy.length + improvements.length,
      regressed: regressions.length,
      improved: improvements.length,
      noisy: noisy.length,
      unchanged: unchanged.length,
      missingBaseline: 0,
      missingCandidate,
    },
  };
}

function buildCompareUrl(
  dashboardUrl: string,
  baseline: string,
  candidate: string,
  evalSigma: number,
): string {
  const params = new URLSearchParams({
    baseline,
    candidate,
    eval_sigma: String(evalSigma),
  });
  return `${dashboardUrl}/compare?${params.toString()}`;
}

export interface RunRegressionCheckOpts {
  baselineImage?: string | null;
  candidateImage?: string | null;
  evalSigma?: number;
  dashboardUrl?: string;
}

/**
 * Run a full regression check.  Returns null only when baseline or
 * candidate image cannot be resolved at all.
 *
 * Uses a single loadEvalRows() call for baseline resolution, nightly
 * resolution, and comparison — avoiding redundant Databricks scans.
 */
export async function runRegressionCheck(
  opts: RunRegressionCheckOpts = {},
): Promise<RegressionResult | null> {
  const evalSigma = opts.evalSigma ?? 2;
  const dashboardUrl =
    opts.dashboardUrl ??
    process.env.DASHBOARD_BASE_URL ??
    "https://ci.vllm.ai";

  // Single Databricks load: all eval rows, unfiltered.
  const allRows = await loadEvalRows();

  // Resolve baseline from the loaded rows.
  const baseline: EvalBaseline | null = await resolveEvalBaseline(
    opts.baselineImage,
    allRows,
  );
  if (!baseline) return null;

  // Resolve candidate from the loaded rows.
  const candidateImage =
    opts.candidateImage || resolveLatestNightlyImageFromRows(allRows);
  if (!candidateImage) return null;
  if (candidateImage === baseline.baselineImage) return null;

  // Filter to the two images for comparison (in memory, no extra scan).
  const imageSet = new Set([baseline.baselineImage, candidateImage]);
  const evalRows = allRows.filter(
    (r) => r.image !== null && imageSet.has(r.image),
  );

  const evalResult = compareEvalRows(
    evalRows,
    baseline.baselineImage,
    candidateImage,
    evalSigma,
  );

  const { status, summary } = classifyDeltas(
    evalResult.deltas,
    evalResult.missingCandidate.length,
  );
  summary.missingBaseline = evalResult.missingBaseline.length;

  const regressions = evalResult.deltas
    .filter((d) => d.status === "regression")
    .sort((a, b) => b.severity - a.severity);
  const improvements = evalResult.deltas
    .filter((d) => d.status === "improvement")
    .sort((a, b) => b.severity - a.severity);

  return {
    status,
    baselineImage: baseline.baselineImage,
    baselineLabel: describeImage(baseline.baselineImage),
    candidateImage,
    candidateLabel: describeImage(candidateImage),
    evalSigma,
    checkedAt: new Date().toISOString(),
    summary,
    regressions,
    improvements,
    allDeltas: evalResult.deltas,
    compareUrl: buildCompareUrl(
      dashboardUrl,
      baseline.baselineImage,
      candidateImage,
      evalSigma,
    ),
  };
}
