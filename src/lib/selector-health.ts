/**
 * Presentation logic for the CI Selector page.
 *
 * ci-selector picks which test steps a PR build runs from data the scheduled
 * Full CI runs collect on main. Five components per run: the Python function
 * table (fnrec), the CUDA and ROCm kernel tables (kernrec), and the CUDA and
 * ROCm kernel source maps from the image builds that the kernel tables pair
 * with. The collect steps are soft_fail, so a
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

/** Kernel backends a PR decision can name. */
export const KERNEL_BACKENDS = ["cuda", "rocm"] as const;
export type KernelBackend = (typeof KERNEL_BACKENDS)[number];

/**
 * `missing` is a source map absent where nothing needed it (the image build
 * did not run, or its backend's kernel recorder was off); a map absent where
 * its image build ran for an armed backend is `broken`.
 */
export type ComponentStatus = "ok" | "broken" | "off" | "pending" | "missing";

/** A cell's colour: its status, or `degraded` for an ok table with rows_degraded. */
export type CellTone = ComponentStatus | "degraded";

/** Short column headings. */
export const SELECTOR_COMPONENT_LABELS: Record<SelectorComponent, string> = {
  fnrec: "Python table",
  kernrec_cuda: "CUDA kernels",
  kernrec_rocm: "ROCm kernels",
  map_cuda: "CUDA map",
  map_rocm: "ROCm map",
};

/** Full component names. */
export const SELECTOR_COMPONENT_NAMES: Record<SelectorComponent, string> = {
  fnrec: "Python function table",
  kernrec_cuda: "CUDA kernel table",
  kernrec_rocm: "ROCm kernel table",
  map_cuda: "CUDA kernel source map",
  map_rocm: "ROCm kernel source map",
};

export interface RunComponentRecord {
  component: SelectorComponent;
  status: ComponentStatus;
  jobState: string | null;
  softFailed: boolean;
  expectedJobs: number | null;
  deliveredJobs: number | null;
  /** Tables: every row, and the usable ones (null when unknown). */
  rows: number | null;
  usableRows: number | null;
  /** Kernel tables read whole: rows failing each usability condition. */
  rowsNotPassed: number | null;
  rowsTraceIncomplete: number | null;
  rowsDropped: number | null;
  rowsIncomplete: number | null;
  /** Source maps: objects, device objects, symbols, distinct csrc sources. */
  mapObjects: number | null;
  mapDeviceObjects: number | null;
  mapSymbols: number | null;
  mapSources: number | null;
  verdict: string | null;
  /** Uploaded by the producing job. */
  collected: boolean;
  /** Tables: published as latest. Maps: re-uploaded next to the kernel table. */
  published: boolean;
  publishedCommit: string | null;
  /** Why a published table's usable rows are degraded, else null. */
  rowsDegraded: string | null;
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
  /** Decisions whose records named each kernel backend. */
  kernelBackends: Record<KernelBackend, number>;
}

/** Recording builds PR decisions used in the recent window. */
export interface DecisionsInUse {
  windowHours: number;
  decisions: number;
  fnrecBuild: number | null;
  kernrecBuild: number | null;
  kernrecRocmBuild: number | null;
  /** Decisions in the window whose records named each kernel backend. */
  kernelBackends: Record<KernelBackend, number>;
  latestAt: string | null;
}

