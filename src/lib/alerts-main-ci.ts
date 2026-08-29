/** Presentation mapping for exact Main CI job alert episodes. */

export type MainCiAlertStatus = "open" | "resolved";

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
