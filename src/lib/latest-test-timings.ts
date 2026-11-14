import {
  clickHouseMainEverTimed,
  clickHousePassingBuilds,
  clickHouseTimingSpans,
} from "@/lib/latest-test-timings-clickhouse";

// Per-file test timings for one Buildkite step: the 80th percentile over the
// newest main builds in which every job of the step passed. The runtime shard
// planner reads this as its timing baseline; it must never mistake missing
// telemetry for fast tests. p80 rather than the median: a shard planned at a
// typical run goes over its estimate half the time, and an extra shard costs
// less than one that runs long. Up to three slow builds in twenty still don't
// move it.

export const TIMING_BUILDS = 20;
export const FILE_PERCENTILE = 0.8;

export interface TestSpanRow {
  job_id: string;
  command_span_id: string | null;
  command_label: string | null;
  nodeid: string | null;
  outcome: string | null;
  duration_ms: number;
}

export interface CommandSpanRow {
  job_id: string;
  label: string | null;
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
// file's p80 didn't clear their threshold).
export type FileTimingResponse = Omit<FileTiming, "tests"> & { tests?: TestTiming[] };

export interface LatestTestTimings {
  stepKey: string;
  buildNumber: number;
  commit: string | null;
  finishedAt: string;
  jobIds: string[];
  buildNumbers: number[];
  skippedBuilds: { buildNumber: number; reason: string }[];
  measurement: "p80_over_builds_of_summed_pytest_runtest_spans";
  // What one job spends outside the commands that run its tests: container
  // start, checkout, and setup commands such as pip installs. Median over every job of the builds used,
  // so the planner can charge it once per shard.
  setupMs: number;
  files: FileTiming[];
  // Treatment-branch builds behind files main hasn't timed (behind every file,
  // and the build fields above, when main has never timed the step); absent
  // when none.
  treatmentBuildNumbers?: number[];
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

// Linear interpolation between the closest ranks, as Postgres percentile_cont.
function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  if (below === sorted.length - 1) return sorted[below];
  return sorted[below] + (sorted[below + 1] - sorted[below]) * (position - below);
}

/**
 * Combine summarizeFiles() output from several builds, newest first, into one
 * entry per command and file. Times are p80s over the builds the file ran
 * in; cases, outcomes and status come from the newest of those builds.
 */
export function p80Files(filesPerBuild: FileTiming[][]): FileTiming[] {
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
    // Per-test p80, over only the builds that test appeared in (same rule
    // as the file-level p80 above: a build missing a test doesn't give it
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
      nodeid, observedMs: percentile(times, FILE_PERCENTILE),
    }));
    result.push({
      ...entries[0],
      observedMs: percentile(entries.map((e) => e.observedMs), FILE_PERCENTILE),
      passedMs: percentile(entries.map((e) => e.passedMs), FILE_PERCENTILE),
      builds: entries.length,
      tests,
    });
  }
  return result.sort((a, b) =>
    a.command === b.command ? a.file.localeCompare(b.file) : a.command.localeCompare(b.command));
}

/**
 * Each job's duration less its test commands' durations, in job order. A test
 * command is one whose label has test spans in any build: command spans, not
 * test spans, because a job with thousands of tests can lose test spans (even
 * all of one command's) in upload, and that time is not setup. Commands nest
 * inside their job, so commands that outlast it mean broken spans.
 */
export function setupMsPerJob(
  jobs: { jobId: string; durationMs: number }[],
  commands: CommandSpanRow[],
  testLabels: ReadonlySet<string | null>,
): number[] {
  const testCommandMs = new Map<string, number>();
  for (const command of commands) {
    if (!testLabels.has(command.label)) continue;
    testCommandMs.set(command.job_id, (testCommandMs.get(command.job_id) ?? 0) + Number(command.duration_ms));
  }
  return jobs.map(({ jobId, durationMs }) => {
    const setup = Number(durationMs) - (testCommandMs.get(jobId) ?? 0);
    if (!(setup >= 0)) throw new TimingDataError(`Job ${jobId} is shorter than its test commands`);
    return setup;
  });
}

