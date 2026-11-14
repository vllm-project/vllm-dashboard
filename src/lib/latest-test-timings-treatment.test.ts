import assert from "node:assert/strict";
import test from "node:test";
import { queryLatestTestTimings, type TestSpanRow, type TimingStore } from "./latest-test-timings";

type Build = { build_number: string; commit: string; finished_at: Date; job_ids: string[]; job_ms: number[] };
type Command = { job_id: string; duration_ms: number; label: string };
// timedBefore: main recorded test spans for the step outside the passing builds
// (an older or failed run); "fails" makes that lookup time out. older: passing
// builds from before the time window, which only an unwindowed lookup sees.
type Branch = {
  builds: Build[]; rows: TestSpanRow[]; commands: Command[]; timedBefore?: boolean | "fails"; older?: Build[];
};
// One job: its test spans as [command label, nodeid, ms], and its setup.
type Job = { id: string; tests: [string | null, string, number][]; setupMs?: number };

const none: Branch = { builds: [], rows: [], commands: [] };

/** Builds of one branch, newest first, each with its jobs. */
function builds(...list: [number, Job[]][]): Branch {
  const branch: Branch = { builds: [], rows: [], commands: [] };
  for (const [number, jobs] of list) {
    branch.builds.push({
      build_number: String(number), commit: `c${number}`, finished_at: new Date(0),
      job_ids: jobs.map((job) => job.id),
      job_ms: jobs.map((job) => job.tests.reduce((sum, [, , ms]) => sum + ms, job.setupMs ?? 1_000)),
    });
    for (const job of jobs) {
      for (const [label, nodeid, ms] of job.tests) {
        branch.rows.push({
          job_id: job.id, command_span_id: label && `${job.id}:${label}`, command_label: label,
          nodeid, outcome: "passed", duration_ms: ms,
        });
      }
      for (const label of new Set(job.tests.flatMap(([l]) => l ?? []))) {
        const ms = job.tests.filter(([l]) => l === label).reduce((sum, [, , t]) => sum + t, 0);
        branch.commands.push({ job_id: job.id, label, duration_ms: ms });
      }
    }
  }
  return branch;
}

// queryLatestTestTimings against an in-memory store answering from `main` or
// `treatment`. Each read is logged as "<op>[:<branch>][:<days|all>]", with a
// ":t" suffix when it runs under the treatment timeout.
function fakeStore(main: Branch, treatment: Branch | "fails", calls: string[], timed = false): TimingStore {
  const suffix = timed ? ":t" : "";
  const fail = () => new Error("Timeout exceeded: elapsed 3 seconds");
  return {
    async passingBuilds(isTreatment, stepKey, days) {
      assert.equal(stepKey, "step-a");
      calls.push(`builds:${isTreatment ? "treatment" : "main"}:${days ?? "all"}${suffix}`);
      const source = isTreatment ? treatment : main;
      if (source === "fails") throw fail();
      return days === null ? (source.older ?? []) : source.builds;
    },
    async spans(jobIds) {
      calls.push(`spans${suffix}`);
      const all = [main, treatment].filter((b): b is Branch => b !== "fails");
      return {
        rows: all.flatMap((b) => b.rows).filter((r) => jobIds.includes(r.job_id)),
        commands: all.flatMap((b) => b.commands).filter((c) => jobIds.includes(c.job_id)),
      };
    },
    async mainEverTimed(stepKey) {
      calls.push(`timed:${stepKey}${suffix}`);
      if (main.timedBefore === "fails") throw fail();
      return main.timedBefore ?? main.builds.length > 0;
    },
    async withTreatmentTimeout(fn) {
      calls.push("timeout");
      return fn(fakeStore(main, treatment, calls, true));
    },
  };
}

async function query(_t: test.TestContext, main: Branch, treatment: Branch | "fails") {
  const calls: string[] = [];
  const result = await queryLatestTestTimings("step-a", {}, fakeStore(main, treatment, calls));
  return { result, calls };
}

const main = builds([100, [{ id: "main-job", tests: [
  ["pytest old", "tests/test_a.py::one", 60_000],
  ["pytest old", "tests/test_b.py::one", 30_000],
] }]]);

