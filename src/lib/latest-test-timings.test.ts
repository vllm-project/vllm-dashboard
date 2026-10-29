import assert from "node:assert/strict";
import test from "node:test";
import {
  p80Files, medianSetupMs, setupMsPerJob, summarizeFiles, withTestsOverMs,
  TimingDataError, type TestSpanRow,
} from "./latest-test-timings";

// Interpolated percentiles carry float noise (192.00000000000006).
const rounded = (ms: number) => Math.round(ms * 1e6) / 1e6;

function row(nodeid: string, duration_ms: number, extra: Partial<TestSpanRow> = {}): TestSpanRow {
  return {
    job_id: "job-1", command_span_id: "cmd-a", command_label: "pytest a",
    nodeid, outcome: "passed", duration_ms, ...extra,
  };
}

test("sums cases per command and file, combining shard jobs", () => {
  const files = summarizeFiles([
    row("tests/x/test_a.py::one", 100),
    row("tests/x/test_a.py::two[p]", 50, { job_id: "job-2", command_span_id: "cmd-b" }),
    row("tests/x/test_b.py::one", 7, { outcome: "skipped" }),
    row("tests/x/test_a.py::one", 30, { command_span_id: "cmd-c", command_label: "pytest b" }),
  ]);
  assert.deepEqual(files.map((f) => [f.command, f.file, f.observedMs, f.passedMs, f.cases, f.timingStatus]), [
    ["pytest a", "tests/x/test_a.py", 150, 150, 2, "passed"],
    ["pytest a", "tests/x/test_b.py", 7, 0, 1, "skip_only"],
    ["pytest b", "tests/x/test_a.py", 30, 30, 1, "passed"],
  ]);
});

test("marks files that mix passes and skips", () => {
  const [file] = summarizeFiles([
    row("tests/t.py::a", 10),
    row("tests/t.py::b", 1, { outcome: "skipped" }),
  ]);
  assert.equal(file.timingStatus, "contains_skips");
  assert.deepEqual(file.outcomes, { passed: 1, skipped: 1 });
});

test("rejects data that could masquerade as a usable baseline", () => {
  for (const rows of [
    [row("tests/t.py::a", 1), row("tests/t.py::a", 2, { job_id: "job-2" })],
    [row("tests/t.py::a", -1)],
    [row("tests/t.py::a", Number.NaN)],
    [row("tests/t.py", 1)],
    [row("../t.py::a", 1)],
    [row("tests/t.py::a", 1, { command_span_id: null })],
  ]) {
    assert.throws(() => summarizeFiles(rows), TimingDataError);
  }
});

test("takes each file's p80 over the builds it ran in, interpolating between builds", () => {
  const build = (ms: number, extra: TestSpanRow[] = []) =>
    summarizeFiles([row("tests/a.py::one", ms), ...extra]);
  const files = p80Files([
    build(100, [row("tests/new.py::one", 40, { outcome: "skipped" })]),
    build(300),
    build(110),
    build(120, [row("tests/new.py::one", 10)]),
  ]);
  assert.deepEqual(files.map((f) => [f.file, rounded(f.observedMs), rounded(f.passedMs), f.builds, f.timingStatus]), [
    ["tests/a.py", 192, 192, 4, "passed"],
    ["tests/new.py", 34, 8, 2, "skip_only"],
  ]);
});

test("ignores three slow builds in twenty; a fourth starts raising the estimate", () => {
  const p80Of = (slow: number) => p80Files([...Array(20).keys()].map((i) =>
    summarizeFiles([row("tests/a.py::one", (i < slow ? 30 : 18) * 60_000)])))[0].observedMs;
  // 20 builds put p80 at rank 15.2 of 0..19: four slow builds take ranks 16-19.
  assert.equal(p80Of(3), 18 * 60_000);
  assert.equal(rounded(p80Of(4)), 20.4 * 60_000);
});

test("orders files by command, then file, whichever build saw them first", () => {
  const files = p80Files([
    summarizeFiles([row("tests/z.py::one", 1, { command_label: "pytest b" })]),
    summarizeFiles([
      row("tests/y.py::one", 1), row("tests/x.py::one", 1),
      row("tests/a.py::one", 1, { command_span_id: "cmd-b", command_label: "pytest b" }),
    ]),
  ]);
  assert.deepEqual(files.map((f) => [f.command, f.file]), [
    ["pytest a", "tests/x.py"], ["pytest a", "tests/y.py"],
    ["pytest b", "tests/a.py"], ["pytest b", "tests/z.py"],
  ]);
});

test("a file seen in one build takes that build's time", () => {
  const [file] = p80Files([summarizeFiles([row("tests/a.py::one", 70)])]);
  assert.equal(file.observedMs, 70);
});

