import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET } from "./route";

test("builds bind filters as ClickHouse params and rewrite RE2-incompatible lookaheads", async () => {
  process.env.CLICKHOUSE_URL = "https://ch.example:8443";
  process.env.CLICKHOUSE_READ_USER = "reader";
  process.env.CLICKHOUSE_READ_PASSWORD = "secret";
  delete process.env.CI_DATA_SOURCE;

  const queries: { sql: string; params: URLSearchParams }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== "ch.example:8443") return new Response("not found", { status: 404 });
    const sql = String(init?.body);
    queries.push({ sql, params: url.searchParams });
    const row = sql.includes("count() AS total")
      ? { total: "1", passed: "1", failed: "0" }
      : {
          id: "b1",
          build_number: "7",
          web_url: "https://buildkite.com/vllm/ci/builds/7",
          message: "Fix it (#123)",
          commit_sha: "abc",
          pipeline: "CI",
          branch: "main",
          state: "passed",
          created_at: "2026-11-01T00:00:00.000000000Z",
          started_at: "2026-11-01T00:01:00.000000000Z",
          finished_at: "2026-11-01T00:31:00.000000000Z",
          author: "dev",
          pr_number: "ᴺᵁᴸᴸ",
          duration_mins: "30",
        };
    return new Response(`${JSON.stringify(row)}\n`);
  }) as typeof fetch;

  try {
    const branch = "main' OR 1=1 --";
    const query = new URLSearchParams({
      pipeline: "CI",
      branch,
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      jobGroups: "Hardware-AMD Tests",
    });
    const response = await GET(new NextRequest(`http://localhost/api/builds?${query}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.summary, { total: 1, passed: 1, failed: 0, passRate: 100 });
    assert.equal(body.builds[0].pr_number, "123");
    assert.equal(body.builds[0].build_number, "7");

    assert.equal(queries.length, 3);
    for (const { sql, params } of queries) {
      assert.ok(!sql.includes(branch), "user input must not reach the SQL text");
      assert.ok(!sql.includes("(?!"), "RE2 has no lookahead");
      assert.match(sql, /FROM buildkite\.build AS b FINAL/);
      assert.match(sql, /NOT b\._fivetran_deleted/);
      assert.equal(params.get("param_branch"), branch);
      assert.equal(params.get("param_pipeline"), "CI");
    }
    const page = queries.find(({ sql }) => sql.includes("LIMIT"))!;
    assert.equal(page.params.get("param_limit"), "50");
    assert.equal(page.params.get("param_offset"), "0");
    const regexParams = [...page.params.entries()].filter(([name]) => name.startsWith("param_jobRegex"));
    assert.ok(regexParams.some(([name, value]) => name.endsWith("_not") && value === "^AMD: :docker: "));
    assert.ok(regexParams.some(([, value]) => value === "^AMD: .*$"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
