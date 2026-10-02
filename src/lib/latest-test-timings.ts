import { getDb } from "@/lib/db";

// Per-file test timings for one Buildkite step: the median over the newest
// main builds in which every job of the step passed. The runtime shard planner
// reads this as its timing baseline; it must never mistake missing telemetry
// for fast tests. A median over many builds keeps a short run of slow builds,
// such as an infra incident, from making the planner over-shard.

export const MEDIAN_BUILDS = 20;

export interface TestSpanRow {
  job_id: string;
  command_span_id: string | null;
  command_label: string | null;
  nodeid: string | null;
  outcome: string | null;
  duration_ms: number;
}

export interface TestTiming {
  nodeid: string;
  observedMs: number;
}

export interface FileTiming {
  command: string;
  file: string;
  observedMs: number;
  passedMs: number;
  cases: number;
  outcomes: Record<string, number>;
  timingStatus: "passed" | "contains_skips" | "skip_only";
  builds: number;
  tests: TestTiming[];
}

// A file entry with its tests omitted (when the caller asked for none, or the
// file's median didn't clear their threshold).
export type FileTimingResponse = Omit<FileTiming, "tests"> & { tests?: TestTiming[] };

export interface LatestTestTimings {
  stepKey: string;
  buildNumber: number;
  commit: string | null;
  finishedAt: string;
  jobIds: string[];
  buildNumbers: number[];
  skippedBuilds: { buildNumber: number; reason: string }[];
  measurement: "median_over_builds_of_summed_pytest_runtest_spans";
  files: FileTiming[];
}

export class TimingDataError extends Error {}

