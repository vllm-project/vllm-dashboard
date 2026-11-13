import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as getPerf } from "@/app/api/perf/route";
import { GET as getPerfFilters } from "@/app/api/perf/filters/route";
import { GET as getEval } from "@/app/api/eval/route";
import { GET as getEvalFilters } from "@/app/api/eval/filters/route";
import { GET as getEvalSamples } from "@/app/api/eval/samples/route";
import { jsonField } from "./perf-eval-clickhouse";
import { perfEvalStore, resolvePerfEvalSource } from "./perf-eval-store";

interface Captured {
  sql: string;
  params: URLSearchParams;
}

/** Route ClickHouse calls to `respond`; fail on anything else (e.g. Databricks). */
async function withClickHouse(
  respond: (sql: string) => Record<string, string>[],
  run: (queries: Captured[]) => Promise<void>,
) {
  process.env.CLICKHOUSE_URL = "https://ch.example:8443";
  process.env.CLICKHOUSE_READ_USER = "reader";
  process.env.CLICKHOUSE_READ_PASSWORD = "secret";
  process.env.PERF_EVAL_SOURCE = "clickhouse";
  const queries: Captured[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.host, "ch.example:8443", `unexpected fetch to ${url.host}`);
    const sql = String(init?.body);
    queries.push({ sql, params: url.searchParams });
    return new Response(respond(sql).map((row) => JSON.stringify(row)).join("\n"));
  }) as typeof fetch;
  try {
    await run(queries);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PERF_EVAL_SOURCE;
  }
}

test("resolvePerfEvalSource: ?source= wins, then PERF_EVAL_SOURCE, else databricks", () => {
  delete process.env.PERF_EVAL_SOURCE;
  assert.equal(resolvePerfEvalSource(), "databricks");
  assert.equal(resolvePerfEvalSource(new URLSearchParams("source=bogus")), "databricks");
  process.env.PERF_EVAL_SOURCE = "clickhouse";
  assert.equal(resolvePerfEvalSource(new URLSearchParams()), "clickhouse");
  assert.equal(resolvePerfEvalSource(new URLSearchParams("source=databricks")), "databricks");
  delete process.env.PERF_EVAL_SOURCE;
  assert.equal(resolvePerfEvalSource(new URLSearchParams("source=clickhouse")), "clickhouse");
  assert.notEqual(perfEvalStore("clickhouse"), perfEvalStore("databricks"));
});

test("jsonField builds a Nullable JSONExtract over a literal path", () => {
  assert.equal(
    jsonField("s", ["resps", 1, 1], "String"),
    "JSONExtract(s, 'resps', 1, 1, 'Nullable(String)')",
  );
});

test("perf binds filters as params and filters on the materialized key columns", async () => {
  const model = "org/model' OR 1=1 --";
  await withClickHouse(
    () => [{ date: "2026-11-01 00:00:00", model, device: "h200", tp: "8", conc: "64", tput_per_gpu: "1.5", median_ttft: "ᴺᵁᴸᴸ" }],
    async (queries) => {
      const query = new URLSearchParams({ model, device: "h200", tp: "8", conc: "64", start: "2026-10-01" });
      const response = await getPerf(new NextRequest(`http://localhost/api/perf?${query}`));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.rows[0].tp, "8");
      assert.equal(body.rows[0].median_ttft, null);

      assert.equal(queries.length, 1);
      const [{ sql, params }] = queries;
      assert.ok(!sql.includes(model), "user input must not reach the SQL text");
      assert.match(sql, /FROM ci\.perf_data_ingest FINAL/);
      assert.match(sql, /model != ''/);
      assert.match(sql, /perf_date >= \{startDate:String\}/);
      assert.match(sql, /model = \{model:String\}/);
      assert.match(sql, /JSONExtract\(message, 'tp', 'Nullable\(Int64\)'\) = \{tp:Int64\}/);
      assert.equal(params.get("param_model"), model);
      assert.equal(params.get("param_startDate"), "2026-10-01");
      assert.equal(params.get("param_tp"), "8");
      assert.equal(params.get("param_conc"), "64");
    },
  );
});

