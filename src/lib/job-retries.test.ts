import assert from "node:assert/strict";
import test from "node:test";
import {
  rankRetryJobs,
  buildOtelRetryQuery,
  buildOtelRetryRunsQuery,
  buildWarehouseRetryQuery,
  buildWarehouseRetryRunsQuery,
  parseRetryFilters,
  RetryFilterError,
  type RetryStatsRow,
  type RetryJobRun,
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
  assert.match(otel.statement, /j.pipeline_slug = \$1/);
  assert.deepEqual(otel.parameters, ["amd-ci"]);
  assert.match(warehouse.statement, /p.name = :pipeline/);
  assert.deepEqual(warehouse.parameters, [{ name: "pipeline", value: "AMD CI", type: "STRING" }]);
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
  assert.ok(otel.parameters.includes(hostile));
  assert.equal(warehouse.parameters.find((p) => p.name === "branch")?.value, hostile);
  assert.match(otel.statement, /j.start_time >= \$\d+::timestamptz/);
  assert.match(warehouse.statement, /j.started_at >= CAST\(:startTime AS TIMESTAMP\)/);
  const all = parseRetryFilters(new URLSearchParams({ pipeline: "", branch: "" }));
  assert.deepEqual(buildOtelRetryQuery(all).parameters, []);
  assert.deepEqual(buildWarehouseRetryQuery(all).parameters, []);
});

test("retry run queries bind exact names and share ranking scope, including all and AMD pipelines", () => {
  const hostile = "test' OR 1=1 --";
  for (const pipeline of ["", "CI", "AMD CI"]) {
    const filters = parseRetryFilters(new URLSearchParams({ pipeline, branch: "", startDate: "2026-09-23T10:00Z", endDate: "2026-09-23T11:00Z" }));
    const otel = buildOtelRetryRunsQuery(filters, hostile);
    const warehouse = buildWarehouseRetryRunsQuery(filters, hostile);
    assert.equal(otel.statement.includes(hostile), false);
    assert.equal(warehouse.statement.includes(hostile), false);
    assert.deepEqual(otel.parameters, [...buildOtelRetryQuery(filters).parameters, hostile]);
    assert.deepEqual(warehouse.parameters, [...buildWarehouseRetryQuery(filters).parameters, { name: "jobName", value: hostile, type: "STRING" }]);
    assert.match(otel.statement, /j.job_label = \$\d+/);
    assert.match(warehouse.statement, /j.name = :jobName/);
    assert.match(otel.statement, /ORDER BY a.started_at ASC, a.job_id ASC/);
    assert.match(warehouse.statement, /ORDER BY started_at ASC, job_id ASC/);
  }
});