export function medianSetupMs(setupPerBuild: number[][]): number {
  return percentile(setupPerBuild.flat(), 0.5);
}

/**
 * Keep per-test p80s only for files whose p80 observedMs clears
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

// Builds of the OTel treatment branch (the one branch besides main whose spans
// ingestion accepts, see otel-auth.ts) time a command before it reaches main:
// the step is built there by API at the PR's commit. Their timings are added
// only for command labels main has no timings for, so they never change one
// main has, and they stand alone for a step main has never timed;
// main's own runs replace them once it runs the command. The
// literal is ingestion's default treatment branch and must match the partial
// index predicate in migration 0035.
// The treatment lookup is optional: past this, the response is main's alone.
const TREATMENT_TIMEOUT_MS = 3_000;

export type PassingBuild = {
  build_number: string; commit: string | null; finished_at: Date; job_ids: string[];
  job_ms: number[];
};

/** Main's files, plus the treatment branch's for commands main hasn't timed. */
export function withTreatmentFiles(main: FileTiming[], treatment: FileTiming[]): FileTiming[] {
  const mainCommands = new Set(main.map((file) => file.command));
  const added = treatment.filter((file) => !mainCommands.has(file.command));
  // Each command's files come from one of the two lists, already in file
  // order; the stable sort keeps it.
  return [...main, ...added].sort((a, b) => a.command.localeCompare(b.command));
}

// Where the spans are read from: ClickHouse's ci.otel_spans. CI runs of
// main or the treatment branch only feed the baseline; see
// latest-test-timings-clickhouse.ts for the build-selection rules. Tests pass
// an in-memory store.
export interface TimingStore {
  passingBuilds(treatment: boolean, stepKey: string, days: number | null, queue: string | null): Promise<PassingBuild[]>;
  spans(jobIds: string[]): Promise<{ rows: TestSpanRow[]; commands: CommandSpanRow[] }>;
  mainEverTimed(stepKey: string): Promise<boolean>;
  // Runs fn against a store whose reads give up after TREATMENT_TIMEOUT_MS.
  withTreatmentTimeout<T>(fn: (store: TimingStore) => Promise<T>): Promise<T>;
}

export function clickHouseStore(timeoutMs?: number): TimingStore {
  const options = { timeoutMs };
  return {
    passingBuilds: (treatment, stepKey, days, queue) =>
      clickHousePassingBuilds(treatment, stepKey, days, queue, TIMING_BUILDS, options),
    spans: (jobIds) => clickHouseTimingSpans(jobIds, options),
    mainEverTimed: (stepKey) => clickHouseMainEverTimed(stepKey, options),
    withTreatmentTimeout: (fn) => fn(clickHouseStore(TREATMENT_TIMEOUT_MS)),
  };
}

async function timingsOfBuilds(store: TimingStore, builds: PassingBuild[]) {
  const jobIds = builds.flatMap((build) => build.job_ids);
  const { rows, commands } = await store.spans(jobIds);
  const testLabels = new Set(rows.flatMap((row) => row.command_label ?? []));
  const rowsByJob = new Map<string, TestSpanRow[]>();
  for (const row of rows) {
    const jobRows = rowsByJob.get(row.job_id) ?? [];
    jobRows.push(row);
    rowsByJob.set(row.job_id, jobRows);
  }
  // A build whose spans fail validation was partly lost in ingestion. Leave it
  // out of the baseline rather than failing all of it, and say so.
  const used: PassingBuild[] = [];
  const filesPerBuild: FileTiming[][] = [];
  const setupPerBuild: number[][] = [];
  const skippedBuilds: { buildNumber: number; reason: string }[] = [];
  let firstError: TimingDataError | null = null;
  for (const build of builds) {
    try {
      const buildRows = build.job_ids.flatMap((jobId) => rowsByJob.get(jobId) ?? []);
      const files = summarizeFiles(buildRows);
      const jobs = build.job_ids.map((jobId, i) => ({ jobId, durationMs: build.job_ms[i] }));
      setupPerBuild.push(setupMsPerJob(jobs, commands, testLabels));
      filesPerBuild.push(files);
      used.push(build);
    } catch (e) {
      if (!(e instanceof TimingDataError)) throw e;
      firstError ??= e;
      skippedBuilds.push({ buildNumber: Number(build.build_number), reason: e.message });
    }
  }
  return { used, filesPerBuild, setupPerBuild, skippedBuilds, firstError };
}

