import assert from "node:assert/strict";
import test from "node:test";
import { medianFiles, summarizeFiles, TimingDataError, type TestSpanRow } from "./latest-test-timings";

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

test("takes each file's median over the builds it ran in", () => {
  const build = (ms: number, extra: TestSpanRow[] = []) =>
    summarizeFiles([row("tests/a.py::one", ms), ...extra]);
  const files = medianFiles([
    build(100, [row("tests/new.py::one", 40, { outcome: "skipped" })]),
    build(300),
    build(110),
    build(120, [row("tests/new.py::one", 10)]),
  ]);
  assert.deepEqual(files.map((f) => [f.file, f.observedMs, f.passedMs, f.builds, f.timingStatus]), [
    ["tests/a.py", 115, 115, 4, "passed"],
    ["tests/new.py", 25, 5, 2, "skip_only"],
  ]);
});

test("ignores a run of slow builds that stays a minority", () => {
  const files = medianFiles([30, 30, 30, 18, 18, 18, 18].map((min) =>
    summarizeFiles([row("tests/a.py::one", min * 60_000)])));
  assert.equal(files[0].observedMs, 18 * 60_000);
});
