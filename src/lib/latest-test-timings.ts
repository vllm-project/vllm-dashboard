import { getDb } from "@/lib/db";

// Per-file test timings from the newest main build in which every job of one
// Buildkite step passed. The runtime shard planner reads this as its timing
// baseline; it must never mistake missing telemetry for fast tests.

export interface TestSpanRow {
  job_id: string;
  command_span_id: string | null;
  command_label: string | null;
  nodeid: string | null;
  outcome: string | null;
  duration_ms: number;
}

export interface FileTiming {
  command: string;
  file: string;
  observedMs: number;
  passedMs: number;
  cases: number;
  outcomes: Record<string, number>;
  timingStatus: "passed" | "contains_skips" | "skip_only";
}

export interface LatestTestTimings {
  stepKey: string;
  buildNumber: number;
  commit: string | null;
  finishedAt: string;
  jobIds: string[];
  measurement: "sum_of_pytest_runtest_spans";
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
        cases: 0, outcomes: {}, timingStatus: "passed",
      };
      files.set(key, entry);
    }
    const outcome = row.outcome ?? "unknown";
    entry.observedMs += duration;
    if (outcome === "passed") entry.passedMs += duration;
    entry.cases += 1;
    entry.outcomes[outcome] = (entry.outcomes[outcome] ?? 0) + 1;
  }
  for (const entry of files.values()) {
    entry.timingStatus = !entry.outcomes.passed
      ? "skip_only"
      : entry.cases > entry.outcomes.passed ? "contains_skips" : "passed";
  }
  return [...files.values()].sort((a, b) =>
    a.command === b.command ? a.file.localeCompare(b.file) : a.command.localeCompare(b.command));
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
  // builds where the step passed outright.
  const [build] = await sql<{
    build_number: string; commit: string | null; finished_at: Date; job_ids: string[];
  }[]>`
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
    LIMIT 1
  `;
  if (!build) return null;
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
    WHERE t.job_id = ANY(${build.job_ids})
      AND t.span_attributes->>'ci.span.kind' = 'test'
  `;
  if (rows.length === 0) return null;
  return {
    stepKey,
    buildNumber: Number(build.build_number),
    commit: build.commit,
    finishedAt: new Date(build.finished_at).toISOString(),
    jobIds: build.job_ids,
    measurement: "sum_of_pytest_runtest_spans",
    files: summarizeFiles(rows),
  };
}