type BuildTimings = Pick<
  Awaited<ReturnType<typeof timingsOfBuilds>>, "used" | "setupPerBuild" | "skippedBuilds"
>;

/**
 * The treatment branch's builds and files; null when it has none or the
 * lookup fails. With `untimedOnMain`, also null when main has ever timed the
 * step; that check runs under the same timeout.
 */
async function treatmentTimings(
  store: TimingStore, stepKey: string, days: number, queue: string | null, untimedOnMain = false,
): Promise<(BuildTimings & { files: FileTiming[] }) | null> {
  try {
    return await store.withTreatmentTimeout(async (tx) => {
      if (untimedOnMain && await tx.mainEverTimed(stepKey)) return null;
      const builds = await tx.passingBuilds(true, stepKey, days, queue);
      if (builds.length === 0) return null;
      const { used, filesPerBuild, setupPerBuild, skippedBuilds } = await timingsOfBuilds(tx, builds);
      if (used.length === 0) return null;
      return { used, setupPerBuild, skippedBuilds, files: p80Files(filesPerBuild) };
    });
  } catch (e) {
    console.warn(`Treatment timings for ${stepKey} skipped:`, e);
    return null;
  }
}

function timingsResponse(
  stepKey: string,
  { used, setupPerBuild, skippedBuilds }: BuildTimings,
  files: FileTiming[],
  treatmentBuilds: PassingBuild[] | null,
): LatestTestTimings {
  const [newest] = used;
  return {
    stepKey,
    buildNumber: Number(newest.build_number),
    commit: newest.commit,
    finishedAt: new Date(newest.finished_at).toISOString(),
    jobIds: used.flatMap((build) => build.job_ids),
    buildNumbers: used.map((build) => Number(build.build_number)),
    skippedBuilds,
    measurement: "p80_over_builds_of_summed_pytest_runtest_spans",
    setupMs: medianSetupMs(setupPerBuild),
    files,
    ...(treatmentBuilds
      ? { treatmentBuildNumbers: treatmentBuilds.map((build) => Number(build.build_number)) }
      : {}),
  };
}

export async function queryLatestTestTimings(
  stepKey: string,
  { days = 14, queue = null }: { days?: number; queue?: string | null } = {},
  store: TimingStore = clickHouseStore(),
): Promise<LatestTestTimings | null> {
  let builds = await store.passingBuilds(false, stepKey, days, queue);
  if (builds.length === 0) {
    // A step main has never timed (a script step just turned into pytest)
    // gets the treatment branch's timings alone, until main's first passing
    // run replaces them.
    const treatment = await treatmentTimings(store, stepKey, days, queue, true);
    if (treatment) return timingsResponse(stepKey, treatment, treatment.files, treatment.used);
    // A step main passed only before the window (a job disabled for a while)
    // gets its newest older passing builds, so it shards on its first run
    // back instead of running as one job past its timeout.
    builds = await store.passingBuilds(false, stepKey, null, queue);
    if (builds.length === 0) return null;
  }
  const main = await timingsOfBuilds(store, builds);
  if (main.used.length === 0) throw main.firstError;
  const files = p80Files(main.filesPerBuild);
  const treatment = await treatmentTimings(store, stepKey, days, queue);
  const merged = withTreatmentFiles(files, treatment?.files ?? []);
  return timingsResponse(
    stepKey, main, merged, treatment && merged.length > files.length ? treatment.used : null,
  );
}
