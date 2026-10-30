/**
 * Presentation logic for the CI Selector page.
 *
 * ci-selector picks which test steps a PR build runs from recordings the
 * scheduled Full CI runs make on main: a Python function table (fnrec) and
 * CUDA and ROCm kernel tables (kernrec), each kernel table paired with a
 * symbol map from the image builds. The collect steps are soft_fail, so a
 * broken collect never turns a build red. The alerting worker's
 * selector-health slice records every run's components and every PR build's
 * selector decision; this module turns those records into the page's view.
 * Alert Production owns the records and the alert conditions.
 */

export const SELECTOR_COMPONENTS = [
  "fnrec",
  "kernrec_cuda",
  "kernrec_rocm",
  "map_cuda",
  "map_rocm",
] as const;

export type SelectorComponent = (typeof SELECTOR_COMPONENTS)[number];

/** The three recordings; maps only pair with a kernel table. */
export const SELECTOR_RECORDINGS = ["fnrec", "kernrec_cuda", "kernrec_rocm"] as const;
export type SelectorRecording = (typeof SELECTOR_RECORDINGS)[number];

export type ComponentStatus = "ok" | "broken" | "off" | "pending";

export const SELECTOR_COMPONENT_LABELS: Record<SelectorComponent, string> = {
  fnrec: "Python",
  kernrec_cuda: "CUDA kernels",
  kernrec_rocm: "ROCm kernels",
  map_cuda: "CUDA map",
  map_rocm: "ROCm map",
};

export interface RunComponentRecord {
  component: SelectorComponent;
  status: ComponentStatus;
  jobState: string | null;
  softFailed: boolean;
  expectedJobs: number | null;
  deliveredJobs: number | null;
  rows: number | null;
  verdict: string | null;
  published: boolean;
  publishedCommit: string | null;
  source: string;
}

export interface FullRunRecord {
  buildNumber: number;
  kind: "nightly" | "daily";
  createdAt: string;
  commitSha: string;
  buildState: string;
  settled: boolean;
  components: RunComponentRecord[];
}

/** Count of one day's PR builds with one outcome and reason. */
export interface DecisionCountRow {
  day: string;
  outcome: "applied" | "skipped" | "fallback" | "missing";
  reason: string | null;
  builds: number;
}

export interface DecisionTimingRow {
  day: string;
  p50Seconds: number | null;
  p95Seconds: number | null;
  ciInfraCommits: string[];
}

/** Recording builds PR decisions used in the recent window. */
export interface DecisionsInUse {
  windowHours: number;
  decisions: number;
  fnrecBuild: number | null;
  kernrecBuild: number | null;
  latestAt: string | null;
}

export interface SelectorAlertEpisode {
  alertId: string;
  condition: "run_incomplete" | "stale" | "pr_stale" | "pr_errors";
  subjectKey: string;
  status: "open" | "resolved";
  openedAt: string;
  resolvedAt: string | null;
  details: Record<string, unknown>;
}

export interface SelectorHealthResponse {
  schemaStatus: "ready" | "pending";
  windowDays: number;
  runs: FullRunRecord[];
  decisionCounts: DecisionCountRow[];
  decisionTimings: DecisionTimingRow[];
  inUse: DecisionsInUse | null;
  episodes: SelectorAlertEpisode[];
  generatedAt: string;
}

export function buildUrl(buildNumber: number | string): string {
  return `https://buildkite.com/vllm/ci/builds/${buildNumber}`;
}

export function componentOf(
  run: FullRunRecord,
  component: SelectorComponent,
): RunComponentRecord | undefined {
  return run.components.find((item) => item.component === component);
}

/** The short figure in a run cell: rows and delivered/expected jobs. */
export function componentFigure(item: RunComponentRecord | undefined): string {
  if (!item) return "—";
  if (item.status === "off") return "off";
  if (item.status === "pending") return "running";
  if (item.component.startsWith("map_")) return item.published ? "uploaded" : "missing";
  const rows = item.rows === null ? "? rows" : `${item.rows.toLocaleString()} rows`;
  if (item.expectedJobs === null && item.deliveredJobs === null) return rows;
  return `${rows} · ${item.deliveredJobs ?? "?"}/${item.expectedJobs ?? "?"}`;
}

/** The hover text for a run cell: the verdict and where it was read. */
export function componentTitle(item: RunComponentRecord | undefined): string {
  if (!item) return "Not recorded";
  const parts = [
    `${SELECTOR_COMPONENT_LABELS[item.component]}: ${item.verdict ?? item.status}`,
  ];
  if (item.jobState) {
    parts.push(`job ${item.jobState}${item.softFailed ? " (soft-failed)" : ""}`);
  }
  if (item.publishedCommit) parts.push(`published ${item.publishedCommit.slice(0, 12)}`);
  if (item.source === "log") parts.push("read from the collect log");
  if (item.source === "summary") parts.push("read from the collect summary");
  return parts.join(" · ");
}

export interface RecordingFreshness {
  recording: SelectorRecording;
  /** The newest run that published it. */
  published: FullRunRecord | null;
  /** Hours from that run to `now`. */
  ageHours: number | null;
  /** Hours it trails the newest completed run. */
  behindHours: number | null;
  /** The recording build recent PR decisions used, when it has one. */
  usedBuild: number | null;
}

function hoursBetween(from: string, to: Date | string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000;
}

/**
 * For each recording: the newest run that published it, its age, and the
 * build PR decisions are actually using (the CUDA table for kernrec).
 */
