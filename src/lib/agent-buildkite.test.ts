import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { AgentApiError, agentBuilds, compactJobs, pipelineIdentity, validateAgentParams } from "./agent-buildkite";
import { queueFreshness } from "./agent-data";

function env(t: TestContext) {
  const saved = { ...process.env };
  process.env.BUILDKITE_API_TOKEN = "test-only";
  process.env.BUILDKITE_ORGANIZATION = "vllm";
  delete process.env.AGENT_BUILDKITE_PIPELINES;
  t.after(() => { process.env = saved; });
}

test("public status reads reject other organizations/pipelines before fetching", async t => {
  env(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected network"); });
  for (const query of ["organization=private", "pipeline=private", "pipeline=..%2Fci", "pipeline=ci%3Fx=1"]) {
    assert.throws(() => pipelineIdentity(new URLSearchParams(query)), AgentApiError);
  }
  await assert.rejects(agentBuilds(new URLSearchParams("buildNumber=1&limit=-1"), true), /limit/);
  assert.equal(calls, 0);
  process.env.AGENT_BUILDKITE_PIPELINES = "ci, public-ci";
  assert.equal(pipelineIdentity(new URLSearchParams("pipeline=public-ci")).pipeline, "public-ci");
});

test("agent parameters fail on typos, repeated values and ambiguous flags", () => {
  for (const query of ["failed=true", "failed=1&failed=1", "attempts=latest", "branch=main", "limit=" + "x".repeat(501)]) {
    assert.throws(() => validateAgentParams("build", new URLSearchParams(query)));
  }
  assert.throws(() => validateAgentParams("missing", new URLSearchParams()));
  assert.doesNotThrow(() => validateAgentParams("build", new URLSearchParams("buildNumber=1&failed=1")));
});

test("build detail retains states, retries and identities but excludes command/env payloads", async t => {
  env(t);
  let requested = "";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requested = url;
    return Response.json({ id: "build-id", number: 10, state: "failed", branch: "main", commit: "abc", web_url: "https://buildkite.com/vllm/ci/builds/10",
      jobs: [
        { id: "old", name: "test", type: "script", state: "failed", retried: true, retried_in_job_id: "new", env: { SECRET: "hidden" }, command: "hidden command" },
        { id: "new", name: "test", type: "script", state: "passed", agent_query_rules: ["queue=l4-k8s"] },
        { id: "blocked", type: "block", state: "blocked" },
        { id: "timeout", type: "script", state: "timed_out", soft_failed: true },
      ] });
  });
  const data = await agentBuilds(new URLSearchParams("buildNumber=10&attempts=all&failed=1&limit=1"), true);
  assert.equal(data.totalJobs, 4);
  assert.deepEqual(data.counts, { failed: 1, passed: 1, blocked: 1, timed_out: 1 });
  assert.equal(data.matchingJobs, 2);
  assert.equal(data.nextOffset, 1);
  assert.equal(data.jobs?.[0].retriedInJobId, "new");
  assert.equal(JSON.stringify(data).includes("hidden"), false);
  assert.match(requested, /include_retried_jobs=true/);
  await agentBuilds(new URLSearchParams("buildNumber=10"), true);
  assert.match(requested, /include_retried_jobs=false/);
  assert.equal(compactJobs([{ id: "1", state: "future_state", type: "script" }])[0].state, "future_state");
});

test("build lists exclude jobs and pipeline payloads and propagate upstream pagination", async t => {
  env(t);
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("exclude_jobs"), "true");
    assert.equal(parsed.searchParams.get("exclude_pipeline"), "true");
    assert.equal(parsed.searchParams.get("branch"), "main");
    assert.equal(options.cache, "no-store");
    return Response.json([{ id: "1", number: 7, state: "running" }], {
      headers: { Link: '<https://api.buildkite.com/v2/organizations/vllm/pipelines/ci/builds?page=3&per_page=5>; rel="next"' },
    });
  });
  const data = await agentBuilds(new URLSearchParams("branch=main&page=2&limit=5"), false);
  assert.equal(data.nextPage, 3);
  assert.equal(data.builds?.[0].number, 7);
});

test("upstream access failures and rate limits never become empty success", async t => {
  env(t);
  t.mock.method(globalThis, "fetch", async () => new Response("private backend error", { status: 429, headers: { "Retry-After": "60" } }));
  await assert.rejects(agentBuilds(new URLSearchParams("buildNumber=10"), true), (e: unknown) => {
    assert.ok(e instanceof AgentApiError); assert.equal(e.status, 429); assert.equal(e.retryAfter, "60");
    assert.equal(e.message.includes("private backend error"), false); return true;
  });
});

test("queue freshness uses observation time, not request time", () => {
  const now = Date.parse("2026-09-12T10:00:00Z");
  assert.deepEqual(queueFreshness("2026-09-12T09:55:00Z", now), { ageSeconds: 300, stale: false });
  assert.deepEqual(queueFreshness("2026-09-12T09:40:00Z", now), { ageSeconds: 1200, stale: true });
});
