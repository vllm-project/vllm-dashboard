/**
 * ClickHouse query builders for the perf and eval pages.
 *
 * `ci.perf_data_ingest` and `ci.eval_data_ingest` keep each event's JSON as
 * `message String` plus materialized columns for the sorting keys:
 * perf (model, device, perf_date) and eval (kind, buildkite_build_id, task).
 * Filter on those first; eval `samples` messages are several MB each.
 *
 * Both tables are ReplacingMergeTree keyed on cityHash64(message), so exact
 * duplicate events collapse; FINAL hides copies that are not merged yet.
 *
 * `JSONExtract(message, ..., 'Nullable(T)')` mirrors Databricks'
 * `message:field::T`: a numeric string such as "8" casts to 8, a number casts
 * to its text for String, and a missing or JSON-null field is NULL.
 */
import { queryClickHouse, type ClickHouseParam } from "@/lib/clickhouse";
import { PERF_DATA_START_DATE } from "@/lib/perf-data";
import type {
  EvalFilterMessage,
  EvalResultMessage,
  EvalSampleCounts,
  EvalSampleRow,
  EvalSamplesQuery,
  PerfEvalStore,
  PerfFilterRows,
  PerfRow,
  PerfRowsQuery,
  PerfRunRow,
} from "@/lib/perf-eval-store";

const PERF_TABLE = "ci.perf_data_ingest";
const EVAL_TABLE = "ci.eval_data_ingest";

/** `JSONExtract(<json>, 'a', 'b', 'Nullable(<type>)')` for a literal path. */
export function jsonField(json: string, path: (string | number)[], type: string): string {
  const keys = path.map((key) => (typeof key === "number" ? String(key) : `'${key}'`));
  return `JSONExtract(${json}, ${keys.join(", ")}, 'Nullable(${type})')`;
}

const str = (field: string) => jsonField("message", [field], "String");
const int = (field: string) => jsonField("message", [field], "Int64");
const dbl = (field: string) => jsonField("message", [field], "Float64");

const PERF_METRIC_COLUMNS = [
  "tput_per_gpu",
  "input_tput_per_gpu",
  "output_tput_per_gpu",
  "mean_ttft",
  "mean_tpot",
  "mean_itl",
  "mean_e2el",
  "p99_ttft",
  "p99_tpot",
  "p99_itl",
  "p99_e2el",
];
const PERF_MEDIAN_COLUMNS = ["median_ttft", "median_tpot", "median_itl", "median_e2el"];

// `model`, `device` and `perf_date` are the materialized key columns. Selecting
// them under their own names keeps WHERE on the primary key: ClickHouse
// resolves WHERE names to SELECT aliases first.
function perfSelect(metrics: string[]): string {
  return [
    "perf_date AS date",
    "model",
    "device",
    `${int("tp")} AS tp`,
    `${int("conc")} AS conc`,
    `${int("isl")} AS isl`,
    `${int("osl")} AS osl`,
    `${str("precision")} AS precision`,
    `${str("image")} AS image`,
    ...metrics.map((name) => `${dbl(name)} AS ${name}`),
  ].join(",\n      ");
}

// Databricks filters `message:model IS NOT NULL`; the materialized column is
// '' for a missing model. Rows without a date fail the start-date bound.
function perfConditions(startDate: string, params: Record<string, ClickHouseParam>): string[] {
  params.startDate = startDate;
  return ["model != ''", "perf_date >= {startDate:String}"];
}

async function perfRows({ startDate, model, device, tp, conc }: PerfRowsQuery): Promise<PerfRow[]> {
  const params: Record<string, ClickHouseParam> = {};
  const conditions = perfConditions(startDate, params);
  if (model) {
    conditions.push("model = {model:String}");
    params.model = model;
  }
  if (device) {
    conditions.push("device = {device:String}");
    params.device = device;
  }
  if (tp != null) {
    conditions.push(`${int("tp")} = {tp:Int64}`);
    params.tp = tp;
  }
  if (conc != null) {
    conditions.push(`${int("conc")} = {conc:Int64}`);
    params.conc = conc;
  }

  return queryClickHouse<PerfRow>(
    `
    SELECT
      ${perfSelect([...PERF_METRIC_COLUMNS, ...PERF_MEDIAN_COLUMNS])}
    FROM ${PERF_TABLE} FINAL
    WHERE ${conditions.join(" AND ")}
    ORDER BY date ASC, conc ASC NULLS FIRST
    `,
    params,
  );
}