test("takes each test's p80 over only the builds it ran in, first-seen order", () => {
  const build = (ms: number, extra: TestSpanRow[] = []) =>
    summarizeFiles([row("tests/a.py::one", ms), ...extra]);
  const [file] = p80Files([
    build(100, [row("tests/a.py::two[p]", 40)]),
    build(300),
    build(110, [row("tests/a.py::two[p]", 20)]),
  ]);
  assert.deepEqual(file.tests, [
    { nodeid: "tests/a.py::one", observedMs: 224 },
    { nodeid: "tests/a.py::two[p]", observedMs: 36 },
  ]);
});

test("a repeated nodeid within one build is an error, same as a repeated case", () => {
  assert.throws(
    () => summarizeFiles([row("tests/t.py::a", 1), row("tests/t.py::a", 2, { job_id: "job-2" })]),
    TimingDataError,
  );
});

test("a test that is always skipped keeps its real duration, not an invented zero", () => {
  const [file] = p80Files([
    summarizeFiles([row("tests/a.py::one", 10), row("tests/a.py::skip", 2, { outcome: "skipped" })]),
    summarizeFiles([row("tests/a.py::one", 12), row("tests/a.py::skip", 4, { outcome: "skipped" })]),
  ]);
  assert.deepEqual(file.tests.find((t) => t.nodeid === "tests/a.py::skip"), {
    nodeid: "tests/a.py::skip", observedMs: 3.6,
  });
});

test("withTestsOverMs keeps tests only strictly over the threshold", () => {
  const [file] = p80Files([summarizeFiles([row("tests/a.py::one", 500)])]);
  assert.equal(withTestsOverMs([file], 500)[0].tests, undefined, "at the threshold: stripped");
  assert.deepEqual(withTestsOverMs([file], 499)[0].tests, [{ nodeid: "tests/a.py::one", observedMs: 500 }]);
});

test("withTestsOverMs strips tests from every file when the param is absent, other fields unchanged", () => {
  const [file] = p80Files([summarizeFiles([row("tests/a.py::one", 500)])]);
  const [response] = withTestsOverMs([file], null);
  assert.ok(!("tests" in response));
  const rest: Record<string, unknown> = { ...file };
  delete rest.tests;
  assert.deepEqual(response, rest);
});

test("setup is each job's time outside its test commands", () => {
  const jobs = [{ jobId: "job-1", durationMs: 1_000 }, { jobId: "job-2", durationMs: 500 }];
  assert.deepEqual(setupMsPerJob(jobs, [
    { job_id: "job-1", label: "pip install x", duration_ms: 50 },
    { job_id: "job-1", label: "pytest a", duration_ms: 800 },
    { job_id: "job-1", label: "pytest b", duration_ms: 120 },
    { job_id: "job-2", label: "pytest a", duration_ms: 450 },
  ], new Set(["pytest a", "pytest b"])), [80, 50]);
});

test("a command counts as a test command by its label, even where it lost every test span", () => {
  // The labels come from every build's test spans, so a pytest command whose
  // spans were all lost in this job still comes off; a pip install never does.
  assert.deepEqual(setupMsPerJob(
    [{ jobId: "job-1", durationMs: 1_000 }],
    [{ job_id: "job-1", label: "pytest a", duration_ms: 900 }, { job_id: "job-1", label: null, duration_ms: 30 }],
    new Set(["pytest a"]),
  ), [100]);
});

test("a job with no test commands is all setup", () => {
  assert.deepEqual(setupMsPerJob([{ jobId: "job-1", durationMs: 700 }], [], new Set()), [700]);
});

test("rejects a job shorter than its test commands, or with no usable duration", () => {
  for (const [durationMs, duration_ms] of [[99, 100], [Number.NaN, 100], [-1, 0], [100, Number.NaN]]) {
    assert.throws(
      () => setupMsPerJob([{ jobId: "job-1", durationMs }], [{ job_id: "job-1", label: "pytest a", duration_ms }], new Set(["pytest a"])),
      (e) => e instanceof TimingDataError && e.message === "Job job-1 is shorter than its test commands",
    );
  }
  assert.deepEqual(setupMsPerJob(
    [{ jobId: "job-1", durationMs: 100 }],
    [{ job_id: "job-1", label: "pytest a", duration_ms: 100 }],
    new Set(["pytest a"]),
  ), [0]);
});

test("setup is the median over every job of every build", () => {
  assert.equal(medianSetupMs([[60_000, 70_000], [1_000_000], [65_000]]), 67_500);
  assert.equal(medianSetupMs([[3], [1, 2]]), 2);
});