test("perf filters aggregate ClickHouse rows into sorted dimensions", async () => {
  await withClickHouse(
    (sql) => {
      if (sql.includes("count() AS n")) return [{ model: "a", n: "1" }, { model: "b", n: "3" }];
      if (sql.includes("SELECT DISTINCT")) {
        return [
          { device: "h200", tp: "8", conc: "64", precision: "fp8", image: "img1" },
          { device: "b200", tp: "2", conc: "ᴺᵁᴸᴸ", precision: "fp8", image: "img2" },
        ];
      }
      return [{ image: "img1", last_date: "2026-11-02 01:00:00" }];
    },
    async (queries) => {
      const response = await getPerfFilters(
        new Request("http://localhost/api/perf/filters?start=2026-09-01&end=2026-11-05T12:00:00Z"),
      );
      const body = await response.json();
      assert.deepEqual(body.models, ["b", "a"]);
      assert.deepEqual(body.devices, ["b200", "h200"]);
      assert.deepEqual(body.tps, ["2", "8"]);
      assert.deepEqual(body.concs, ["64"]);
      assert.deepEqual(body.imageDates, { img1: "2026-11-02 01:00:00" });
      assert.equal(queries.length, 3);
      for (const { sql, params } of queries) {
        assert.match(sql, /perf_date <= \{end:String\}/);
        assert.equal(params.get("param_end"), "2026-11-05");
      }
    },
  );
});

test("eval reads only results messages, skipping sample payloads by key", async () => {
  const message = {
    kind: "results",
    buildkite_build_id: "b1",
    workload: "w1",
    image: "img",
    data: {
      date: 1_794_400_000,
      config: { model_args: "model=org/m" },
      results: { gsm8k: { "exact_match,strict-match": 0.9, "exact_match_stderr,strict-match": 0.01 } },
      higher_is_better: { gsm8k: { exact_match: true } },
    },
  };
  await withClickHouse(
    () => [{ ingest_ts: "2026-11-12T00:00:00.123456789Z", m: JSON.stringify(message) }],
    async (queries) => {
      const response = await getEval(new NextRequest("http://localhost/api/eval?model=org%2Fm"));
      const body = await response.json();
      assert.equal(body.rows.length, 1);
      assert.equal(body.rows[0].model, "org/m");
      assert.equal(body.rows[0].image, "img");
      assert.equal(body.rows[0].metrics[0].value, 0.9);

      const [{ sql, params }] = queries;
      assert.match(sql, /FROM ci\.eval_data_ingest FINAL/);
      assert.match(sql, /kind NOT IN \('sample', 'samples'\)/);
      assert.match(sql, /LIKE concat\('%model=', \{model:String\}, '%'\)/);
      assert.equal(params.get("param_model"), "org/m");
    },
  );
});

test("eval filters bind the epoch window", async () => {
  await withClickHouse(
    () => [],
    async (queries) => {
      const response = await getEvalFilters(
        new Request("http://localhost/api/eval/filters?start=2026-11-01&end=2026-11-02"),
      );
      assert.equal(response.status, 200);
      const [{ sql, params }] = queries;
      assert.match(sql, /kind NOT IN \('sample', 'samples'\)/);
      assert.equal(params.get("param_startEpoch"), String(Date.parse("2026-11-01") / 1000));
      assert.equal(params.get("param_endEpoch"), String(Date.parse("2026-11-02") / 1000 + 86_399));
    },
  );
});

test("eval samples filter by key columns, explode samples, and report truncation", async () => {
  const buildId = "01a1-build' --";
  await withClickHouse(
    (sql) =>
      sql.includes("countIf")
        ? [{ correct: "3", incorrect: "1" }]
        : [
            { task: "gsm8k", doc_id: "0", filter: "strict", exact_match: "1", question: "q", prompt: "p", target: "t", response: "r", filtered_response: "f" },
            { task: "gsm8k", doc_id: "1", filter: "strict", exact_match: "0", question: "", prompt: "", target: "", response: "", filtered_response: "" },
          ],
    async (queries) => {
      const query = new URLSearchParams({ build_id: buildId, task: "gsm8k", workload: "w1", limit: "1" });
      const response = await getEvalSamples(new NextRequest(`http://localhost/api/eval/samples?${query}`));
      const body = await response.json();
      assert.equal(body.samples.length, 1);
      assert.equal(body.truncated, true);
      assert.deepEqual([body.total, body.correct, body.incorrect], [4, 3, 1]);
      assert.equal(body.samples[0].doc_id, 0);
      assert.equal(body.samples[0].exact_match, 1);

      assert.equal(queries.length, 2);
      for (const { sql, params } of queries) {
        assert.ok(!sql.includes(buildId), "user input must not reach the SQL text");
        assert.match(sql, /kind IN \('sample', 'samples'\)/);
        assert.match(sql, /buildkite_build_id = \{buildId:String\}/);
        assert.match(sql, /task = \{task:String\}/);
        assert.match(sql, /ARRAY JOIN samples AS s/);
        assert.equal(params.get("param_buildId"), buildId);
        assert.equal(params.get("param_workload"), "w1");
      }
      const page = queries.find(({ sql }) => sql.includes("LIMIT"))!;
      assert.equal(page.params.get("param_limit"), "2");
    },
  );
});