async function perfFilterRows({
  startDate,
  end,
}: {
  startDate: string;
  end?: string | null;
}): Promise<PerfFilterRows> {
  const params: Record<string, ClickHouseParam> = {};
  const conditions = perfConditions(startDate, params);
  if (end) {
    conditions.push("perf_date <= {end:String}");
    params.end = end;
  }
  const where = conditions.join(" AND ");

  const [modelRows, dimRows, imageDateRows] = await Promise.all([
    queryClickHouse<PerfFilterRows["modelRows"][number]>(
      `
      SELECT model, count() AS n
      FROM ${PERF_TABLE} FINAL
      WHERE ${where}
      GROUP BY model
      `,
      params,
    ),
    queryClickHouse<PerfFilterRows["dimRows"][number]>(
      `
      SELECT DISTINCT
        device,
        ${str("tp")} AS tp,
        ${str("conc")} AS conc,
        ${str("precision")} AS precision,
        ${str("image")} AS image
      FROM ${PERF_TABLE} FINAL
      WHERE ${where}
      `,
      params,
    ),
    queryClickHouse<PerfFilterRows["imageDateRows"][number]>(
      `
      SELECT ${str("image")} AS image, max(perf_date) AS last_date
      FROM ${PERF_TABLE} FINAL
      WHERE ${where}
      GROUP BY image
      `,
      params,
    ),
  ]);
  return { modelRows, dimRows, imageDateRows };
}

async function perfRowsByImages(
  images: string[],
  opts: { model?: string | null; device?: string | null },
): Promise<PerfRunRow[]> {
  const params: Record<string, ClickHouseParam> = { images };
  const conditions = [
    ...perfConditions(PERF_DATA_START_DATE, params),
    `${str("image")} IN {images:Array(String)}`,
  ];
  if (opts.model) {
    conditions.push("model = {model:String}");
    params.model = opts.model;
  }
  if (opts.device) {
    conditions.push("device = {device:String}");
    params.device = opts.device;
  }

  return queryClickHouse<PerfRunRow>(
    `
    SELECT
      ${perfSelect(PERF_METRIC_COLUMNS)}
    FROM ${PERF_TABLE} FINAL
    WHERE ${conditions.join(" AND ")}
    ORDER BY date DESC
    `,
    params,
  );
}

// Skip sample messages by key before touching `message`: they hold per-sample
// arrays and are several MB each, while results messages are a few KB.
const EVAL_RESULTS_CONDITIONS = [
  "kind NOT IN ('sample', 'samples')",
  "(JSONType(message, 'results') != 'Null' OR JSONType(message, 'data', 'results') != 'Null')",
];
const EVAL_RUN_EPOCH = `coalesce(${dbl("date")}, ${jsonField("message", ["data", "date"], "Float64")})`;

// Undated messages sort last, newest ingest first (Databricks leaves them unordered).
async function evalResultMessages({ model }: { model?: string | null }): Promise<EvalResultMessage[]> {
  const params: Record<string, ClickHouseParam> = {};
  const conditions = [...EVAL_RESULTS_CONDITIONS];
  if (model) {
    params.model = model;
    const exact = (path: string[]) => `${jsonField("message", path, "String")} = {model:String}`;
    const argString = (path: string[]) =>
      `${jsonField("message", path, "String")} LIKE concat('%model=', {model:String}, '%')`;
    conditions.push(
      `(${[
        exact(["config", "model_args", "model"]),
        exact(["data", "config", "model_args", "model"]),
        argString(["config", "model_args"]),
        argString(["data", "config", "model_args"]),
      ].join(" OR ")})`,
    );
  }

  return queryClickHouse<EvalResultMessage>(
    `
    SELECT
      ${jsonField("request_metadata", ["timestamp"], "String")} AS ingest_ts,
      message AS m
    FROM ${EVAL_TABLE} FINAL
    WHERE ${conditions.join(" AND ")}
    ORDER BY ${EVAL_RUN_EPOCH} DESC, ingested_at DESC
    `,
    params,
  );
}

