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

function statsResponse() {
  return Response.json({
    status: { state: "SUCCEEDED" },
    manifest: { schema: { columns: ["name", "retries", "total_runs", "has_soft_fail"].map((name) => ({ name })) } },
    result: { data_array: [["Basic Correctness", "2", "5", "0"]] },
  });
}

test("retry ranking returns individual job rows without fetching test-area mappings from GitHub", async (t) => {
  warehouse(t);
  const name = ":amd: (MI300) MoE Kernels Shard 1";
  const requestedUrls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    requestedUrls.push(url);
    assert.ok(url.startsWith("https://warehouse.example"), `Unexpected request: ${url}`);
    return Response.json({
      status: { state: "SUCCEEDED" },
      manifest: { schema: { columns: ["name", "retries", "total_runs", "has_soft_fail"].map(name => ({ name })) } },
      result: { data_array: [[name, "2", "5", "0"]] },
    });
  });
  const response = await GET(new NextRequest("http://localhost/api/jobs/retries?source=databricks&branch=first-job-request"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).retryRanking, [{ name, retries: 2, total_runs: 5, has_soft_fail: false }]);
  assert.equal(requestedUrls.length, 1);
  assert.doesNotMatch(response.headers.get("Server-Timing") ?? "", /mapping;/);
});

test("retry requests share one query and stable window cache, with source and job counts", async (t) => {
  warehouse(t);
  let queries = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    assert.ok(String(input).startsWith("https://warehouse.example"));
    queries++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return statsResponse();
  });
  t.mock.method(console, "error", () => {});
  const url = "http://localhost/api/jobs/retries?source=databricks&branch=retry-concurrent&window=14d";
  const responses = await Promise.all(Array.from({ length: 5 }, () => GET(new NextRequest(url))));
  assert.equal(queries, 1);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      source: "databricks",
      retryRanking: [{ name: "Basic Correctness", retries: 2, total_runs: 5, has_soft_fail: false }],
    });
  }
  assert.match(responses[0].headers.get("Server-Timing") ?? "", /retries;dur=/);
  assert.match(responses[1].headers.get("Server-Timing") ?? "", /cache;desc="COALESCED"/);
  const cached = await GET(new NextRequest(url));
  assert.match(cached.headers.get("Server-Timing") ?? "", /cache;desc="HIT"/);
  assert.equal(queries, 1);
  await GET(new NextRequest(`${url}&pipeline=AMD+CI`));
  await GET(new NextRequest(`${url}&startDate=2026-09-01&endDate=2026-09-02`));
  assert.equal(queries, 3);
});

test("retry route rejects invalid bounds before querying and binds explicit all filters", async (t) => {
  warehouse(t);
  let parameters: Array<{ name: string; value: string }> = [];
  let statement = "";
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    ({ parameters, statement } = JSON.parse(String(init?.body)));
    return statsResponse();
  });
  for (const suffix of ["startDate=2026-02-30", "window=100d", "startDate=2026-09-24&endDate=2026-09-22"]) {
    const response = await GET(new NextRequest(`http://localhost/api/jobs/retries?source=databricks&${suffix}`));
    assert.equal(response.status, 400);
  }
  assert.equal(statement, "");
  const all = await GET(new NextRequest("http://localhost/api/jobs/retries?source=databricks&pipeline=&branch=&startDate=2026-09-23T10:00Z&endDate=2026-09-23T11:00Z"));
  assert.equal(all.status, 200);
  assert.deepEqual(parameters.map((p) => [p.name, p.value]), [
    ["startTime", "2026-09-23T10:00:00.000Z"], ["endTime", "2026-09-23T11:00:00.000Z"],
  ]);
});

test("retry backend errors are not cached and a following request can recover", async (t) => {
  warehouse(t);
  t.mock.method(console, "error", () => {});
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? Response.json({}, { status: 503 }) : statsResponse());
  const url = "http://localhost/api/jobs/retries?source=databricks&branch=retry-error";
  const error = await GET(new NextRequest(url));
  assert.equal(error.status, 500);
  assert.match(error.headers.get("Server-Timing") ?? "", /cache;desc="ERROR"/);
  assert.equal((await GET(new NextRequest(url))).status, 200);
  assert.equal(calls, 2);
});
