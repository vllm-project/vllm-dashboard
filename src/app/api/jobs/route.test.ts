import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { NextRequest } from "next/server";
import { GET } from "./route";

function configureWarehouse(t: TestContext) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    DATABRICKS_HOST: "https://warehouse.example",
    DATABRICKS_TOKEN: "test-token",
    DATABRICKS_WAREHOUSE_ID: "test-warehouse",
  });
  t.after(() => {
    for (const key of ["DATABRICKS_HOST", "DATABRICKS_TOKEN", "DATABRICKS_WAREHOUSE_ID"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test("concurrent jobs requests share queries and expose cache/query timings", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json({
      status: { state: "SUCCEEDED" },
      manifest: { schema: { columns: [{ name: "name" }] } },
      result: { data_array: [["test job"]] },
    });
  });
  configureWarehouse(t);
  const url = "http://localhost/api/jobs?source=databricks&branch=concurrent-test";
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => GET(new NextRequest(url))),
  );
  assert.equal(fetchMock.mock.callCount(), 2, "one failure query and one duration query for all eight callers");
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      failureRanking: [{ name: "test job" }],
      durationStats: [{ name: "test job" }],
    });
    assert.match(response.headers.get("Server-Timing") ?? "", /source;desc="databricks"/);
  }
  assert.match(responses[0].headers.get("Server-Timing") ?? "", /failures;dur=/);
  assert.match(responses[0].headers.get("Server-Timing") ?? "", /duration;dur=/);
  assert.match(responses[1].headers.get("Server-Timing") ?? "", /cache;desc="COALESCED"/);
  const cached = await GET(new NextRequest(url));
  assert.match(cached.headers.get("Server-Timing") ?? "", /cache;desc="HIT"/);
  assert.doesNotMatch(cached.headers.get("Server-Timing") ?? "", /failures;dur=/);
  assert.equal(fetchMock.mock.callCount(), 2);

  await GET(new NextRequest(`${url}&pipeline=AMD+CI`));
  assert.equal(fetchMock.mock.callCount(), 4, "different filters need their own queries");

});


test("a relative window uses one stable cache key across resolved dates", async (t) => {
  configureWarehouse(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      status: { state: "SUCCEEDED" },
      manifest: { schema: { columns: [{ name: "name" }] } },
      result: { data_array: [["test job"]] },
    }),
  );
  const url = "http://localhost/api/jobs?source=databricks&branch=window-test&window=14d";

  const first = await GET(new NextRequest(url));
  assert.equal(first.status, 200);
  assert.match(first.headers.get("Server-Timing") ?? "", /cache;desc="MISS"/);
  assert.equal(fetchMock.mock.callCount(), 2);

  const second = await GET(new NextRequest(url));
  assert.match(second.headers.get("Server-Timing") ?? "", /cache;desc="HIT"/);
  assert.equal(fetchMock.mock.callCount(), 2, "the stable window key must not requery");

  const custom = await GET(new NextRequest(`${url}&startDate=2026-09-01&endDate=2026-09-08`));
  assert.equal(custom.status, 200);
  assert.equal(fetchMock.mock.callCount(), 4, "explicit dates use their own key");

  const invalid = await GET(new NextRequest("http://localhost/api/jobs?source=databricks&branch=window-test&window=abc"));
  assert.equal(invalid.status, 200);
  assert.equal(fetchMock.mock.callCount(), 6, "an invalid window falls back to the no-range key");
});

test("a partial query failure keeps the fill shared until the other query settles", async (t) => {
  configureWarehouse(t);
  t.mock.method(console, "error", () => {});
  const duration = Promise.withResolvers<void>();
  let fail = true;
  const fetchMock = t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { statement } = JSON.parse(String(init?.body));
    if (statement.includes("p50_duration")) await duration.promise;
    else if (fail) return Response.json({}, { status: 503 });
    return Response.json({ status: { state: "SUCCEEDED" } });
  });
  const url = "http://localhost/api/jobs?source=databricks&branch=partial-failure-test";
  let finished = false;
  const first = GET(new NextRequest(url)).then((response) => {
    finished = true;
    return response;
  });
  try {
    await setImmediate();
    assert.equal(finished, false, "do not release the fill while its duration query is still running");
    const follower = GET(new NextRequest(url));
    await setImmediate();
    assert.equal(fetchMock.mock.callCount(), 2, "a follower must not launch more queries after a partial failure");
    duration.resolve();
    const [response, shared] = await Promise.all([first, follower]);
    assert.equal(response.status, 500);
    assert.equal(shared.status, 500);
    assert.match(response.headers.get("Server-Timing") ?? "", /duration;dur=/);
    assert.match(response.headers.get("Server-Timing") ?? "", /cache;desc="ERROR"/);
    fail = false;
    const retry = await GET(new NextRequest(url));
    assert.equal(retry.status, 200);
    assert.equal(fetchMock.mock.callCount(), 4, "a fully settled failure can be retried");
  } finally {
    duration.resolve();
    await first;
  }
});
