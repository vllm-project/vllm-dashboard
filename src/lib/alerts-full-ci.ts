/**
 * Presentation logic for the Full CI view of the alerts tab.
 *
 * A Full CI Failure Condition is a classification the analyzer made about one
 * job across one comparison of two scheduled Full CI Runs. The classification
 * is only meaningful against that baseline, so the two runs travel with it.
 *
 * The analyzer also produces raw evidence — its rendered report, previous
 * failure cache, suspicious-PR working set, and versioned memory checkpoints.
 * None of that belongs in a response this view serves, so the row mappers here
 * copy named fields only and never spread a database row into the payload.
 */

import type { NotificationState, NotificationStatus } from "./alerts-shared";

export type FullCiLifecycle = "new" | "recurring" | "fixed";

export type FullCiCause =
  | "infrastructure"
  | "flaky_test"
  | "test"
  | "code"
  | "unknown";

/** Scheduled Full CI runs are all builds of the one `vllm/ci` pipeline. */
export function buildUrlForNumber(buildNumber: number): string {
  return `https://buildkite.com/vllm/ci/builds/${buildNumber}`;
}

export const LIFECYCLE_LABELS: Record<FullCiLifecycle, string> = {
  new: "New",
  recurring: "Recurring",
  fixed: "Fixed",
};

export const CAUSE_LABELS: Record<FullCiCause, string> = {
  infrastructure: "Infrastructure",
  flaky_test: "Flaky test",
  test: "Test",
  code: "Code",
  unknown: "Unknown cause",
};

export interface FullCiRun {
  buildkiteBuildId: string;
  buildNumber: number;
  scheduledAt: string;
  commitSha: string;
  message: string;
  state: string;
  buildUrl: string;
}

/** How one job actually ended in one run, or null when it did not run at all. */
export interface FullCiJobOutcome {
  state: string;
  softFailed: boolean;
}

export interface PullRequestRef {
  number: number;
  url: string;
  title: string;
}

export interface FullCiFailureCondition {
  jobName: string;
  lifecycle: FullCiLifecycle;
  cause: FullCiCause;
  summary: string;
  culpritPr: PullRequestRef | null;
  fixingPr: PullRequestRef | null;
  previousOutcome: FullCiJobOutcome | null;
  currentOutcome: FullCiJobOutcome | null;
}

export interface FullCiComparison {
  currentRun: FullCiRun;
  previousRun: FullCiRun;
  analyzedAt: string;
  /**
   * One comparison produces exactly one Slack delivery, keyed by the outbox's
   * primary key, so a comparison has one delivery status or none at all.
   */
  notificationStatus: NotificationStatus | null;
  conditions: FullCiFailureCondition[];
}

/** One analyzed comparison and the two runs it compared. */
export interface FullCiComparisonRow {
  current_build_id: string;
  current_build_number: number;
  current_scheduled_at: Date;
  current_commit_sha: string;
  current_message: string;
  current_state: string;
  previous_build_id: string;
  previous_build_number: number;
  previous_scheduled_at: Date;
  previous_commit_sha: string;
  previous_message: string;
  previous_state: string;
  analyzed_at: Date;
  notification_status: NotificationStatus | null;
}

/** One classified job, with its outcome in each of the compared runs. */
export interface FullCiConditionRow {
  current_build_id: string;
  job_name: string;
  lifecycle: FullCiLifecycle;
  cause: FullCiCause;
  summary: string;
  culprit_pr_number: number | null;
  culprit_pr_url: string | null;
  culprit_pr_title: string | null;
  fixing_pr_number: number | null;
  fixing_pr_url: string | null;
  fixing_pr_title: string | null;
  previous_state: string | null;
  previous_soft_failed: boolean | null;
  current_state: string | null;
  current_soft_failed: boolean | null;
}

function toPullRequest(
  number: number | null,
  url: string | null,
  title: string | null,
): PullRequestRef | null {
  if (number === null || url === null) return null;
  return { number, url, title: title ?? "" };
}

function toOutcome(
  state: string | null,
  softFailed: boolean | null,
): FullCiJobOutcome | null {
  if (state === null) return null;
  return { state, softFailed: softFailed ?? false };
}

function toCondition(row: FullCiConditionRow): FullCiFailureCondition {
  return {
    jobName: row.job_name,
    lifecycle: row.lifecycle,
    cause: row.cause,
    summary: row.summary,
    culpritPr: toPullRequest(
      row.culprit_pr_number,
      row.culprit_pr_url,
      row.culprit_pr_title,
    ),
    fixingPr: toPullRequest(
      row.fixing_pr_number,
      row.fixing_pr_url,
      row.fixing_pr_title,
    ),
    previousOutcome: toOutcome(row.previous_state, row.previous_soft_failed),
    currentOutcome: toOutcome(row.current_state, row.current_soft_failed),
  };
}