export function recordingFreshness(
  runs: readonly FullRunRecord[],
  inUse: DecisionsInUse | null,
  now: Date,
): RecordingFreshness[] {
  const ordered = [...runs].sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
      b.buildNumber - a.buildNumber,
  );
  const newestCompleted = ordered.find((run) => run.settled) ?? null;
  return SELECTOR_RECORDINGS.map((recording) => {
    const published =
      ordered.find((run) => componentOf(run, recording)?.published) ?? null;
    const usedBuild =
      recording === "fnrec"
        ? (inUse?.fnrecBuild ?? null)
        : recording === "kernrec_cuda"
          ? (inUse?.kernrecBuild ?? null)
          : null;
    return {
      recording,
      published,
      ageHours: published ? hoursBetween(published.createdAt, now) : null,
      behindHours:
        published && newestCompleted
          ? Math.max(0, hoursBetween(published.createdAt, newestCompleted.createdAt))
          : null,
      usedBuild,
    };
  });
}

export interface DailyDecisionSummary {
  day: string;
  total: number;
  applied: number;
  skipped: Array<{ reason: string; builds: number }>;
  fallback: Array<{ reason: string; builds: number }>;
  missing: number;
  /** Fallbacks whose reason says the selector itself failed. */
  selectorErrors: number;
  p50Seconds: number | null;
  p95Seconds: number | null;
  ciInfraCommits: string[];
}

const SELECTOR_ERROR = /^(selector failed|gate error)/i;

export function isSelectorError(reason: string | null): boolean {
  return reason !== null && SELECTOR_ERROR.test(reason);
}

/** One row per day, newest first, from the per-outcome counts and timings. */
export function summarizeDecisions(
  counts: readonly DecisionCountRow[],
  timings: readonly DecisionTimingRow[],
): DailyDecisionSummary[] {
  const days = new Map<string, DailyDecisionSummary>();
  const day = (key: string): DailyDecisionSummary => {
    let entry = days.get(key);
    if (!entry) {
      entry = {
        day: key,
        total: 0,
        applied: 0,
        skipped: [],
        fallback: [],
        missing: 0,
        selectorErrors: 0,
        p50Seconds: null,
        p95Seconds: null,
        ciInfraCommits: [],
      };
      days.set(key, entry);
    }
    return entry;
  };
  for (const row of counts) {
    const entry = day(row.day);
    entry.total += row.builds;
    if (row.outcome === "applied") entry.applied += row.builds;
    else if (row.outcome === "missing") entry.missing += row.builds;
    else {
      entry[row.outcome].push({ reason: row.reason ?? "unknown", builds: row.builds });
      if (row.outcome === "fallback" && isSelectorError(row.reason)) {
        entry.selectorErrors += row.builds;
      }
    }
  }
  for (const row of timings) {
    const entry = day(row.day);
    entry.p50Seconds = row.p50Seconds;
    entry.p95Seconds = row.p95Seconds;
    entry.ciInfraCommits = row.ciInfraCommits;
  }
  for (const entry of days.values()) {
    entry.skipped.sort((a, b) => b.builds - a.builds);
    entry.fallback.sort((a, b) => b.builds - a.builds);
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
}

const RECORDING_NAMES: Record<string, string> = {
  fnrec: "Python recording",
  kernrec_cuda: "CUDA kernel recording",
  kernrec_rocm: "ROCm kernel recording",
  kernrec: "kernel recording",
};

function num(details: Record<string, unknown>, key: string): number | null {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildOf(details: Record<string, unknown>, key: string): number | null {
  const value = details[key];
  if (value && typeof value === "object" && "build_number" in value) {
    const build = (value as { build_number: unknown }).build_number;
    return typeof build === "number" ? build : null;
  }
  return null;
}

/** The episode's one-line reading of its details payload. */
export function summarizeEpisode(episode: SelectorAlertEpisode): string {
  const { details } = episode;
  const name = RECORDING_NAMES[episode.subjectKey] ?? episode.subjectKey;
  switch (episode.condition) {
    case "run_incomplete": {
      const build = num(details, "build_number");
      const verdict = typeof details.verdict === "string" ? details.verdict : "not whole";
      return `${name} not whole in run #${build ?? "?"}: ${verdict}.`;
    }
    case "stale": {
      const hours = num(details, "stale_hours");
      const last = buildOf(details, "last_published");
      return hours === null
        ? `${name} not published in the last ${num(details, "history_days") ?? 14} days.`
        : `${name} last published by #${last ?? "?"}, ${hours} h before the newest completed run.`;
    }
    case "pr_stale": {
      const median = num(details, "median_build");
      const newest = buildOf(details, "newest_published");
      const lag = num(details, "lag_hours");
      return `PR decisions use ${name} #${median ?? "?"}${lag === null ? "" : `, ${lag} h`} behind the newest published #${newest ?? "?"}.`;
    }
    case "pr_errors": {
      const rate = num(details, "rate");
      return `${num(details, "errors") ?? "?"} of ${num(details, "builds") ?? "?"} PR builds${rate === null ? "" : ` (${(rate * 100).toFixed(1)}%)`} fell back on a selector error.`;
    }
  }
}

export const SELECTOR_CONDITION_LABELS: Record<SelectorAlertEpisode["condition"], string> = {
  run_incomplete: "Run not whole",
  stale: "Recording stale",
  pr_stale: "PRs on an old recording",
  pr_errors: "Selector errors",
};
