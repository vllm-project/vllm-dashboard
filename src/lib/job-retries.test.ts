import assert from "node:assert/strict";
import test from "node:test";
import {
  rankRetryJobs,
  queryRetryRunsFromOtel,
  queryRetriesFromOtel,
  buildOtelRetryQuery,
  buildOtelRetryRunsQuery,
  buildWarehouseRetryQuery,
  buildWarehouseRetryRunsQuery,
  parseRetryFilters,
  RetryFilterError,
  type RetryStatsRow,
} from "./job-retries";

test("retry date filters preserve exact hour boundaries and inclusive calendar ends", () => {
  const exact = parseRetryFilters(new URLSearchParams({
    startDate: "2026-09-23T10:00:00Z", endDate: "2026-09-23T11:00:00Z",
  }));
  assert.equal(exact.startTime, "2026-09-23T10:00:00.000Z");
  assert.equal(exact.endTime, "2026-09-23T11:00:00.000Z");
  const day = parseRetryFilters(new URLSearchParams({ startDate: "2026-09-23", endDate: "2026-09-23" }));
  assert.equal(day.startTime, "2026-09-23T00:00:00.000Z");
  assert.equal(day.endTime, "2026-09-24T00:00:00.000Z");
  const offset = parseRetryFilters(new URLSearchParams({ endDate: "2026-09-23T13:00:00+02:00" }));
  assert.equal(offset.endTime, exact.endTime);
});

test("retry windows keep stable keys, explicit dates win, and clear means all history", () => {
  const first = parseRetryFilters(new URLSearchParams({ window: "14d" }), new Date("2026-09-23T12:00Z"));
  const next = parseRetryFilters(new URLSearchParams({ window: "14d" }), new Date("2026-09-24T12:00Z"));
  assert.equal(first.rangeKey, next.rangeKey);
  assert.equal(first.startTime, "2026-09-09T00:00:00.000Z");
  assert.equal(first.endTime, "2026-09-24T00:00:00.000Z");
  assert.notEqual(first.startTime, next.startTime);
  const custom = parseRetryFilters(new URLSearchParams({ window: "invalid", startDate: "2026-08-01" }));
  assert.equal(custom.startTime, "2026-08-01T00:00:00.000Z");
  assert.equal(custom.endTime, null);
  const all = parseRetryFilters(new URLSearchParams({ pipeline: "", branch: "" }));
  assert.equal(all.pipeline, "");
  assert.equal(all.branch, "");
  assert.equal(all.startTime, null);
  assert.equal(all.endTime, null);
  const defaults = parseRetryFilters(new URLSearchParams());
  assert.equal(defaults.pipeline, "CI");
  assert.equal(defaults.branch, "main");
});

test("invalid or reversed retry ranges are rejected", () => {
  const invalid: Record<string, string>[] = [
    { startDate: "2026-02-30" }, { endDate: "garbage" },
    { endDate: "2026-09-23T10:00:00" }, { window: "0d" }, { window: "91d" },
    { startDate: "2026-09-24", endDate: "2026-09-22" },
    { startDate: "2026-09-23T10:00Z", endDate: "2026-09-23T10:00Z" },
  ];
  for (const params of invalid) {
    assert.throws(() => parseRetryFilters(new URLSearchParams(params)), RetryFilterError);
  }
});

test("retry ranking keeps individual jobs, shards, and unknown names without combining test areas", () => {
  const rows: RetryStatsRow[] = [
    { name: "Kernels MoE Test 2", retries: "2", total_runs: "5", has_soft_fail: "1" },
    { name: "Kernels MoE Test 1", retries: 2, total_runs: 4, has_soft_fail: false },
    { name: "Basic Correctness", retries: 0, total_runs: 10, has_soft_fail: null },
    { name: "new job", retries: "4", total_runs: "4", has_soft_fail: "false" },
  ];
  assert.deepEqual(rankRetryJobs(rows), [
    { name: "new job", retries: 4, total_runs: 4, has_soft_fail: false },
    { name: "Kernels MoE Test 1", retries: 2, total_runs: 4, has_soft_fail: false },
    { name: "Kernels MoE Test 2", retries: 2, total_runs: 5, has_soft_fail: true },
    { name: "Basic Correctness", retries: 0, total_runs: 10, has_soft_fail: false },
  ]);
  assert.equal(rows[0].name, "Kernels MoE Test 2");
  assert.deepEqual(rankRetryJobs([]), []);
});