export function summarizeFiles(rows: TestSpanRow[]): FileTiming[] {
  const seen = new Set<string>();
  const files = new Map<string, FileTiming>();
  for (const row of rows) {
    if (!row.command_span_id || !row.command_label) {
      throw new TimingDataError("Test span without a parent command");
    }
    const nodeid = row.nodeid ?? "";
    const file = nodeid.split("::", 1)[0];
    if (!nodeid.includes("::") || file.startsWith("/") || file.split("/").includes("..")) {
      throw new TimingDataError(`Invalid test identity: ${nodeid}`);
    }
    const duration = Number(row.duration_ms);
    if (!Number.isFinite(duration) || duration < 0) {
      throw new TimingDataError(`Invalid duration for ${nodeid}`);
    }
    // Shards of one step run the same command label; a case seen twice under
    // one command means a retry or duplicate delivery, not a second case.
    const identity = JSON.stringify([row.command_label, nodeid]);
    if (seen.has(identity)) throw new TimingDataError(`Repeated case: ${nodeid}`);
    seen.add(identity);
    const key = JSON.stringify([row.command_label, file]);
    let entry = files.get(key);
    if (!entry) {
      entry = {
        command: row.command_label, file, observedMs: 0, passedMs: 0,
        cases: 0, outcomes: {}, timingStatus: "passed", builds: 1, tests: [],
      };
      files.set(key, entry);
    }
    const outcome = row.outcome ?? "unknown";
    entry.observedMs += duration;
    if (outcome === "passed") entry.passedMs += duration;
    entry.cases += 1;
    entry.outcomes[outcome] = (entry.outcomes[outcome] ?? 0) + 1;
    // A nodeid is unique within one build (checked above), so each test
    // contributes exactly one duration here; no outcome filtering, matching
    // observedMs above, which also counts skips.
    entry.tests.push({ nodeid, observedMs: duration });
  }
  for (const entry of files.values()) {
    entry.timingStatus = !entry.outcomes.passed
      ? "skip_only"
      : entry.cases > entry.outcomes.passed ? "contains_skips" : "passed";
  }
  return [...files.values()].sort((a, b) =>
    a.command === b.command ? a.file.localeCompare(b.file) : a.command.localeCompare(b.command));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Combine summarizeFiles() output from several builds, newest first, into one
 * entry per command and file. Times are medians over the builds the file ran
 * in; cases, outcomes and status come from the newest of those builds.
 */
export function medianFiles(filesPerBuild: FileTiming[][]): FileTiming[] {
  const byKey = new Map<string, FileTiming[]>();
  for (const files of filesPerBuild) {
    for (const file of files) {
      const key = JSON.stringify([file.command, file.file]);
      const entries = byKey.get(key) ?? [];
      entries.push(file);
      byKey.set(key, entries);
    }
  }
  const result: FileTiming[] = [];
  for (const entries of byKey.values()) {
    // Per-test median, over only the builds that test appeared in (same rule
    // as the file-level median above: a build missing a test doesn't give it
    // a 0). Order is first-seen, scanning builds newest first.
    const byNodeid = new Map<string, number[]>();
    for (const entry of entries) {
      for (const t of entry.tests) {
        const times = byNodeid.get(t.nodeid) ?? [];
        times.push(t.observedMs);
        byNodeid.set(t.nodeid, times);
      }
    }
    const tests = [...byNodeid.entries()].map(([nodeid, times]) => ({
      nodeid, observedMs: median(times),
    }));
    result.push({
      ...entries[0],
      observedMs: median(entries.map((e) => e.observedMs)),
      passedMs: median(entries.map((e) => e.passedMs)),
      builds: entries.length,
      tests,
    });
  }
  return result.sort((a, b) =>
    a.command === b.command ? a.file.localeCompare(b.file) : a.command.localeCompare(b.command));
}

/**
 * Keep per-test medians only for files whose median observedMs clears
 * testsOverMs; strip the field from every file when testsOverMs is null (the
 * query param was absent). The runtime shard planner asks for exactly the
 * files it might need to split.
 */
export function withTestsOverMs(
  files: FileTiming[],
  testsOverMs: number | null,
): FileTimingResponse[] {
  return files.map((file) => {
    if (testsOverMs !== null && file.observedMs > testsOverMs) return file;
    const response: FileTimingResponse = { ...file };
    delete response.tests;
    return response;
  });
}

export async function queryLatestTestTimings(
  stepKey: string,
  { days = 14 } = {},
): Promise<LatestTestTimings | null> {
  const sql = getDb();
  // Main-branch CI runs only: PR and other branches never feed the baseline.
  // The pipeline and branch literals must match the partial index predicate
  // in migration 0029, so they are not parameters. A retried failure keeps its
  // failed job span, so that build is skipped: the baseline only comes from
  // builds where the step passed outright. A passing build whose test spans
  // were lost in ingestion is skipped too, so the previous build is used
  // instead. The test-span check sits outside the sorted subquery so it runs
  // newest first and stops once enough builds match.
  const builds = await sql<{
    build_number: string; commit: string | null; finished_at: Date; job_ids: string[];
  }[]>`
    SELECT * FROM (
      SELECT
        build_number,
        MAX(span_attributes->>'buildkite.build.commit') AS commit,
        MAX(end_time) AS finished_at,
        ARRAY_AGG(job_id ORDER BY job_id) AS job_ids
      FROM otel_spans
      WHERE span_name = 'buildkite.job'
        AND job_type = 'script'
        AND pipeline_slug = 'ci'
        AND span_attributes->>'buildkite.build.branch' = 'main'
        AND step_key = ${stepKey}
        AND start_time >= NOW() - make_interval(days => ${days})
      GROUP BY build_number
      HAVING BOOL_AND(job_state = 'finished' AND job_passed = 'true')
      ORDER BY build_number DESC
    ) AS passing
    WHERE EXISTS (
      SELECT 1 FROM otel_spans AS t
      WHERE t.job_id = ANY(passing.job_ids)
        AND t.span_attributes->>'ci.span.kind' = 'test'
    )
    ORDER BY build_number DESC
    LIMIT ${MEDIAN_BUILDS}
  `;
  if (builds.length === 0) return null;
  const jobIds = builds.flatMap((build) => build.job_ids);
  const rows = await sql<TestSpanRow[]>`
    SELECT
      t.job_id,
      t.duration_ms,
      NULLIF(t.span_attributes->>'test.nodeid', '') AS nodeid,
      NULLIF(t.span_attributes->>'test.outcome', '') AS outcome,
      c.span_id AS command_span_id,
      NULLIF(c.span_attributes->>'ci.command.label', '') AS command_label
    FROM otel_spans AS t
    LEFT JOIN otel_spans AS c
      ON c.trace_id = t.trace_id
      AND c.span_id = t.parent_span_id
      AND c.span_attributes->>'ci.span.kind' = 'command'
    WHERE t.job_id = ANY(${jobIds})
      AND t.span_attributes->>'ci.span.kind' = 'test'
  `;
  const rowsByJob = new Map<string, TestSpanRow[]>();
  for (const row of rows) {
    const jobRows = rowsByJob.get(row.job_id) ?? [];
    jobRows.push(row);
    rowsByJob.set(row.job_id, jobRows);
  }
  // A build whose spans fail validation was partly lost in ingestion. Leave it
  // out of the median rather than failing the whole baseline, and say so.
  const used: (typeof builds)[number][] = [];
  const filesPerBuild: FileTiming[][] = [];
  const skippedBuilds: { buildNumber: number; reason: string }[] = [];
  let firstError: TimingDataError | null = null;
  for (const build of builds) {
    try {
      filesPerBuild.push(summarizeFiles(build.job_ids.flatMap((jobId) => rowsByJob.get(jobId) ?? [])));
      used.push(build);
    } catch (e) {
      if (!(e instanceof TimingDataError)) throw e;
      firstError ??= e;
      skippedBuilds.push({ buildNumber: Number(build.build_number), reason: e.message });
    }
  }
  if (used.length === 0) throw firstError;
  const [newest] = used;
  return {
    stepKey,
    buildNumber: Number(newest.build_number),
    commit: newest.commit,
    finishedAt: new Date(newest.finished_at).toISOString(),
    jobIds: used.flatMap((build) => build.job_ids),
    buildNumbers: used.map((build) => Number(build.build_number)),
    skippedBuilds,
    measurement: "median_over_builds_of_summed_pytest_runtest_spans",
    files: medianFiles(filesPerBuild),
  };
}
