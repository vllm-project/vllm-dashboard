import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getOrLoadCached } from "./api-cache";
import { DatabricksIncompleteResultError, queryDatabricks } from "./databricks";

function configureWarehouse(t: TestContext) {
  const keys = ["DATABRICKS_HOST", "DATABRICKS_TOKEN", "DATABRICKS_WAREHOUSE_ID"] as const;
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, {
    DATABRICKS_HOST: "https://warehouse.example",
    DATABRICKS_TOKEN: "test-token",
    DATABRICKS_WAREHOUSE_ID: "test-warehouse",
  });
  t.after(() => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  }));
}

for (const state of ["RUNNING", "PENDING", "CANCELED"]) {
  test(`Databricks ${state} results cannot be cached as an empty ranking`, async (t) => {
    configureWarehouse(t);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return Response.json(requests === 1 ? { status: { state } } : {
        status: { state: "SUCCEEDED" },
        manifest: { schema: { columns: [{ name: "retries" }] } },
        result: { data_array: [["2"]] },
      });
    });
    const load = () => getOrLoadCached(`databricks-state-test:${state}`, 60_000,
      () => queryDatabricks<{ retries: string }>("SELECT retries FROM jobs"));

    await assert.rejects(load, new RegExp(`did not complete \\(state: ${state}\\)`));
    const recovered = await load();
    assert.equal(recovered.status, "MISS");
    assert.deepEqual(recovered.data, [{ retries: "2" }]);
    assert.equal((await load()).status, "HIT");
    assert.equal(requests, 2);
  });
}

test("a successful empty Databricks result remains cacheable", async (t) => {
  configureWarehouse(t);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({
      status: { state: "SUCCEEDED" },
      manifest: { schema: { columns: [{ name: "retries" }] } },
      result: { data_array: [] },
    });
  });
  const load = () => getOrLoadCached("databricks-state-test:empty", 60_000,
    () => queryDatabricks("SELECT retries FROM jobs WHERE false"));
  assert.deepEqual((await load()).data, []);
  assert.equal((await load()).status, "HIT");
  assert.equal(requests, 1);
});

test("Databricks failures retain the warehouse error message", async (t) => {
  configureWarehouse(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({
    status: { state: "FAILED", error: { message: "Warehouse unavailable" } },
  }));
  await assert.rejects(() => queryDatabricks("SELECT 1"), /Query failed: Warehouse unavailable/);
});

test("Databricks responses with a missing statement state are rejected", async (t) => {
  configureWarehouse(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await assert.rejects(() => queryDatabricks("SELECT 1"), /did not complete \(state: unknown\)/);
});

const incompleteResults = [
  { name: "truncated", manifest: { truncated: true }, result: {} },
  { name: "chunk manifest without links", manifest: { total_chunk_count: 2, total_row_count: 2 }, result: {} },
  { name: "missing rows", manifest: { total_row_count: 2 }, result: {} },
];

test("Databricks multi-chunk results follow chunk links", async (t) => {
  configureWarehouse(t);
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    if (url.endsWith("/chunks/1")) {
      return Response.json({
        chunk_index: 1, data_array: [["job-b"]],
        next_chunk_internal_link: "/api/2.0/sql/statements/s1/result/chunks/2",
      });
    }
    if (url.endsWith("/chunks/2")) {
      return Response.json({ chunk_index: 2, data_array: [["job-c"]] });
    }
    return Response.json({
      status: { state: "SUCCEEDED" },
      manifest: {
        schema: { columns: [{ name: "job_id" }] },
        truncated: false, total_chunk_count: 3, total_row_count: 3,
      },
      result: {
        chunk_index: 0, data_array: [["job-a"]],
        next_chunk_index: 1,
        next_chunk_internal_link: "/api/2.0/sql/statements/s1/result/chunks/1",
      },
    });
  });
  const rows = await queryDatabricks<{ job_id: string }>("SELECT job_id FROM jobs");
  assert.deepEqual(rows.map((row) => row.job_id), ["job-a", "job-b", "job-c"]);
  assert.deepEqual(urls.slice(1), [
    "https://warehouse.example/api/2.0/sql/statements/s1/result/chunks/1",
    "https://warehouse.example/api/2.0/sql/statements/s1/result/chunks/2",
  ]);
});

test("Databricks chunk fetch failures are surfaced", async (t) => {
  configureWarehouse(t);
  t.mock.method(globalThis, "fetch", async (url: string) => url.includes("/chunks/")
    ? new Response("gone", { status: 404 })
    : Response.json({
      status: { state: "SUCCEEDED" },
      manifest: { schema: { columns: [{ name: "job_id" }] }, total_row_count: 2 },
      result: {
        data_array: [["job-a"]],
        next_chunk_internal_link: "/api/2.0/sql/statements/s1/result/chunks/1",
      },
    }));
  await assert.rejects(() => queryDatabricks("SELECT job_id FROM jobs"), /chunk fetch failed \(404\)/);
});

for (const incomplete of incompleteResults) {
  test(`Databricks ${incomplete.name} results cannot be cached as a complete history`, async (t) => {
    configureWarehouse(t);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return Response.json({
        status: { state: "SUCCEEDED" },
        manifest: {
          schema: { columns: [{ name: "job_id" }] },
          truncated: false, total_chunk_count: 1, total_row_count: 1,
          chunks: [{ chunk_index: 0, row_count: 1, row_offset: 0 }],
          ...(requests === 1 ? incomplete.manifest : {}),
        },
        result: {
          chunk_index: 0, data_array: [["retry-job"]], row_count: 1, row_offset: 0,
          ...(requests === 1 ? incomplete.result : {}),
        },
      });
    });
    const load = () => getOrLoadCached(`databricks-incomplete-test:${incomplete.name}`, 60_000,
      () => queryDatabricks<{ job_id: string }>("SELECT job_id FROM jobs"));

    await assert.rejects(load, (error: unknown) => {
      assert.ok(error instanceof DatabricksIncompleteResultError);
      assert.match(error.message, /incomplete result.*narrower time range/);
      return true;
    });
    const recovered = await load();
    assert.equal(recovered.status, "MISS");
    assert.deepEqual(recovered.data, [{ job_id: "retry-job" }]);
    assert.equal((await load()).status, "HIT");
    assert.equal(requests, 2);
  });
}