test("main's timings alone when the treatment branch has no builds", async (t) => {
  const { result, calls } = await query(t, main, none);
  assert.ok(result);
  assert.deepEqual(result.files.map((f) => [f.command, f.file, f.observedMs]), [
    ["pytest old", "tests/test_a.py", 60_000],
    ["pytest old", "tests/test_b.py", 30_000],
  ]);
  assert.equal("treatmentBuildNumbers" in result, false);
  assert.deepEqual(result.skippedBuilds, []);
  assert.deepEqual(result.jobIds, ["main-job"]);
  assert.equal(result.measurement, "p80_over_builds_of_summed_pytest_runtest_spans");
  // Main's builds and spans, then the treatment lookup under its own timeout,
  // which stops at the build query when that branch has no builds.
  assert.deepEqual(calls, ["builds:main:14", "spans", "timeout", "builds:treatment:14:t"]);
});

test("adds treatment files only for commands main hasn't timed", async (t) => {
  const treatment = builds([200, [{ id: "treatment-job", tests: [
    ["pytest old", "tests/test_a.py::one", 999_000],
    ["pytest new", "tests/test_a.py::one", 61_000],
    ["pytest new", "tests/test_c.py::one", 5_000],
  ] }]]);
  const { result } = await query(t, main, treatment);
  assert.ok(result);
  assert.deepEqual(result.files.map((f) => [f.command, f.file, f.observedMs]), [
    ["pytest new", "tests/test_a.py", 61_000],
    ["pytest new", "tests/test_c.py", 5_000],
    ["pytest old", "tests/test_a.py", 60_000],
    ["pytest old", "tests/test_b.py", 30_000],
  ]);
  assert.deepEqual(result.treatmentBuildNumbers, [200]);
  // Main's builds, jobs, setup and newest build are untouched.
  assert.deepEqual(result.buildNumbers, [100]);
  assert.deepEqual(result.jobIds, ["main-job"]);
  assert.equal(result.buildNumber, 100);
  assert.equal(result.setupMs, 1_000);
});

test("a treatment branch timing only main's commands changes nothing", async (t) => {
  const alone = (await query(t, main, none)).result;
  const treatment = builds([200, [{ id: "treatment-job", tests: [["pytest old", "tests/test_b.py::one", 1]] }]]);
  assert.deepEqual((await query(t, main, treatment)).result, alone);
});

test("a failed or timed-out treatment lookup returns main's timings unchanged", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const alone = (await query(t, main, none)).result;
  assert.deepEqual((await query(t, main, "fails")).result, alone);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /step-a/);
});

test("a step main has no build for gets the treatment branch's timings alone", async (t) => {
  const treatment = builds(
    [201, [{ id: "t-new", tests: [["pytest new", "tests/test_a.py::one", 61_000]], setupMs: 3_000 }]],
    [200, [{ id: "t-old", tests: [["pytest new", "tests/test_a.py::one", 59_000]], setupMs: 5_000 }]],
  );
  const { result, calls } = await query(t, none, treatment);
  assert.ok(result);
  assert.deepEqual(result.files.map((f) => [f.command, f.file, f.builds]), [
    ["pytest new", "tests/test_a.py", 2],
  ]);
  assert.equal(result.buildNumber, 201);
  assert.equal(result.commit, "c201");
  assert.deepEqual(result.buildNumbers, [201, 200]);
  assert.deepEqual(result.treatmentBuildNumbers, [201, 200]);
  assert.deepEqual(result.jobIds, ["t-new", "t-old"]);
  assert.equal(result.setupMs, 4_000);
  // Main's build query finds nothing; the check that main never timed the
  // step and the treatment lookup run under the treatment timeout.
  assert.deepEqual(calls, ["builds:main:14", "timeout", "timed:step-a:t", "builds:treatment:14:t", "spans:t"]);
});

test("a step main timed before, but not lately, gets no treatment fallback", async (t) => {
  const treatment = builds([200, [{ id: "treatment-job", tests: [["pytest new", "tests/test_a.py::one", 1]] }]]);
  const { result, calls } = await query(t, { ...none, timedBefore: true }, treatment);
  assert.equal(result, null);
  // The treatment branch is never read; main's unwindowed lookup finds no
  // passing build either.
  assert.deepEqual(calls, ["builds:main:14", "timeout", "timed:step-a:t", "builds:main:all"]);
});

