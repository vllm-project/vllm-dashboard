import assert from "node:assert/strict";
import test from "node:test";
import {
  ciBadge,
  ciLine,
  ciWaitsOnAuthor,
  jobLabel,
  mainText,
  safeBuildkiteUrl,
  toTriageCi,
  type TriageCi,
} from "./triage-ci";

function ci(patch: Partial<TriageCi> = {}): TriageCi {
  return {
    head_sha: "21ab14cb702a19808abe9a9c622bb98172718a6e",
    state: "failed",
    build_number: 104586,
    build_url: "https://buildkite.com/vllm/ci/builds/104586",
    build_state: "failed",
    jobs_total: 41,
    jobs_passed: 38,
    jobs_running: 0,
    jobs_failed: 3,
    jobs_failed_on_main: 2,
    jobs_failed_recent_on_main: 0,
    jobs_failed_pr_only: 1,
    main_known: true,
    failed_jobs: [],
    checked_at: null,
    ...patch,
  };
}

test("the CI line says what passed, what runs, and what main shares", () => {
  assert.equal(ciLine(ci()), "38/41 passed · 3 failed (2 also failing on main)");
  assert.equal(ciLine(ci({ jobs_failed: 1, jobs_failed_on_main: 1, jobs_failed_pr_only: 0 })),
    "38/41 passed · 1 failed (also failing on main)");
  assert.equal(ciLine(ci({ jobs_failed_on_main: 0, jobs_failed_recent_on_main: 1, jobs_failed_pr_only: 2 })),
    "38/41 passed · 3 failed (1 flaky on main)");
  assert.equal(ciLine(ci({ jobs_failed_on_main: 0, jobs_failed_pr_only: 3 })), "38/41 passed · 3 failed (only on this PR)");
  assert.equal(ciLine(ci({ main_known: false })), "38/41 passed · 3 failed");
  assert.equal(ciLine(ci({ state: "running", jobs_passed: 20, jobs_running: 18, jobs_failed: 0 })), "20/41 passed · 18 running");
  assert.equal(ciLine(ci({ state: "passed", jobs_passed: 41, jobs_failed: 0 })), "41/41 passed");
  assert.match(ciLine(ci({ state: "not_started" })), /^Not started/);
  assert.equal(mainText(ci({ jobs_failed: 0 })), "");
});

test("whose move mirrors ci_waits_on_author", () => {
  assert.equal(ciWaitsOnAuthor(ci()), true);
  assert.equal(ciWaitsOnAuthor(ci({ jobs_failed_pr_only: 0 })), false); // all main's (now or this week)
  assert.equal(ciWaitsOnAuthor(ci({ state: "running" })), false); // not finished yet
  assert.equal(ciWaitsOnAuthor(ci({ main_known: false })), false); // main unknown: nobody is blamed
  assert.equal(ciWaitsOnAuthor(null), false);
});

test("the row badge: amber when every failure is main's", () => {
  assert.deepEqual(
    [ciBadge(ci()).label, ciBadge(ci()).tone],
    ["CI 3 ✗", "fail"],
  );
  const mains = ciBadge(ci({ jobs_failed_on_main: 3, jobs_failed_pr_only: 0 }));
  assert.deepEqual([mains.label, mains.tone], ["CI 3 ✗ (main)", "main"]);
  assert.equal(mains.title, "CI: 38/41 passed · 3 failed (also failing on main)");
  assert.equal(ciBadge(ci({ state: "passed", jobs_failed: 0 })).label, "CI ✓");
  assert.deepEqual(
    [ciBadge(ci({ state: "running", jobs_passed: 20, jobs_running: 21, jobs_failed: 0 })).label,
     ciBadge(ci({ state: "running", jobs_passed: 20, jobs_running: 21, jobs_failed: 0 })).tone],
    ["CI 20/41", "running"],
  );
  assert.equal(ciBadge(ci({ state: "running" })).label, "CI 3 ✗ · running");
  assert.equal(ciBadge(ci({ state: "not_started" })).label, "CI not run");
});

test("rows from Postgres are read defensively", () => {
  const row = toTriageCi({
    item_key: "vllm-project/vllm#1", head_sha: "abc", state: "failed", build_number: "104586",
    build_url: "https://buildkite.com/vllm/ci/builds/104586", jobs_total: "41", jobs_passed: 38,
    jobs_failed: 3, main_known: true, checked_at: new Date("2026-11-20T09:00:00Z"),
    failed_jobs: [{ name: ":nvidia: LoRA", key: "step:lora|name::nvidia: LoRA", url: "u", count: 2, on_main: true }, { bad: 1 }],
  });
  assert.ok(row);
  assert.equal(row.build_number, 104586);
  assert.equal(row.jobs_total, 41);
  assert.equal(row.jobs_running, 0);
  assert.equal(row.checked_at, "2026-11-20T09:00:00.000Z");
  assert.deepEqual(row.failed_jobs, [
    { name: ":nvidia: LoRA", key: "step:lora|name::nvidia: LoRA", url: "u", count: 2, on_main: true, recent_on_main: false, infra: false },
  ]);
  assert.equal(toTriageCi({ state: "failed" }), null);
  assert.equal(toTriageCi(null), null);
});

test("job labels and links", () => {
  assert.equal(jobLabel(":nvidia: (H200 MIG 18GB) Multimodal Processor"), "(H200 MIG 18GB) Multimodal Processor");
  assert.equal(jobLabel(":docker:"), ":docker:");
  assert.equal(safeBuildkiteUrl("https://buildkite.com/vllm/ci/builds/1#job"), "https://buildkite.com/vllm/ci/builds/1#job");
  assert.equal(safeBuildkiteUrl("https://buildkite.com/evil/x"), null);
  assert.equal(safeBuildkiteUrl("javascript:alert(1)"), null);
  assert.equal(safeBuildkiteUrl(null), null);
});