export function toFullCiComparisons(
  comparisonRows: readonly FullCiComparisonRow[],
  conditionRows: readonly FullCiConditionRow[],
): FullCiComparison[] {
  const byBuild = new Map<string, FullCiFailureCondition[]>();
  for (const row of conditionRows) {
    const conditions = byBuild.get(row.current_build_id);
    if (conditions) conditions.push(toCondition(row));
    else byBuild.set(row.current_build_id, [toCondition(row)]);
  }

  return comparisonRows.map((row) => ({
    currentRun: {
      buildkiteBuildId: row.current_build_id,
      buildNumber: row.current_build_number,
      scheduledAt: row.current_scheduled_at.toISOString(),
      commitSha: row.current_commit_sha,
      message: row.current_message,
      state: row.current_state,
      buildUrl: buildUrlForNumber(row.current_build_number),
    },
    previousRun: {
      buildkiteBuildId: row.previous_build_id,
      buildNumber: row.previous_build_number,
      scheduledAt: row.previous_scheduled_at.toISOString(),
      commitSha: row.previous_commit_sha,
      message: row.previous_message,
      state: row.previous_state,
      buildUrl: buildUrlForNumber(row.previous_build_number),
    },
    analyzedAt: row.analyzed_at.toISOString(),
    notificationStatus: row.notification_status,
    conditions: byBuild.get(row.current_build_id) ?? [],
  }));
}

export interface FullCiComparisonView extends FullCiComparison {
  notificationState: NotificationState;
  /**
   * True for the newest comparison, which alone describes CI as it stands now.
   * Older cards keep their own ongoing conditions, but those are history.
   */
  isLatest: boolean;
  /** New and recurring conditions: what was still broken at this comparison. */
  ongoing: FullCiFailureCondition[];
  /** Conditions this comparison observed passing again. */
  fixed: FullCiFailureCondition[];
}

/** New conditions lead: they are the change this comparison introduced. */
const ONGOING_ORDER: FullCiLifecycle[] = ["new", "recurring"];

export function viewFullCiComparisons(
  comparisons: readonly FullCiComparison[],
): FullCiComparisonView[] {
  return [...comparisons]
    .sort((a, b) =>
      b.currentRun.scheduledAt.localeCompare(a.currentRun.scheduledAt),
    )
    .map((comparison, index) => ({
      ...comparison,
      notificationState: comparison.notificationStatus ?? "unnotified",
      isLatest: index === 0,
      ongoing: comparison.conditions
        .filter((condition) => condition.lifecycle !== "fixed")
        .sort(
          (a, b) =>
            ONGOING_ORDER.indexOf(a.lifecycle) -
              ONGOING_ORDER.indexOf(b.lifecycle) ||
            a.jobName.localeCompare(b.jobName),
        ),
      fixed: comparison.conditions
        .filter((condition) => condition.lifecycle === "fixed")
        .sort((a, b) => a.jobName.localeCompare(b.jobName)),
    }));
}

function conditionMatches(
  condition: FullCiFailureCondition,
  needle: string,
): boolean {
  return [
    condition.jobName,
    condition.summary,
    LIFECYCLE_LABELS[condition.lifecycle],
    CAUSE_LABELS[condition.cause],
    condition.culpritPr?.title,
    condition.fixingPr?.title,
  ].some((field) => field?.toLowerCase().includes(needle));
}

function runMatches(run: FullCiRun, needle: string): boolean {
  return [String(run.buildNumber), run.commitSha, run.message].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/**
 * Keyword filter over the rendered comparisons. A comparison whose own build,
 * commit, or commit message matches is kept whole, since the query names the
 * comparison itself rather than anything inside it. Otherwise the query is read
 * as naming failure conditions, so the card keeps only its matching rows and
 * drops out entirely when none match.
 */
export function filterFullCiComparisonViews(
  views: readonly FullCiComparisonView[],
  query: string,
): FullCiComparisonView[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...views];

  return views.flatMap((view) => {
    if (
      runMatches(view.currentRun, needle) ||
      runMatches(view.previousRun, needle)
    ) {
      return [view];
    }

    const ongoing = view.ongoing.filter((c) => conditionMatches(c, needle));
    const fixed = view.fixed.filter((c) => conditionMatches(c, needle));
    if (ongoing.length === 0 && fixed.length === 0) return [];

    return [{ ...view, ongoing, fixed }];
  });
}
