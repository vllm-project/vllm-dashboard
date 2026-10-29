import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { TestSpanRow } from "./latest-test-timings";

const require = createRequire(import.meta.url);

type Build = { build_number: string; commit: string; finished_at: Date; job_ids: string[]; job_ms: number[] };
type Command = { job_id: string; duration_ms: number; label: string };
type Branch = { builds: Build[]; rows: TestSpanRow[]; commands: Command[] };
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

type Statement = { text: string; values: unknown[] };
let current: (strings: TemplateStringsArray, ...values: unknown[]) => unknown = () => {
  throw new Error("no fake installed");
};

// queryLatestTestTimings against a fake sql tag that answers each statement
// from `main` or `treatment` by the branch literal and job ids in it.
async function query(t: test.TestContext, main: Branch, treatment: Branch | "fails") {
  await import("@/lib/db");
  const dbModule = require.cache[require.resolve("@/lib/db")];
  assert.ok(dbModule);
  const originalExports = dbModule.exports;
  const statements: Statement[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const frag: Statement = { text: "", values: [] };
    strings.forEach((s, i) => {
      frag.text += s;
      if (i >= values.length) return;
      const v = values[i] as Statement;
      if (v && typeof v === "object" && "text" in v) {
        frag.text += v.text;
        frag.values.push(...v.values);
      } else {
        frag.text += "?";
        frag.values.push(v);
      }
    });
    if (!frag.text.includes("SELECT")) return frag; // a nested fragment
    statements.push(frag);
    if (frag.text.includes("set_config")) return Promise.resolve([]);
    const source = frag.text.includes("'khluu/otel'") ? treatment : main;
    if (source === "fails") return Promise.reject(new Error("canceling statement due to statement timeout"));
    if (frag.text.includes("buildkite.job")) return Promise.resolve(source.builds);
    const jobIds = frag.values.find(Array.isArray) as string[];
    const all = [main, treatment].filter((b): b is Branch => b !== "fails");
    if (frag.text.includes("LEFT JOIN")) {
      return Promise.resolve(all.flatMap((b) => b.rows).filter((r) => jobIds.includes(r.job_id)));
    }
    return Promise.resolve(all.flatMap((b) => b.commands).filter((c) => jobIds.includes(c.job_id)));
  };
  current = tag;
  // latest-test-timings caches the db module's exports on first load, so
  // install one stable getDb and point it at this call's fake.
  const forward = (strings: TemplateStringsArray, ...values: unknown[]) => current(strings, ...values);
  const stable = Object.assign(forward, {
    begin: async (body: (tx: typeof forward) => Promise<unknown>) => body(forward),
  });
  dbModule.exports = { getDb: () => stable };
  t.after(() => { dbModule.exports = originalExports; });
  const { queryLatestTestTimings } = await import("./latest-test-timings");
  return { result: await queryLatestTestTimings("step-a"), statements };
}

const main = builds([100, [{ id: "main-job", tests: [
  ["pytest old", "tests/test_a.py::one", 60_000],
  ["pytest old", "tests/test_b.py::one", 30_000],
] }]]);

test("main's timings alone when the treatment branch has no builds", async (t) => {
  const { result, statements } = await query(t, main, none);
  assert.ok(result);
  assert.deepEqual(result.files.map((f) => [f.command, f.file, f.observedMs]), [
    ["pytest old", "tests/test_a.py", 60_000],
    ["pytest old", "tests/test_b.py", 30_000],
  ]);
  assert.equal("treatmentBuildNumbers" in result, false);
  assert.deepEqual(result.skippedBuilds, []);
  assert.deepEqual(result.jobIds, ["main-job"]);
  assert.equal(result.measurement, "p80_over_builds_of_summed_pytest_runtest_spans");
  // Main's three statements, then the treatment lookup under its own timeout,
  // which stops at the build query when that branch has no builds.
  assert.equal(statements.length, 5);
  assert.match(statements[0].text, /buildkite\.build\.branch' = 'main'/);
  assert.match(statements[3].text, /set_config\('statement_timeout', \?, true\)/);
  assert.deepEqual(statements[3].values, ["3000"]);
  assert.match(statements[4].text, /buildkite\.build\.branch' = 'khluu\/otel'/);
  // The treatment branch counts only builds where every job of the step
  // passed with test spans, the same rule as main.
  for (const select of [statements[0].text, statements[4].text]) {
    assert.match(select, /HAVING BOOL_AND\(job_state = 'finished' AND job_passed = 'true'\)/);
    assert.match(select, /t\.span_attributes->>'ci\.span\.kind' = 'test'/);
  }
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

test("no main build is still no timings, whatever the treatment branch has", async (t) => {
  const treatment = builds([200, [{ id: "treatment-job", tests: [["pytest new", "tests/test_a.py::one", 1]] }]]);
  const { result, statements } = await query(t, none, treatment);
  assert.equal(result, null);
  assert.equal(statements.length, 1);
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