export interface SelectorAlertEpisode {
  alertId: string;
  condition: "run_incomplete" | "rows_degraded" | "stale" | "pr_stale" | "pr_errors";
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

/** Usable rows over all rows, when both are known. */
export function usableShare(item: RunComponentRecord | undefined): number | null {
  if (!item || item.usableRows === null || !item.rows) return null;
  return item.usableRows / item.rows;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Why a kernel table's rows are unusable, largest first. */
export function unusableReasons(item: RunComponentRecord | undefined): string[] {
  if (!item) return [];
  const reasons: Array<[number | null, string]> = [
    [item.rowsTraceIncomplete, "trace incomplete"],
    [item.rowsNotPassed, "job not passed"],
    [item.rowsDropped, "dropped recordings"],
    [item.rowsIncomplete, "incomplete"],
  ];
  return reasons
    .filter((entry): entry is [number, string] => entry[0] !== null && entry[0] > 0)
    .sort((a, b) => b[0] - a[0])
    .map(([count, label]) => `${count.toLocaleString()} ${label}`);
}

/** The cell colour: degraded tables stand apart from whole ones. */
export function cellTone(item: RunComponentRecord | undefined): CellTone {
  if (!item) return "off";
  if (item.status === "ok" && item.rowsDegraded) return "degraded";
  return item.status;
}

function isMap(item: RunComponentRecord): boolean {
  return item.component.startsWith("map_");
}

function jobsFigure(item: RunComponentRecord): string | null {
  if (item.expectedJobs === null && item.deliveredJobs === null) return null;
  return `${item.deliveredJobs ?? "?"}/${item.expectedJobs ?? "?"} jobs`;
}

/** The short figure in a run cell. */
export function componentFigure(item: RunComponentRecord | undefined): string {
  if (!item) return "—";
  if (item.status === "off") return "off";
  if (item.status === "pending") return "running";
  if (isMap(item)) {
    if (item.mapObjects === null) return item.collected ? "uploaded" : "missing";
    return `${item.mapObjects.toLocaleString()} obj · ${(item.mapSymbols ?? 0).toLocaleString()} sym`;
  }
  const share = usableShare(item);
  let rows: string;
  if (item.usableRows !== null && item.rows !== null && share !== null) {
    rows = `${item.usableRows.toLocaleString()}/${item.rows.toLocaleString()} usable (${percent(share)})`;
  } else if (item.usableRows !== null) {
    rows = `${item.usableRows.toLocaleString()} usable`;
  } else if (item.rows !== null) {
    rows = `${item.rows.toLocaleString()} rows`;
  } else {
    rows = "? rows";
  }
  const jobs = jobsFigure(item);
  return jobs ? `${rows} · ${jobs}` : rows;
}

/** The hover text for a run cell: verdict, counts, and where it was read. */
export function componentTitle(item: RunComponentRecord | undefined): string {
  if (!item) return "Not recorded";
  const parts = [
    `${SELECTOR_COMPONENT_LABELS[item.component]}: ${item.verdict ?? item.status}`,
  ];
  if (item.rowsDegraded) parts.push(`degraded: ${item.rowsDegraded}`);
  if (item.jobState) {
    parts.push(`job ${item.jobState}${item.softFailed ? " (soft-failed)" : ""}`);
  }
  if (!isMap(item) && item.rows !== null && item.usableRows === null) {
    parts.push("usable rows unknown");
  }
  const reasons = unusableReasons(item);
  if (reasons.length) parts.push(`unusable: ${reasons.join(", ")}`);
  if (isMap(item) && item.mapObjects !== null) {
    parts.push(
      `${item.mapDeviceObjects ?? "?"} device objects, ${item.mapSources ?? "?"} csrc sources`,
    );
  }
  if (item.publishedCommit) parts.push(`commit ${item.publishedCommit.slice(0, 12)}`);
  if (item.source === "log") parts.push("read from the collect log");
  if (item.source === "summary") parts.push("read from the collect summary");
  if (item.source === "table") parts.push("rows counted from the table");
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
  /** The recording build recent PR decisions used, when they name one. */
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
          : (inUse?.kernrecRocmBuild ?? null);
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
  /** Decisions whose records named each kernel backend. */
  kernelBackends: Record<KernelBackend, number>;
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
        kernelBackends: { cuda: 0, rocm: 0 },
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
    entry.kernelBackends = row.kernelBackends;
  }
  for (const entry of days.values()) {
    entry.skipped.sort((a, b) => b.builds - a.builds);
    entry.fallback.sort((a, b) => b.builds - a.builds);
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
}

const RECORDING_NAMES: Record<string, string> = {
  ...SELECTOR_COMPONENT_NAMES,
  kernrec: "CUDA kernel table",
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
    case "rows_degraded": {
      const build = num(details, "build_number");
      const reason = typeof details.reason === "string" ? details.reason : "usable rows dropped";
      return `${name} degraded in run #${build ?? "?"}: ${reason}.`;
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
  rows_degraded: "Usable rows dropped",
  stale: "Recording stale",
  pr_stale: "PRs on an old recording",
  pr_errors: "Selector errors",
};