test("a step main passed only before the window gets its newest older builds", async (t) => {
  // A job disabled for longer than the window: its last passing main runs
  // are older than 14 days, so the windowed lookup finds none.
  const past = builds(
    [97156, [{ id: "old-new", tests: [["pytest q", "tests/test_q.py::one", 60_000]], setupMs: 2_000 }]],
    [97100, [{ id: "old-old", tests: [["pytest q", "tests/test_q.py::one", 40_000]], setupMs: 4_000 }]],
  );
  const { result, calls } = await query(t, { ...past, builds: [], timedBefore: true, older: past.builds }, none);
  assert.ok(result);
  assert.equal(result.buildNumber, 97156);
  assert.deepEqual(result.buildNumbers, [97156, 97100]);
  assert.deepEqual(result.jobIds, ["old-new", "old-old"]);
  assert.deepEqual(result.files.map((f) => [f.command, f.file, f.builds]), [["pytest q", "tests/test_q.py", 2]]);
  assert.equal(result.setupMs, 3_000);
  assert.equal("treatmentBuildNumbers" in result, false);
  // The same passing-build rule on main, without the window.
  assert.deepEqual(calls, [
    "builds:main:14", "timeout", "timed:step-a:t", "builds:main:all", "spans",
    "timeout", "builds:treatment:14:t",
  ]);
});

test("a failed check of main's history is no timings, not a fallback", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const treatment = builds([200, [{ id: "treatment-job", tests: [["pytest new", "tests/test_a.py::one", 1]] }]]);
  assert.equal((await query(t, { ...none, timedBefore: "fails" }, treatment)).result, null);
  assert.equal(warn.mock.callCount(), 1);
});

test("no main build and no treatment build is no timings", async (t) => {
  const { result, calls } = await query(t, none, none);
  assert.equal(result, null);
  // Main in the window, the treatment lookup (timeout, check, builds), then
  // main without the window.
  assert.deepEqual(calls, ["builds:main:14", "timeout", "timed:step-a:t", "builds:treatment:14:t", "builds:main:all"]);
});

test("no main build and a failed treatment lookup is no timings, not an error", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal((await query(t, none, "fails")).result, null);
  assert.equal(warn.mock.callCount(), 1);
});

test("no main build and only broken treatment builds is no timings", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const broken = builds([200, [{ id: "broken", tests: [[null, "tests/test_a.py::one", 10]] }]]);
  assert.equal((await query(t, none, broken)).result, null);
  assert.equal(warn.mock.callCount(), 0);
});

test("a main build with broken spans is skipped and named", async (t) => {
  const mixed = builds(
    [101, [{ id: "good", tests: [["pytest old", "tests/test_a.py::one", 10]] }]],
    [100, [{ id: "broken", tests: [[null, "tests/test_a.py::one", 10]] }]],
  );
  const { result } = await query(t, mixed, none);
  assert.ok(result);
  assert.deepEqual(result.buildNumbers, [101]);
  assert.deepEqual(result.skippedBuilds, [{ buildNumber: 100, reason: "Test span without a parent command" }]);
});

test("main builds with only broken spans are an error, not empty timings", async (t) => {
  const broken = builds([100, [{ id: "broken", tests: [[null, "tests/test_a.py::one", 10]] }]]);
  await assert.rejects(query(t, broken, none), /Test span without a parent command/);
});

test("an unexpected error in a main build fails the request instead of skipping it", async (t) => {
  const odd = builds(
    [101, [{ id: "good", tests: [["pytest old", "tests/test_a.py::one", 10]] }]],
    [100, [{ id: "odd", tests: [["pytest old", "tests/test_a.py::one", 10]] }]],
  );
  odd.rows[1].nodeid = 5 as unknown as string; // not a string: a bug, not lost telemetry
  await assert.rejects(query(t, odd, none), TypeError);
});

test("each build's setup subtracts only its own jobs' commands", async (t) => {
  const two = builds(
    [101, [{ id: "j1", tests: [["pytest old", "tests/test_a.py::one", 50_000]], setupMs: 2_000 }]],
    [100, [
      { id: "j2", tests: [["pytest old", "tests/test_a.py::one", 40_000]], setupMs: 4_000 },
      // A shard job whose tests all ran elsewhere: no test spans, all setup.
      { id: "j3", tests: [], setupMs: 6_000 },
    ]],
  );
  const { result } = await query(t, two, none);
  assert.ok(result);
  assert.deepEqual(result.buildNumbers, [101, 100]);
  assert.equal(result.setupMs, 4_000);
});