test("retry ranking normalizes numeric counts and soft-fail values from either data source", () => {
  const trueValues = [true, 1, "1", "true"];
  const falseValues = [false, 0, "0", "false", null];
  for (const has_soft_fail of [...trueValues, ...falseValues]) {
    assert.deepEqual(rankRetryJobs([{ name: "Job", retries: "3", total_runs: "12", has_soft_fail }]), [{
      name: "Job", retries: 3, total_runs: 12, has_soft_fail: trueValues.includes(has_soft_fail!),
    }]);
  }
});

test("AMD CI retry filtering uses the pipeline slug in telemetry and display name in the warehouse", () => {
  const filters = parseRetryFilters(new URLSearchParams({ pipeline: "AMD CI", branch: "" }));
  const otel = buildOtelRetryQuery(filters);
  const warehouse = buildWarehouseRetryQuery(filters);
  assert.match(otel.statement, /j.pipeline_slug = \{pipeline:String\}/);
  assert.deepEqual(otel.parameters, { pipeline: "amd-ci" });
  assert.match(warehouse.statement, /name = \{pipeline:String\}/);
  assert.deepEqual(warehouse.parameters, { pipeline: "AMD CI" });
});

test("retry ranking independently ranks AMD mirrors, native AMD jobs, and NVIDIA jobs", () => {
  const rows: RetryStatsRow[] = [
    { name: ":nvidia: (L4) MoE Kernels Shard 1", retries: 2, total_runs: 6, has_soft_fail: false },
    { name: ":amd: (MI300) MoE Kernels Shard 1", retries: 5, total_runs: 10, has_soft_fail: false },
    { name: ":amd: (MI355) Kernels", retries: 3, total_runs: 9, has_soft_fail: false },
    { name: ":amd: (MI355) vLLM IR", retries: 4, total_runs: 8, has_soft_fail: false },
    { name: "mi325_1: Kernels MoE Test 2", retries: 2, total_runs: 4, has_soft_fail: false },
    { name: ":amd: Unrecognized suite", retries: 1, total_runs: 3, has_soft_fail: false },
  ];
  assert.deepEqual(rankRetryJobs(rows), [rows[1], rows[3], rows[2], rows[0], rows[4], rows[5]]);
});

