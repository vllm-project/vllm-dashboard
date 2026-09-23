import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { GET } from "./route";

function warehouse(t: TestContext) {
  const keys = ["DATABRICKS_HOST", "DATABRICKS_TOKEN", "DATABRICKS_WAREHOUSE_ID"] as const;
  const saved = keys.map((key) => process.env[key]);
  Object.assign(process.env, {
    DATABRICKS_HOST: "https://warehouse.example", DATABRICKS_TOKEN: "test-token", DATABRICKS_WAREHOUSE_ID: "test-warehouse",
  });
  t.after(() => keys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key];
    else process.env[key] = saved[index];
  }));
}

function runsResponse() {
  return Response.json({
    status: { state: "SUCCEEDED" },
    manifest: { schema: { columns: ["job_id", "state", "is_retry"].map((name) => ({ name })) } },
    result: { data_array: [["original", "failed", "0"], ["retry", "passed", "1"]] },
  });
}

test("retry run route coalesces requests and separates job, pipeline, branch, and range caches", async (t) => {
  warehouse(t);
  let queries = 0;
  t.mock.method(globalThis, "fetch", async () => {
    queries++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return runsResponse();
  });
  const url = "http://localhost/api/jobs/retries/runs?source=databricks&jobName=Basic+Correctness&branch=runs-concurrent&window=14d";
  const responses = await Promise.all(Array.from({ length: 5 }, () => GET(new NextRequest(url))));
  assert.equal(queries, 1);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      source: "databricks", runs: [
        { job_id: "original", state: "failed", is_retry: false },
        { job_id: "retry", state: "passed", is_retry: true },
      ],
    });
  }
  assert.match(responses[0].headers.get("Server-Timing") ?? "", /runs;dur=/);
  assert.match(responses[1].headers.get("Server-Timing") ?? "", /cache;desc="COALESCED"/);
  const cached = await GET(new NextRequest(url));
  assert.match(cached.headers.get("Server-Timing") ?? "", /cache;desc="HIT"/);
  assert.equal(queries, 1);
  for (const [key, value] of [["jobName", "Other job"], ["pipeline", "AMD CI"], ["branch", ""], ["startDate", "2026-09-01"]]) {
    const changed = new URL(url);
    changed.searchParams.set(key, value);
    assert.equal((await GET(new NextRequest(changed))).status, 200);
  }
  assert.equal(queries, 5);
});

test("retry run route validates job and range and binds hostile names with explicit all filters", async (t) => {
  warehouse(t);
  let parameters: Array<{ name: string; value: string }> = [];
  let statement = "";
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    ({ parameters, statement } = JSON.parse(String(init?.body)));
    return runsResponse();
  });
  for (const suffix of ["", "jobName=", "jobName=job&window=100d", "jobName=job&startDate=2026-02-30", "jobName=job&startDate=2026-09-24&endDate=2026-09-22"]) {
    const response = await GET(new NextRequest(`http://localhost/api/jobs/retries/runs?source=databricks&${suffix}`));
    assert.equal(response.status, 400);
  }
  assert.equal(statement, "");
  const hostile = "test' OR 1=1 --";
  const params = new URLSearchParams({ source: "databricks", jobName: hostile, pipeline: "", branch: "",
    startDate: "2026-09-23T10:00Z", endDate: "2026-09-23T11:00Z" });
  const response = await GET(new NextRequest(`http://localhost/api/jobs/retries/runs?${params}`));
  assert.equal(response.status, 200);
  assert.equal(statement.includes(hostile), false);
  assert.deepEqual(parameters.map((p) => [p.name, p.value]), [
    ["startTime", "2026-09-23T10:00:00.000Z"], ["endTime", "2026-09-23T11:00:00.000Z"], ["jobName", hostile],
  ]);
});

test("retry run failures return an error without poisoning the cache", async (t) => {
  warehouse(t);
  t.mock.method(console, "error", () => {});
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? Response.json({}, { status: 503 }) : runsResponse());
  const url = "http://localhost/api/jobs/retries/runs?source=databricks&jobName=recovery&branch=runs-error";
  const error = await GET(new NextRequest(url));
  assert.equal(error.status, 500);
  assert.match(error.headers.get("Server-Timing") ?? "", /cache;desc="ERROR"/);
  assert.equal((await GET(new NextRequest(url))).status, 200);
  assert.equal(calls, 2);
});