// Optional local SQL integration: point RETRY_TEST_PGLITE_MODULE to an installed
// @electric-sql/pglite module. This executes both aggregate queries in Postgres
// without requiring production credentials or adding a runtime dependency.
const pgliteModule = process.env.RETRY_TEST_PGLITE_MODULE;
interface FixtureDb {
  exec(statement: string): Promise<unknown>;
  query<T>(statement: string, parameters?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

test("actual retry SQL counts retry attempts once across outcomes, shards, and date boundaries", {
  skip: pgliteModule ? false : "Set RETRY_TEST_PGLITE_MODULE to run local Postgres fixtures",
}, async () => {
  const { PGlite } = await import(pgliteModule!) as { PGlite: new () => FixtureDb };
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE otel_spans (
        job_id text, job_label text, span_name text DEFAULT 'buildkite.job',
        job_type text DEFAULT 'script', organization_slug text DEFAULT 'vllm',
        pipeline_slug text DEFAULT 'ci', build_number int DEFAULT 1,
        start_time timestamptz, end_time timestamptz, duration_ms double precision DEFAULT 60000,
        job_state text, job_passed text, received_at timestamptz DEFAULT now(),
        job_soft_failed text DEFAULT 'false', span_attributes jsonb DEFAULT '{}'
      );
      CREATE SCHEMA warehouse;
      CREATE TABLE warehouse.pipeline (id text, name text);
      INSERT INTO warehouse.pipeline VALUES ('ci', 'CI');
      CREATE TABLE warehouse.build (id text, pipeline_id text, branch text, _fivetran_deleted boolean,
        number int DEFAULT 1, commit text DEFAULT 'fixture-sha', created_at timestamptz DEFAULT '2026-09-22T00:00Z');
      INSERT INTO warehouse.build (id, pipeline_id, branch, _fivetran_deleted) VALUES ('1', 'ci', 'main', false);
      CREATE TABLE warehouse.build_job (
        id text, build_id text DEFAULT '1', name text, type text DEFAULT 'script',
        state text, started_at timestamptz, finished_at timestamptz, web_url text,
        retries_count int, retry_source_job_id text,
        soft_failed text DEFAULT 'false', _fivetran_deleted boolean DEFAULT false
      );
    `);
    const fixtures = [
      { id: "failed-original", name: "Basic Correctness", ordinal: 0, state: "failed", time: "10:00:00" },
      { id: "successful-retry", name: "Basic Correctness", ordinal: 1, state: "passed", time: "10:10:00" },
      { id: "second-retry", name: "Basic Correctness", ordinal: 2, state: "canceled", time: "10:20:00" },
      { id: "second-retry", name: "Basic Correctness", ordinal: 2, state: "canceled", time: "10:20:00" },
      { id: "shard-a", name: "Parallel job", ordinal: 0, state: "failed", time: "10:30:00" },
      { id: "shard-b", name: "Parallel job", ordinal: 0, state: "passed", time: "10:30:00" },
      { id: "outside-before", name: "Basic Correctness", ordinal: 1, state: "failed", time: "09:59:59" },
      { id: "outside-end", name: "Basic Correctness", ordinal: 1, state: "passed", time: "11:00:00" },
      { id: "source-only", name: "Legacy", ordinal: null, source: "previous", state: "passed", time: "10:40:00" },
    ];
    for (const row of fixtures) {
      const attributes = {
        "buildkite.build.branch": "main",
        "buildkite.job.state": row.state,
        "buildkite.job.retries_count": row.ordinal,
        "buildkite.job.retry_source.job_id": row.source,
      };
      await db.query(`INSERT INTO otel_spans (job_id, job_label, start_time, span_attributes)
        VALUES ($1, $2, $3, $4)`, [row.id, row.name, `2026-09-23T${row.time}Z`, JSON.stringify(attributes)]);
      await db.query(`INSERT INTO warehouse.build_job (id, name, state, started_at, retries_count, retry_source_job_id)
        VALUES ($1, $2, $3, $4, $5, $6)`, [row.id, row.name, row.state, `2026-09-23T${row.time}Z`, row.ordinal, row.source ?? null]);
    }
    await db.exec(`
      UPDATE otel_spans SET end_time = start_time + INTERVAL '1 minute',
        job_state = CASE WHEN span_attributes->>'buildkite.job.state' IN ('passed', 'failed') THEN 'finished'
          ELSE span_attributes->>'buildkite.job.state' END,
        job_passed = CASE WHEN span_attributes->>'buildkite.job.state' = 'passed' THEN 'true' ELSE 'false' END;
      UPDATE warehouse.build_job SET finished_at = started_at + INTERVAL '1 minute';
    `);
    const filters = parseRetryFilters(new URLSearchParams({ startDate: "2026-09-23T10:00Z", endDate: "2026-09-23T11:00Z" }));
    const otel = buildOtelRetryQuery(filters);
    const warehouse = buildWarehouseRetryQuery(filters);
    const warehouseStatement = warehouse.statement.replaceAll("vllm_data_warehouse.buildkite.", "warehouse.")
      .replace(/:(pipeline|branch|startTime|endTime)\b/g, (_, name) => `$${warehouse.parameters.findIndex((p) => p.name === name) + 1}`);
    const results = await Promise.all([
      db.query<RetryStatsRow>(otel.statement, otel.parameters),
      db.query<RetryStatsRow>(warehouseStatement, warehouse.parameters.map((p) => p.value)),
    ]);
    for (const { rows } of results) {
      const totals = rows.map((row) => [row.name, Number(row.total_runs), Number(row.retries)]).sort();
      assert.deepEqual(totals, [["Basic Correctness", 3, 2], ["Legacy", 1, 1], ["Parallel job", 2, 0]]);
    }
    const warehouseRuns = (query: ReturnType<typeof buildWarehouseRetryRunsQuery>) => ({
      statement: query.statement.replaceAll("vllm_data_warehouse.buildkite.", "warehouse.")
        .replace(/:(pipeline|branch|startTime|endTime|jobName)\b/g, (_, name) => `$${query.parameters.findIndex((p) => p.name === name) + 1}`)
        .replace("TIMESTAMPDIFF(SECOND, started_at, finished_at)", "EXTRACT(EPOCH FROM (finished_at - started_at))"),
      parameters: query.parameters.map((p) => p.value),
    });
    for (const query of [buildOtelRetryRunsQuery(filters, "Basic Correctness"), warehouseRuns(buildWarehouseRetryRunsQuery(filters, "Basic Correctness"))]) {
      const runs = (await db.query<RetryJobRun>(query.statement, query.parameters)).rows;
      assert.deepEqual(runs.map((run) => [run.job_id, run.state, Number(run.is_retry), Number(run.duration_secs)]), [
        ["failed-original", "failed", 0, 60], ["successful-retry", "passed", 1, 60], ["second-retry", "canceled", 1, 60],
      ]);
      assert.equal(runs.length, 3, "duplicate UUIDs and out-of-window starts must not appear");
    }

    // CI contains AMD mirror jobs, while native AMD jobs also run in AMD CI.
    // Both sources must preserve mirrors and honor the selected pipeline.
    await db.exec(`
      INSERT INTO warehouse.pipeline VALUES ('amd-ci', 'AMD CI');
      INSERT INTO warehouse.build (id, pipeline_id, branch, _fivetran_deleted) VALUES ('amd-1', 'amd-ci', 'main', false);
    `);
    const amdFixtures = [
      { id: "explicit-mirror", name: ":amd: (MI300) Kernels", pipeline: "ci", build: "1", ordinal: 1 },
      { id: "legacy-mirror", name: "AMD: Kernels", pipeline: "ci", build: "1", ordinal: 1 },
      { id: "native-original", name: "mi325_1: Basic Correctness Test", pipeline: "amd-ci", build: "amd-1", ordinal: 0 },
      { id: "native-retry", name: "mi325_1: Basic Correctness Test", pipeline: "amd-ci", build: "amd-1", ordinal: 1 },
    ];
    for (const row of amdFixtures) {
      await db.query(`INSERT INTO otel_spans (job_id, job_label, pipeline_slug, start_time, span_attributes)
        VALUES ($1, $2, $3, '2026-09-23T10:30Z', $4)`, [
        row.id, row.name, row.pipeline,
        JSON.stringify({ "buildkite.build.branch": "main", "buildkite.job.retries_count": row.ordinal }),
      ]);
      await db.query(`INSERT INTO warehouse.build_job (id, build_id, name, started_at, retries_count)
        VALUES ($1, $2, $3, '2026-09-23T10:30Z', $4)`, [row.id, row.build, row.name, row.ordinal]);
    }
    for (const pipeline of ["CI", "AMD CI", ""]) {
      const selected = { ...filters, pipeline };
      const telemetryQuery = buildOtelRetryQuery(selected);
      const warehouseQuery = buildWarehouseRetryQuery(selected);
      const warehouseSql = warehouseQuery.statement.replaceAll("vllm_data_warehouse.buildkite.", "warehouse.")
        .replace(/:(pipeline|branch|startTime|endTime)\b/g, (_, name) => `$${warehouseQuery.parameters.findIndex((p) => p.name === name) + 1}`);
      const selectedResults = await Promise.all([
        db.query<RetryStatsRow>(telemetryQuery.statement, telemetryQuery.parameters),
        db.query<RetryStatsRow>(warehouseSql, warehouseQuery.parameters.map((p) => p.value)),
      ]);
      for (const { rows } of selectedResults) {
        const byName = new Map(rows.map((row) => [row.name, [Number(row.total_runs), Number(row.retries)]]));
        for (const mirror of amdFixtures.slice(0, 2)) {
          assert.deepEqual(byName.get(mirror.name), pipeline === "AMD CI" ? undefined : [1, 1]);
        }
        assert.deepEqual(byName.get("mi325_1: Basic Correctness Test"), pipeline === "CI" ? undefined : [2, 1]);
        assert.deepEqual(byName.get("Basic Correctness"), pipeline === "AMD CI" ? undefined : [3, 2]);
      }
      for (const name of ["Basic Correctness", "mi325_1: Basic Correctness Test", ":amd: (MI300) Kernels"]) {
        const drilldowns = [buildOtelRetryRunsQuery(selected, name), warehouseRuns(buildWarehouseRetryRunsQuery(selected, name))];
        for (const [index, query] of drilldowns.entries()) {
          const runs = (await db.query<RetryJobRun>(query.statement, query.parameters)).rows;
          const ranking = selectedResults[index].rows.find((row) => row.name === name);
          assert.equal(runs.length, Number(ranking?.total_runs ?? 0), `${pipeline || "all"} ${name} run totals`);
          assert.equal(runs.reduce((sum, row) => sum + Number(row.is_retry), 0), Number(ranking?.retries ?? 0), `${pipeline || "all"} ${name} retry totals`);
        }
      }
    }

    // A predecessor outside the window can identify a retry inside it. Its
    // forward link must not be counted as an extra attempt itself.
    await db.query(`INSERT INTO otel_spans (job_id, job_label, start_time, span_attributes) VALUES
      ('old', 'Renamed legacy predecessor', '2026-09-22T23:00Z', $1),
      ('new', 'Legacy link', '2026-09-23T10:50Z', $2)`, [
      JSON.stringify({ "buildkite.job.retried_in_job_id": "new", "buildkite.build.branch": "main" }),
      JSON.stringify({ "buildkite.build.branch": "main" }),
    ]);
    const legacy = (await db.query<RetryStatsRow>(otel.statement, otel.parameters)).rows.find((row) => row.name === "Legacy link");
    assert.equal(legacy?.retries, 1);
    assert.equal(legacy?.total_runs, 1);
    const legacyQuery = buildOtelRetryRunsQuery(filters, "Legacy link");
    const legacyRuns = (await db.query<RetryJobRun>(legacyQuery.statement, legacyQuery.parameters)).rows;
    assert.deepEqual(legacyRuns.map((run) => [run.job_id, run.is_retry]), [["new", true]],
      "predecessors can have another label and start before the selected window");
    assert.equal(legacyRuns[0].web_url, "https://buildkite.com/vllm/ci/builds/1#new");

    // Malformed telemetry cannot crash the aggregate or turn an ordinary
    // failed job into a retry. Branch fallback cannot duplicate an attempt.
    await db.query(`INSERT INTO otel_spans (job_id, job_label, start_time, span_attributes) VALUES
      ('malformed', 'Malformed metadata', '2026-09-23T10:15Z', $1),
      ('fallback', 'Branch fallback', '2026-09-23T10:15Z', $2)`, [
      JSON.stringify({ "buildkite.job.retries_count": "not-a-number", "buildkite.build.branch": "main" }),
      JSON.stringify({ "buildkite.job.retries_count": 1 }),
    ]);
    await db.query(`INSERT INTO otel_spans (span_name, start_time, span_attributes) VALUES
      ('buildkite.build', '2026-09-22T00:00Z', $1), ('buildkite.build', '2026-09-22T00:00Z', $1)`, [
      JSON.stringify({ "buildkite.build.branch": "main", "buildkite.build.commit": "fixture-sha" }),
    ]);
    const edgeRows = (await db.query<RetryStatsRow>(otel.statement, otel.parameters)).rows;
    assert.equal(edgeRows.find((row) => row.name === "Malformed metadata")?.retries, 0);
    assert.equal(edgeRows.find((row) => row.name === "Branch fallback")?.retries, 1);
    assert.equal(edgeRows.find((row) => row.name === "Branch fallback")?.total_runs, 1);
    await db.query(`INSERT INTO otel_spans (job_id, job_label, organization_slug, start_time, span_attributes) VALUES
      ('null-old', 'Null organization', NULL, '2026-09-22T23:00Z', $1),
      ('null-old', 'Null organization', NULL, '2026-09-22T23:00Z', $1),
      ('null-new', 'Null organization', NULL, '2026-09-23T10:50Z', $2)`, [
      JSON.stringify({ "buildkite.job.retried_in_job_id": "null-new", "buildkite.build.branch": "main" }),
      JSON.stringify({ "buildkite.build.branch": "main" }),
    ]);
    const nullable = (await db.query<RetryStatsRow>(otel.statement, otel.parameters)).rows.find((row) => row.name === "Null organization");
    assert.equal(nullable?.retries, 1);
    assert.equal(nullable?.total_runs, 1, "duplicate forward links must not multiply attempts");
    const hostile = buildOtelRetryQuery(parseRetryFilters(new URLSearchParams({ branch: "main' OR 1=1 --" })));
    assert.deepEqual((await db.query(hostile.statement, hostile.parameters)).rows, []);
    for (const query of [buildOtelRetryRunsQuery(filters, "Basic Correctness' OR 1=1 --"), warehouseRuns(buildWarehouseRetryRunsQuery(filters, "Basic Correctness' OR 1=1 --"))]) {
      assert.deepEqual((await db.query(query.statement, query.parameters)).rows, []);
    }
    for (const row of (await db.query<RetryStatsRow>(otel.statement, otel.parameters)).rows) {
      const query = buildOtelRetryRunsQuery(filters, row.name);
      const runs = (await db.query<RetryJobRun>(query.statement, query.parameters)).rows;
      assert.equal(runs.length, Number(row.total_runs), `${row.name} reconciles run count`);
      assert.equal(runs.filter((run) => run.is_retry).length, Number(row.retries), `${row.name} reconciles retry count`);
    }
    await db.query(`UPDATE otel_spans SET span_attributes = span_attributes || $1::jsonb WHERE job_id = 'successful-retry'`, [
      JSON.stringify({ "buildkite.build.commit": "job-span-sha", "buildkite.job.web_url": "https://buildkite.com/vllm/ci/builds/1#successful-retry" }),
    ]);
    const metadataQuery = buildOtelRetryRunsQuery(filters, "Basic Correctness");
    const metadataRuns = (await db.query<RetryJobRun>(metadataQuery.statement, metadataQuery.parameters)).rows;
    assert.equal(metadataRuns.length, 3, "duplicate build spans must not multiply detail rows");
    assert.deepEqual(metadataRuns.map((run) => run.commit_sha), ["fixture-sha", "job-span-sha", "fixture-sha"]);
    assert.ok(metadataRuns.every((run) => new Date(run.build_created_at!).toISOString() === "2026-09-22T00:00:00.000Z"));
    assert.equal(metadataRuns[1].web_url, "https://buildkite.com/vllm/ci/builds/1#successful-retry");
  } finally {
    await db.close();
  }
});