test("backend retry filters bind hostile values and respect all-pipeline/all-branch filters", () => {
  const hostile = "main' OR 1=1 --";
  const filters = parseRetryFilters(new URLSearchParams({ pipeline: "CI", branch: hostile, startDate: "2026-09-23" }));
  const otel = buildOtelRetryQuery(filters);
  const warehouse = buildWarehouseRetryQuery(filters);
  assert.ok(!otel.statement.includes(hostile));
  assert.ok(!warehouse.statement.includes(hostile));
  assert.equal(otel.parameters.branch, hostile);
  assert.equal(warehouse.parameters.branch, hostile);
  assert.match(otel.statement, /j.start_time >= parseDateTime64BestEffort\(\{startTime:String\}/);
  assert.match(warehouse.statement, /j.started_at >= parseDateTime64BestEffort\(\{startTime:String\}/);
  const all = parseRetryFilters(new URLSearchParams({ pipeline: "", branch: "" }));
  assert.deepEqual(buildOtelRetryQuery(all).parameters, {});
  assert.deepEqual(buildWarehouseRetryQuery(all).parameters, {});
});

test("retry run queries bind exact names and share ranking scope, including all and AMD pipelines", () => {
  const hostile = "test' OR 1=1 --";
  for (const pipeline of ["", "CI", "AMD CI"]) {
    const filters = parseRetryFilters(new URLSearchParams({ pipeline, branch: "", startDate: "2026-09-23T10:00Z", endDate: "2026-09-23T11:00Z" }));
    const otel = buildOtelRetryRunsQuery(filters, hostile);
    const warehouse = buildWarehouseRetryRunsQuery(filters, hostile);
    assert.equal(otel.statement.includes(hostile), false);
    assert.equal(warehouse.statement.includes(hostile), false);
    assert.deepEqual(otel.parameters, { ...buildOtelRetryQuery(filters).parameters, jobName: hostile });
    assert.deepEqual(warehouse.parameters, { ...buildWarehouseRetryQuery(filters).parameters, jobName: hostile });
    assert.match(otel.statement, /j.job_label = \{jobName:String\}/);
    assert.match(warehouse.statement, /j.name = \{jobName:String\}/);
    assert.match(otel.statement, /ORDER BY started_at ASC, job_id ASC/);
    assert.match(warehouse.statement, /ORDER BY started_at ASC, job_id ASC/);
  }
});

test("telemetry retry SQL reads ClickHouse spans, one attempt per job UUID", () => {
  const filters = parseRetryFilters(new URLSearchParams({ startDate: "2026-09-23T10:00Z", endDate: "2026-09-23T11:00Z" }));
  for (const { statement } of [buildOtelRetryQuery(filters), buildOtelRetryRunsQuery(filters, "Basic Correctness")]) {
    assert.match(statement, /FROM ci\.otel_spans AS j/);
    assert.match(statement, /LIMIT 1 BY j\.job_id/);
    assert.match(statement, /SETTINGS join_use_nulls = 1\n/);
    assert.doesNotMatch(statement, /enable_materialized_cte|MATERIALIZED/);
    assert.doesNotMatch(statement, /\bFINAL\b|DISTINCT ON|LATERAL|::/);
  }
  // Branch falls back to the newest build span of the same build.
  const branch = buildOtelRetryQuery(parseRetryFilters(new URLSearchParams({ branch: "main" })));
  assert.match(branch.statement, /argMax\(tuple\(/);
  assert.match(branch.statement, /isNotDistinctFrom\(bb\.organization_slug, j\.organization_slug\)/);
});

test("telemetry retry queries bind parameters and parse ClickHouse strings", async (t) => {
  const original = globalThis.fetch;
  process.env.CLICKHOUSE_URL = "https://ch.example";
  process.env.CLICKHOUSE_READ_USER = "reader";
  process.env.CLICKHOUSE_READ_PASSWORD = "secret";
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    urls.push(new URL(String(input)));
    const rows = String(init?.body).includes("is_retry AS is_retry")
      ? [{ job_id: "j1", web_url: "ᴺᵁᴸᴸ", state: "passed", started_at: "2026-09-23T10:00:00.000000Z",
        finished_at: "2026-09-23T10:01:00Z", duration_secs: "60", commit_sha: "abc",
        build_created_at: "2026-09-23T09:59:00Z", build_number: "7", is_retry: "1" }]
      : [{ name: "Job", total_runs: "3", retries: "1", has_soft_fail: "0" }];
    return new Response(rows.map((row) => JSON.stringify(row)).join("\n"), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const filters = parseRetryFilters(new URLSearchParams({ branch: "main", startDate: "2026-09-23" }));
  assert.deepEqual(rankRetryJobs(await queryRetriesFromOtel(filters)), [
    { name: "Job", retries: 1, total_runs: 3, has_soft_fail: false },
  ]);
  assert.equal(urls[0].searchParams.get("param_branch"), "main");
  assert.equal(urls[0].searchParams.get("param_pipeline"), "ci");
  assert.deepEqual(await queryRetryRunsFromOtel(filters, "Job"), [{
    job_id: "j1", web_url: null, state: "passed", started_at: "2026-09-23T10:00:00.000Z",
    finished_at: "2026-09-23T10:01:00.000Z", duration_secs: 60, commit_sha: "abc",
    build_created_at: "2026-09-23T09:59:00.000Z", build_number: "7", is_retry: true,
  }]);
  assert.equal(urls[1].searchParams.get("param_jobName"), "Job");
});
