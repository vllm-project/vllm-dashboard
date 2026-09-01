/** Presentation mapping for exact Main CI job alert episodes. */

export type MainCiAlertStatus = "open" | "resolved";

export type MainCiAnalysisClassification =
  | "infra"
  | "flaky"
  | "code"
  | "test"
  | "unknown";

export type MainCiAnalysisConfidence = "high" | "medium" | "low";

export interface MainCiSuspectedFixPr {
  number: number | null;
  url: string;
  title: string;
}

/** One worker-written diagnosis, keyed to the failure it was computed from. */
export interface MainCiJobAnalysis {
  analyzedFailureJobId: string;
  classification: MainCiAnalysisClassification;
  confidence: MainCiAnalysisConfidence;
  summary: string;
  evidenceUrls: string[];
  recommendedAction: string;
  suspectedFixPrs: MainCiSuspectedFixPr[];
  modelVersion: string;
  analyzedAt: string;
  /** True when the alert's latest failure is newer than the analyzed one. */
  stale: boolean;
}

export interface MainCiOutcomeRef {
  buildkiteJobId: string;
  state: string;
  finishedAt: string;
  buildkiteBuildId: string;
  buildNumber: number;
  buildUrl: string;
  jobUrl: string;
  commitSha: string;
}

export interface MainCiJobAlert {
  alertId: string;
  jobKey: string;
  jobName: string;
  status: MainCiAlertStatus;
  openedAt: string;
  firstFailure: MainCiOutcomeRef;
  lastFailure: MainCiOutcomeRef;
  failureCount: number;
  resolvedAt: string | null;
  resolution: MainCiOutcomeRef | null;
  analysis: MainCiJobAnalysis | null;
}

export interface MainCiJobAlertRow {
  alert_id: string | number;
  job_key: string;
  job_name: string;
  status: MainCiAlertStatus;
  opened_at: Date;
  first_failure_job_id: string;
  first_failure_state: string;
  first_failure_build_id: string;
  first_failure_build_number: number | string;
  first_failure_build_url: string;
  first_failure_job_url: string;
  first_failure_commit_sha: string;
  last_failed_at: Date;
  last_failure_job_id: string;
  last_failure_state: string;
  last_failure_build_id: string;
  last_failure_build_number: number | string;
  last_failure_build_url: string;
  last_failure_job_url: string;
  last_failure_commit_sha: string;
  failure_count: number | string;
  resolved_at: Date | null;
  resolution_job_id: string | null;
  resolution_build_id: string | null;
  resolution_build_number: number | string | null;
  resolution_build_url: string | null;
  resolution_job_url: string | null;
  resolution_commit_sha: string | null;
  analysis_analyzed_failure_job_id: string | null;
  analysis_classification: MainCiAnalysisClassification | null;
  analysis_confidence: MainCiAnalysisConfidence | null;
  analysis_summary: string | null;
  analysis_evidence_urls: unknown;
  analysis_recommended_action: string | null;
  analysis_suspected_fix_prs: unknown;
  analysis_model_version: string | null;
  analysis_analyzed_at: Date | null;
}

function outcome(
  jobId: string,
  state: string,
  finishedAt: Date,
  buildId: string,
  buildNumber: number | string,
  buildUrl: string,
  jobUrl: string,
  commitSha: string,
): MainCiOutcomeRef {
  return {
    buildkiteJobId: jobId,
    state,
    finishedAt: finishedAt.toISOString(),
    buildkiteBuildId: buildId,
    buildNumber: Number(buildNumber),
    buildUrl,
    jobUrl,
    commitSha,
  };
}

function toMainCiJobAnalysis(row: MainCiJobAlertRow): MainCiJobAnalysis | null {
  if (
    row.analysis_analyzed_failure_job_id === null ||
    row.analysis_classification === null ||
    row.analysis_confidence === null ||
    row.analysis_summary === null ||
    row.analysis_recommended_action === null ||
    row.analysis_model_version === null ||
    row.analysis_analyzed_at === null
  ) {
    return null;
  }
  const evidenceUrls = Array.isArray(row.analysis_evidence_urls)
    ? row.analysis_evidence_urls.filter(
        (url): url is string => typeof url === "string",
      )
    : [];
  const suspectedFixPrs = Array.isArray(row.analysis_suspected_fix_prs)
    ? row.analysis_suspected_fix_prs
        .filter(
          (entry): entry is { url?: unknown; number?: unknown; title?: unknown } =>
            typeof entry === "object" && entry !== null,
        )
        .filter((entry) => typeof entry.url === "string")
        .map((entry) => ({
          url: entry.url as string,
          number: typeof entry.number === "number" ? entry.number : null,
          title: typeof entry.title === "string" ? entry.title : "",
        }))
    : [];
  return {
    analyzedFailureJobId: row.analysis_analyzed_failure_job_id,
    classification: row.analysis_classification,
    confidence: row.analysis_confidence,
    summary: row.analysis_summary,
    evidenceUrls,
    recommendedAction: row.analysis_recommended_action,
    suspectedFixPrs,
    modelVersion: row.analysis_model_version,
    analyzedAt: row.analysis_analyzed_at.toISOString(),
    stale: row.analysis_analyzed_failure_job_id !== row.last_failure_job_id,
  };
}

export function toMainCiJobAlert(row: MainCiJobAlertRow): MainCiJobAlert {
  const resolution =
    row.resolved_at !== null &&
    row.resolution_job_id !== null &&
    row.resolution_build_id !== null &&
    row.resolution_build_number !== null &&
    row.resolution_build_url !== null &&
    row.resolution_job_url !== null &&
    row.resolution_commit_sha !== null
      ? outcome(
          row.resolution_job_id,
          "passed",
          row.resolved_at,
          row.resolution_build_id,
          row.resolution_build_number,
          row.resolution_build_url,
          row.resolution_job_url,
          row.resolution_commit_sha,
        )
      : null;
  return {
    alertId: String(row.alert_id),
    jobKey: row.job_key,
    jobName: row.job_name,
    status: row.status,
    openedAt: row.opened_at.toISOString(),
    firstFailure: outcome(
      row.first_failure_job_id,
      row.first_failure_state,
      row.opened_at,
      row.first_failure_build_id,
      row.first_failure_build_number,
      row.first_failure_build_url,
      row.first_failure_job_url,
      row.first_failure_commit_sha,
    ),
    lastFailure: outcome(
      row.last_failure_job_id,
      row.last_failure_state,
      row.last_failed_at,
      row.last_failure_build_id,
      row.last_failure_build_number,
      row.last_failure_build_url,
      row.last_failure_job_url,
      row.last_failure_commit_sha,
    ),
    failureCount: Number(row.failure_count),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolution,
    analysis: toMainCiJobAnalysis(row),
  };
}

/** Open alerts remain visible regardless of age; resolved history obeys the window. */
export function viewMainCiJobAlerts(
  alerts: readonly MainCiJobAlert[],
  cutoff: Date,
): MainCiJobAlert[] {
  return [...alerts]
    .filter(
      (alert) =>
        alert.status === "open" ||
        (alert.resolvedAt !== null &&
          new Date(alert.resolvedAt).getTime() >= cutoff.getTime()),
    )
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      const aTime = a.resolvedAt ?? a.lastFailure.finishedAt;
      const bTime = b.resolvedAt ?? b.lastFailure.finishedAt;
      return bTime.localeCompare(aTime) || a.jobName.localeCompare(b.jobName);
    });
}
