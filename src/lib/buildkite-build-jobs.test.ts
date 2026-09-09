import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getBuildJobRosters } from "./buildkite-build-jobs";

function configureToken(t: TestContext) {
  const saved = process.env.BUILDKITE_API_TOKEN;
  process.env.BUILDKITE_API_TOKEN = "test-token";
  t.after(() => {
    if (saved === undefined) delete process.env.BUILDKITE_API_TOKEN;
    else process.env.BUILDKITE_API_TOKEN = saved;
  });
}

function buildPayload(state: string) {
  return {
    state,
    commit: "abc123",
    branch: "main",
    jobs: [{ name: "Test", state: state === "running" ? "running" : "passed", type: "script" }],
  };
}

function mockBuildkite(t: TestContext, states: Record<string, string>) {
  return t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    const buildNumber = url.split("/builds/")[1];
    const state = states[buildNumber];
    if (!state) return new Response("not found", { status: 404 });
    return Response.json(buildPayload(state));
  });
}

test("settled build rosters are cached; active builds are refetched", async (t) => {
  configureToken(t);
  const fetchMock = mockBuildkite(t, { "1": "passed", "2": "running" });
  const builds = [
    { pipeline: "ci", buildNumber: "1" },
    { pipeline: "ci", buildNumber: "2" },
  ];

  const first = await getBuildJobRosters("vllm", builds);
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(first.get("ci:1")?.jobs.length, 1);
  assert.equal(first.get("ci:2")?.jobs.length, 1);

  const second = await getBuildJobRosters("vllm", builds);
  assert.equal(fetchMock.mock.callCount(), 3, "only the running build is refetched");
  assert.equal(second.get("ci:1")?.jobs.length, 1);
  assert.equal(second.get("ci:2")?.jobs.length, 1);
});

test("failed roster fetches are not cached", async (t) => {
  configureToken(t);
  let calls = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) return new Response("boom", { status: 500 });
    return Response.json(buildPayload("passed"));
  });
  const builds = [{ pipeline: "ci", buildNumber: "9" }];

  const first = await getBuildJobRosters("vllm", builds);
  assert.equal(first.get("ci:9")?.jobs.length, 0, "failure yields an empty roster");

  const second = await getBuildJobRosters("vllm", builds);
  assert.equal(fetchMock.mock.callCount(), 2, "the failed build is retried");
  assert.equal(second.get("ci:9")?.jobs.length, 1);
});

test("concurrent requests for the same build share one fetch", async (t) => {
  configureToken(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json(buildPayload("running"));
  });
  const builds = [{ pipeline: "ci", buildNumber: "7" }];

  const [a, b] = await Promise.all([
    getBuildJobRosters("vllm", builds),
    getBuildJobRosters("vllm", builds),
  ]);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(a.get("ci:7")?.jobs.length, 1);
  assert.equal(b.get("ci:7")?.jobs.length, 1);
});
