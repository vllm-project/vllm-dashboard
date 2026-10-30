import assert from "node:assert/strict";
import test from "node:test";
import {
  componentFigure,
  componentTitle,
  recordingFreshness,
  summarizeDecisions,
  summarizeEpisode,
  type FullRunRecord,
  type RunComponentRecord,
} from "./selector-health";

function component(
  overrides: Partial<RunComponentRecord> & Pick<RunComponentRecord, "component">,
): RunComponentRecord {
  return {
    status: "ok",
    jobState: "passed",
    softFailed: false,
    expectedJobs: null,
    deliveredJobs: null,
    rows: 400,
    verdict: "ok",
    published: true,
    publishedCommit: "665bfc8aaeb7eca008ca4102cbba68efdc4efabb",
    source: "log",
    ...overrides,
  };
}

function run(
  buildNumber: number,
  createdAt: string,
  components: RunComponentRecord[],
  settled = true,
): FullRunRecord {
  return {
    buildNumber,
    kind: createdAt.includes("T06") ? "nightly" : "daily",
    createdAt,
    commitSha: "abc",
    buildState: "failed",
    settled,
    components,
  };
}

const NOW = new Date("2026-10-30T23:45:00Z");

test("freshness reports the newest publish, its lag, and the build PRs use", () => {
  const runs: FullRunRecord[] = [
    run(96933, "2026-10-23T18:00:00Z", [
      component({ component: "fnrec" }),
      component({ component: "kernrec_cuda" }),
      component({ component: "kernrec_rocm", status: "off", published: false }),
    ]),
    run(98403, "2026-10-29T18:00:00Z", [
      component({ component: "fnrec" }),
      component({
        component: "kernrec_cuda",
        status: "broken",
        published: false,
        rows: 0,
        verdict: "no valid table/map pair",
      }),
      component({ component: "kernrec_rocm", rows: 195 }),
    ]),
    run(
      98597,
      "2026-10-30T06:00:00Z",
      [component({ component: "fnrec", status: "pending", published: false })],
      false,
    ),
  ];

  const [fnrec, cuda, rocm] = recordingFreshness(
    runs,
    { windowHours: 6, decisions: 40, fnrecBuild: 98403, kernrecBuild: 96933, latestAt: null },
    NOW,
  );

  assert.equal(fnrec.published?.buildNumber, 98403);
  assert.equal(fnrec.behindHours, 0);
  assert.equal(fnrec.usedBuild, 98403);
  assert.equal(cuda.published?.buildNumber, 96933);
  assert.equal(cuda.behindHours, 144);
  assert.equal(cuda.usedBuild, 96933);
  assert.equal(rocm.published?.buildNumber, 98403);
  assert.equal(rocm.usedBuild, null);
});

test("run cells show rows and delivered/expected jobs, with the verdict on hover", () => {
  const cuda = component({
    component: "kernrec_cuda",
    status: "broken",
    published: false,
    publishedCommit: null,
    rows: 0,
    expectedJobs: 250,
    deliveredJobs: 0,
    verdict: "no recordings delivered",
    jobState: "failed",
    softFailed: true,
    source: "summary",
  });

  assert.equal(componentFigure(cuda), "0 rows · 0/250");
  assert.equal(
    componentTitle(cuda),
    "CUDA kernels: no recordings delivered · job failed (soft-failed) · read from the collect summary",
  );
  assert.equal(componentFigure(component({ component: "fnrec", rows: 1234 })), "1,234 rows");
  assert.equal(componentFigure(component({ component: "map_rocm" })), "uploaded");
  assert.equal(componentFigure(component({ component: "kernrec_rocm", status: "off" })), "off");
  assert.equal(componentFigure(undefined), "—");
});

test("daily decisions group outcomes and count selector errors", () => {
  const days = summarizeDecisions(
    [
      { day: "2026-10-29", outcome: "applied", reason: null, builds: 300 },
      { day: "2026-10-30", outcome: "applied", reason: null, builds: 120 },
      { day: "2026-10-30", outcome: "skipped", reason: "run-all build (label or run_all_patterns)", builds: 9 },
      { day: "2026-10-30", outcome: "skipped", reason: "steps named explicitly by VLLM_CI_ONLY_STEP_KEYS", builds: 30 },
      { day: "2026-10-30", outcome: "fallback", reason: "selector failed: timeout", builds: 4 },
      { day: "2026-10-30", outcome: "fallback", reason: "selector declined: too many files", builds: 2 },
      { day: "2026-10-30", outcome: "missing", reason: null, builds: 5 },
    ],
    [
      { day: "2026-10-30", p50Seconds: 270.2, p95Seconds: 410, ciInfraCommits: ["40a0cb0"] },
    ],
  );

  assert.deepEqual(days.map((day) => day.day), ["2026-10-30", "2026-10-29"]);
  const [today] = days;
  assert.equal(today.total, 170);
  assert.equal(today.applied, 120);
  assert.equal(today.missing, 5);
  assert.equal(today.selectorErrors, 4);
  assert.equal(today.skipped[0].builds, 30);
  assert.equal(today.p95Seconds, 410);
  assert.deepEqual(today.ciInfraCommits, ["40a0cb0"]);
});

test("episodes read as one line", () => {
  const base = {
    alertId: "1",
    status: "open" as const,
    openedAt: "2026-10-24T12:00:00Z",
    resolvedAt: null,
  };
  assert.equal(
    summarizeEpisode({
      ...base,
      condition: "run_incomplete",
      subjectKey: "kernrec_cuda",
      details: { build_number: 97001, verdict: "nothing to fold (0 jobs delivered recordings)" },
    }),
    "CUDA kernel recording not whole in run #97001: nothing to fold (0 jobs delivered recordings).",
  );
  assert.equal(
    summarizeEpisode({
      ...base,
      condition: "stale",
      subjectKey: "kernrec_cuda",
      details: { stale_hours: 36, last_published: { build_number: 96933 } },
    }),
    "CUDA kernel recording last published by #96933, 36 h before the newest completed run.",
  );
  assert.equal(
    summarizeEpisode({
      ...base,
      condition: "pr_errors",
      subjectKey: "selector",
      details: { errors: 6, builds: 100, rate: 0.06 },
    }),
    "6 of 100 PR builds (6.0%) fell back on a selector error.",
  );
});
