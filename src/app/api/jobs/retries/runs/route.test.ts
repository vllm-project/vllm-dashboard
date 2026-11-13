import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { GET } from "./route";

function warehouse(t: TestContext) {
  const keys = ["CLICKHOUSE_URL", "CLICKHOUSE_READ_USER", "CLICKHOUSE_READ_PASSWORD"] as const;
  const saved = keys.map((key) => process.env[key]);
  Object.assign(process.env, {
    CLICKHOUSE_URL: "https://warehouse.example", CLICKHOUSE_READ_USER: "test-user", CLICKHOUSE_READ_PASSWORD: "test-password",
  });
  t.after(() => keys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key];
    else process.env[key] = saved[index];
  }));
}

/** A ClickHouse JSONStringsEachRow response body. */
function rowsResponse(rows: Record<string, string>[]) {
  return new Response(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

/** The bound `param_<name>` values of a ClickHouse request, in order. */
function boundParams(input: Parameters<typeof fetch>[0]) {
  return [...new URL(String(input)).searchParams].filter(([name]) => name.startsWith("param_"))
    .map(([name, value]) => [name.slice("param_".length), value]);
}

function runsResponse() {
  return rowsResponse([
    { job_id: "original", state: "failed", is_retry: "0" },
    { job_id: "retry", state: "passed", is_retry: "1" },
  ]);
}

test("retry run route coalesces requests and separates job, pipeline, branch, and range caches", async (t) => {
  warehouse(t);
  let queries = 0;
  t.mock.method(globalThis, "fetch", async () => {
    queries++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return runsResponse();
  });
  const url = "http://localhost/api/jobs/retries/runs?source=clickhouse&jobName=Basic+Correctness&branch=runs-concurrent&window=14d";
  const responses = await Promise.all(Array.from({ length: 5 }, () => GET(new NextRequest(url))));
  assert.equal(queries, 1);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      source: "clickhouse", runs: [
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
  let parameters: string[][] = [];
  let statement = "";
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    parameters = boundParams(input);
    statement = String(init?.body);
    return runsResponse();
  });
  for (const suffix of ["", "jobName=", "jobName=job&window=100d", "jobName=job&startDate=2026-02-30", "jobName=job&startDate=2026-09-24&endDate=2026-09-22"]) {
    const response = await GET(new NextRequest(`http://localhost/api/jobs/retries/runs?source=clickhouse&${suffix}`));
    assert.equal(response.status, 400);
  }
  assert.equal(statement, "");
  const hostile = "test' OR 1=1 --";
  const params = new URLSearchParams({ source: "clickhouse", jobName: hostile, pipeline: "", branch: "",
    startDate: "2026-09-23T10:00Z", endDate: "2026-09-23T11:00Z" });
  const response = await GET(new NextRequest(`http://localhost/api/jobs/retries/runs?${params}`));
  assert.equal(response.status, 200);
  assert.equal(statement.includes(hostile), false);
  assert.deepEqual(parameters, [
    ["startTime", "2026-09-23T10:00:00.000Z"], ["endTime", "2026-09-23T11:00:00.000Z"], ["jobName", hostile],
  ]);
});

test("retry run failures return an error without poisoning the cache", async (t) => {
  warehouse(t);
  t.mock.method(console, "error", () => {});
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? new Response("unavailable", { status: 503 }) : runsResponse());
  const url = "http://localhost/api/jobs/retries/runs?source=clickhouse&jobName=recovery&branch=runs-error";
  const error = await GET(new NextRequest(url));
  assert.equal(error.status, 500);
  assert.match(error.headers.get("Server-Timing") ?? "", /cache;desc="ERROR"/);
  assert.equal((await GET(new NextRequest(url))).status, 200);
  assert.equal(calls, 2);
});
