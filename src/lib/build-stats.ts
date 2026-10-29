// Headline numbers for the Builds page, from the finished builds the build
// duration chart already loads (no extra query).

export interface FinishedBuild {
  state: string;
  created_at: string;
  finished_at: string;
  duration_mins: string | number;
}

function isFailed(state: string): boolean {
  return state === "failed" || state === "failing";
}

/** Passed or failed: canceled and other states say nothing about the code. */
function hasOutcome(build: FinishedBuild): boolean {
  return build.state === "passed" || isFailed(build.state);
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Median and p90 run time, in minutes, of builds that passed or failed. */
export function durationStats(
  builds: FinishedBuild[],
): { p50: number; p90: number } | null {
  const minutes = builds
    .filter(hasOutcome)
    .map((build) => Number(build.duration_mins))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (minutes.length === 0) return null;
  return { p50: percentile(minutes, 0.5), p90: percentile(minutes, 0.9) };
}

/**
 * How long the branch was red: the share of time, from its first finished
 * build in the range until `until`, during which its most recently finished
 * build had failed, and the longest such stretch. Only meaningful for one
 * branch.
 */
export function redTime(
  builds: FinishedBuild[],
  until: number,
): { share: number; longestMs: number } | null {
  const finished = builds
    .filter(hasOutcome)
    .map((build) => ({
      failed: isFailed(build.state),
      at: new Date(build.finished_at).getTime(),
    }))
    .filter((build) => Number.isFinite(build.at) && build.at <= until)
    .sort((a, b) => a.at - b.at);
  if (finished.length === 0) return null;
  const span = until - finished[0].at;
  if (span <= 0) return null;

  let red = 0;
  let longest = 0;
  let redSince: number | null = null;
  finished.forEach((build, index) => {
    const next = finished[index + 1]?.at ?? until;
    if (build.failed) {
      red += next - build.at;
      redSince ??= build.at;
      longest = Math.max(longest, next - redSince);
    } else {
      redSince = null;
    }
  });
  return { share: red / span, longestMs: longest };
}

function parseRangeDate(value: string): number {
  return new Date(value.includes("T") ? value : `${value}T00:00:00Z`).getTime();
}

/** Where the range ends: a date end is inclusive (as the API reads it), and
 * never past now. */
export function rangeEndMs(endDate: string, now: number): number {
  if (!endDate) return now;
  let end = parseRangeDate(endDate);
  if (!endDate.includes("T")) end += 86_400_000;
  return Number.isFinite(end) ? Math.min(end, now) : now;
}

/** The time the range covers, for a builds-per-day rate. */
export function rangeSpanMs(
  startDate: string,
  endDate: string,
  now: number,
): number | null {
  if (!startDate || !endDate) return null;
  const start = parseRangeDate(startDate);
  const end = rangeEndMs(endDate, now);
  return Number.isFinite(start) && end > start ? end - start : null;
}

/**
 * The builds created within [startDate, endDate), read as the API reads the
 * range. Lets the chart redraw a zoomed-in range at once from builds it
 * already has, while the new range loads.
 */
export function buildsInRange<T extends { created_at: string }>(
  builds: T[],
  startDate: string,
  endDate: string,
  now: number,
): T[] {
  const start = startDate ? parseRangeDate(startDate) : -Infinity;
  const end = endDate ? rangeEndMs(endDate, Infinity) : Infinity;
  if (!Number.isFinite(start) && !Number.isFinite(end)) return builds;
  const inRange = builds.filter((build) => {
    const at = new Date(build.created_at).getTime();
    return at >= start && at < end && at <= now;
  });
  return inRange.length === builds.length ? builds : inRange;
}

export function formatMinutes(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded}m`;
  const rest = rounded % 60;
  return rest ? `${Math.floor(rounded / 60)}h ${rest}m` : `${Math.floor(rounded / 60)}h`;
}