async function evalFilterMessages({
  startEpoch,
  endEpoch,
}: {
  startEpoch: number | null;
  endEpoch: number | null;
}): Promise<EvalFilterMessage[]> {
  const params: Record<string, ClickHouseParam> = {};
  const conditions = [...EVAL_RESULTS_CONDITIONS];
  if (startEpoch !== null) {
    conditions.push(`${EVAL_RUN_EPOCH} >= {startEpoch:Float64}`);
    params.startEpoch = startEpoch;
  }
  if (endEpoch !== null) {
    conditions.push(`${EVAL_RUN_EPOCH} <= {endEpoch:Float64}`);
    params.endEpoch = endEpoch;
  }

  return queryClickHouse<EvalFilterMessage>(
    `
    SELECT message AS m, ${EVAL_RUN_EPOCH} AS d
    FROM ${EVAL_TABLE} FINAL
    WHERE ${conditions.join(" AND ")}
    `,
    params,
  );
}

// One row per sample: `samples` is an array; older `kind=sample` messages hold
// a single `sample` object. Mirrors the Databricks from_json + EXPLODE.
const SAMPLES_ARRAY = `multiIf(
  JSONType(message, 'samples') = 'Array', JSONExtractArrayRaw(message, 'samples'),
  JSONType(message, 'samples') != 'Null', [],
  JSONType(message, 'sample') = 'Object', [JSONExtractRaw(message, 'sample')],
  []
)`;
const sampleField = (path: (string | number)[], type: string) => jsonField("s", path, type);
const EXACT_MATCH = sampleField(["exact_match"], "Float64");

async function evalSamples({
  buildId,
  task,
  workload,
  correct,
  limit,
}: EvalSamplesQuery): Promise<{ rows: EvalSampleRow[]; counts: EvalSampleCounts }> {
  const params: Record<string, ClickHouseParam> = {
    buildId,
    limit: Math.max(1, Math.floor(limit)),
  };
  const conditions = [
    "kind IN ('sample', 'samples')",
    "buildkite_build_id = {buildId:String}",
  ];
  if (task) {
    conditions.push("task = {task:String}");
    params.task = task;
  }
  // Without workload, a multi-workload build's drawer would merge samples
  // from every model run against this task.
  if (workload) {
    conditions.push(`${str("workload")} = {workload:String}`);
    params.workload = workload;
  }

  const flat = `
    SELECT task, s
    FROM (
      SELECT task, ${SAMPLES_ARRAY} AS samples
      FROM ${EVAL_TABLE} FINAL
      WHERE ${conditions.join(" AND ")}
    )
    ARRAY JOIN samples AS s
  `;
  const correctness =
    correct === "true"
      ? `WHERE ${EXACT_MATCH} >= 1`
      : correct === "false"
      ? `WHERE ${EXACT_MATCH} < 1 OR ${EXACT_MATCH} IS NULL`
      : "";

  const samplesSql = `
    SELECT
      task,
      ${sampleField(["doc_id"], "Int64")} AS doc_id,
      coalesce(${sampleField(["filter"], "String")}, '') AS filter,
      coalesce(${EXACT_MATCH}, 0) AS exact_match,
      coalesce(${sampleField(["doc", "question"], "String")}, '') AS question,
      coalesce(${sampleField(["arguments", 1, "arg_0"], "String")}, '') AS prompt,
      coalesce(${sampleField(["target"], "String")}, ${sampleField(["doc", "answer"], "String")}, '') AS target,
      coalesce(${sampleField(["resps", 1, 1], "String")}, '') AS response,
      coalesce(${sampleField(["filtered_resps", 1], "String")}, '') AS filtered_response
    FROM (${flat})
    ${correctness}
    ORDER BY doc_id ASC NULLS FIRST, filter ASC
    LIMIT {limit:UInt32}
  `;

  const countsSql = `
    SELECT
      countIf(${EXACT_MATCH} >= 1) AS correct,
      countIf(${EXACT_MATCH} < 1 OR ${EXACT_MATCH} IS NULL) AS incorrect
    FROM (${flat})
  `;

  const [rows, countRows] = await Promise.all([
    queryClickHouse<EvalSampleRow>(samplesSql, params),
    queryClickHouse<EvalSampleCounts>(countsSql, params),
  ]);
  return { rows, counts: countRows[0] ?? { correct: 0, incorrect: 0 } };
}

export const clickHousePerfEvalStore: PerfEvalStore = {
  perfRows,
  perfFilterRows,
  perfRowsByImages,
  evalResultMessages,
  evalFilterMessages,
  evalSamples,
};
