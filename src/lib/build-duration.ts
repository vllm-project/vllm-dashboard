/**
 * Duration display for build rows.
 *
 * Finished builds show wall-clock time from start to finish. Builds that are
 * still going show how long they have been running so far, and builds that
 * are queued but not yet started show how long they have been waiting.
 */

export type BuildDurationKind =
  | "finished"
  | "running"
  | "queued"
  | "unknown";

export interface BuildDurationDisplay {
  kind: BuildDurationKind;
  /** Short text for the table cell, e.g. "1h 12m" or "48m 3s". */
  label: string;
  /** Longer hover text explaining what the label measures. */
  title: string;
}

const IN_PROGRESS_STATES = new Set([
  "running",
  "scheduled",
  "creating",
  "blocked",
  "canceling",
  "failing",
]);

/** True for Buildkite states where the build has not reached a final outcome. */
export function isBuildInProgress(state: string): boolean {
  return IN_PROGRESS_STATES.has(state);
}

/**
 * Format a millisecond duration as `Xh Ym` when an hour or longer, `Xm Ys`
 * when under an hour, and plain `Xs` under a minute.
 */
export function formatBuildDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1_000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m`;
  }
  const seconds = totalSeconds % 60;
  if (totalMinutes === 0) return `${seconds}s`;
  return `${totalMinutes}m ${seconds}s`;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function buildDurationDisplay(
  build: {
    state: string;
    created_at: string | null;
    started_at: string | null;
    finished_at: string | null;
  },
  now: number = Date.now(),
): BuildDurationDisplay {
  const started = parseTime(build.started_at);
  const finished = parseTime(build.finished_at);
  const created = parseTime(build.created_at);

  if (started !== null && finished !== null) {
    return {
      kind: "finished",
      label: formatBuildDuration(finished - started),
      title: "Wall-clock time from first job start to build finish",
    };
  }

  const inProgress = isBuildInProgress(build.state);

  if (inProgress && started !== null) {
    return {
      kind: "running",
      label: `${formatBuildDuration(Math.max(0, now - started))}…`,
      title: "Still running — elapsed since the build started",
    };
  }

  if (inProgress && created !== null) {
    return {
      kind: "queued",
      label: `queued ${formatBuildDuration(Math.max(0, now - created))}`,
      title: "Not started yet — time since the build was created",
    };
  }

  return {
    kind: "unknown",
    label: "—",
    title: "Duration unavailable",
  };
}
