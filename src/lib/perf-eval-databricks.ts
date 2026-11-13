/**
 * Databricks query builders for the perf and eval pages. Legacy: delete this
 * file once PERF_EVAL_SOURCE=clickhouse is the only path.
 */
import { queryDatabricks } from "@/lib/databricks";
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
import { escapeSqlString } from "@/lib/sql-literal";

const PERF_TABLE = "vllm_data_warehouse.default.vllm_perf_data_ingest";
const EVAL_TABLE = "vllm_data_warehouse.default.vllm_eval_data_ingest";

function perfDataStartCondition(startDate: string): string {
  return `message:date::STRING >= '${escapeSqlString(startDate)}'`;
}

async function perfRows({ startDate, model, device, tp, conc }: PerfRowsQuery): Promise<PerfRow[]> {
  const conditions = [
    "message:model IS NOT NULL",
    perfDataStartCondition(startDate),
  ];
  if (model) conditions.push(`message:model::STRING = '${escapeSqlString(model)}'`);
  if (device) conditions.push(`message:device::STRING = '${escapeSqlString(device)}'`);
  if (tp != null) conditions.push(`message:tp::INT = ${tp}`);
  if (conc != null) conditions.push(`message:conc::INT = ${conc}`);

  return queryDatabricks<PerfRow>(`
    SELECT
      message:date::STRING AS date,
      message:model::STRING AS model,
      message:device::STRING AS device,
      message:tp::INT AS tp,
      message:conc::INT AS conc,
      message:isl::INT AS isl,
      message:osl::INT AS osl,
      message:precision::STRING AS precision,
      message:image::STRING AS image,
      message:tput_per_gpu::DOUBLE AS tput_per_gpu,
      message:input_tput_per_gpu::DOUBLE AS input_tput_per_gpu,
      message:output_tput_per_gpu::DOUBLE AS output_tput_per_gpu,
      message:mean_ttft::DOUBLE AS mean_ttft,
      message:mean_tpot::DOUBLE AS mean_tpot,
      message:mean_itl::DOUBLE AS mean_itl,
      message:mean_e2el::DOUBLE AS mean_e2el,
      message:p99_ttft::DOUBLE AS p99_ttft,
      message:p99_tpot::DOUBLE AS p99_tpot,
      message:p99_itl::DOUBLE AS p99_itl,
      message:p99_e2el::DOUBLE AS p99_e2el,
      message:median_ttft::DOUBLE AS median_ttft,
      message:median_tpot::DOUBLE AS median_tpot,
      message:median_itl::DOUBLE AS median_itl,
      message:median_e2el::DOUBLE AS median_e2el
    FROM ${PERF_TABLE}
    WHERE ${conditions.join(" AND ")}
    ORDER BY message:date::STRING ASC, message:conc::INT ASC
  `);
}

async function perfFilterRows({
  startDate,
  end,
}: {
  startDate: string;
  end?: string | null;
}): Promise<PerfFilterRows> {
  const conditions = [
    "message:model IS NOT NULL",
    perfDataStartCondition(startDate),
  ];
  if (end) conditions.push(`message:date::STRING <= '${escapeSqlString(end)}'`);
  const where = conditions.join(" AND ");

  const [modelRows, dimRows, imageDateRows] = await Promise.all([
    queryDatabricks<PerfFilterRows["modelRows"][number]>(`
      SELECT message:model::STRING AS model, COUNT(*) AS n
      FROM ${PERF_TABLE}
      WHERE ${where}
      GROUP BY message:model::STRING
    `),
    queryDatabricks<PerfFilterRows["dimRows"][number]>(`
      SELECT DISTINCT
        message:device::STRING AS device,
        message:tp::STRING AS tp,
        message:conc::STRING AS conc,
        message:precision::STRING AS precision,
        message:image::STRING AS image
      FROM ${PERF_TABLE}
      WHERE ${where}
    `),
    queryDatabricks<PerfFilterRows["imageDateRows"][number]>(`
      SELECT
        message:image::STRING AS image,
        MAX(message:date::STRING) AS last_date
      FROM ${PERF_TABLE}
      WHERE ${where}
      GROUP BY message:image::STRING
    `),
  ]);
  return { modelRows, dimRows, imageDateRows };
}

async function perfRowsByImages(
  images: string[],
  opts: { model?: string | null; device?: string | null },
): Promise<PerfRunRow[]> {
  const escapedImages = images.map((i) => `'${escapeSqlString(i)}'`).join(", ");
  const conditions = [
    "message:model IS NOT NULL",
    perfDataStartCondition(PERF_DATA_START_DATE),
    `message:image::STRING IN (${escapedImages})`,
  ];
  if (opts.model) {
    conditions.push(`message:model::STRING = '${escapeSqlString(opts.model)}'`);
  }
  if (opts.device) {
    conditions.push(`message:device::STRING = '${escapeSqlString(opts.device)}'`);
  }

  return queryDatabricks<PerfRunRow>(`
    SELECT
      message:date::STRING AS date,
      message:model::STRING AS model,
      message:device::STRING AS device,
      message:tp::INT AS tp,
      message:conc::INT AS conc,
      message:isl::INT AS isl,
      message:osl::INT AS osl,
      message:precision::STRING AS precision,
      message:image::STRING AS image,
      message:tput_per_gpu::DOUBLE AS tput_per_gpu,
      message:input_tput_per_gpu::DOUBLE AS input_tput_per_gpu,
      message:output_tput_per_gpu::DOUBLE AS output_tput_per_gpu,
      message:mean_ttft::DOUBLE AS mean_ttft,
      message:mean_tpot::DOUBLE AS mean_tpot,
      message:mean_itl::DOUBLE AS mean_itl,
      message:mean_e2el::DOUBLE AS mean_e2el,
      message:p99_ttft::DOUBLE AS p99_ttft,
      message:p99_tpot::DOUBLE AS p99_tpot,
      message:p99_itl::DOUBLE AS p99_itl,
      message:p99_e2el::DOUBLE AS p99_e2el
    FROM ${PERF_TABLE}
    WHERE ${conditions.join(" AND ")}
    ORDER BY message:date::STRING DESC
  `);
}

const EVAL_HAS_RESULTS =
  "(message:results IS NOT NULL OR message:data:results IS NOT NULL)";
const EVAL_RUN_EPOCH = "COALESCE(message:date::DOUBLE, message:data:date::DOUBLE)";

async function evalResultMessages({ model }: { model?: string | null }): Promise<EvalResultMessage[]> {
  const conditions = [EVAL_HAS_RESULTS];
  if (model) {
    const esc = escapeSqlString(model);
    conditions.push(
      `(message:config:model_args:model::STRING = '${esc}' OR message:data:config:model_args:model::STRING = '${esc}' OR message:config:model_args::STRING LIKE '%model=${esc}%' OR message:data:config:model_args::STRING LIKE '%model=${esc}%')`
    );
  }

  return queryDatabricks<EvalResultMessage>(`
    SELECT
      CAST(request_metadata:timestamp AS STRING) AS ingest_ts,
      CAST(message AS STRING) AS m
    FROM ${EVAL_TABLE}
    WHERE ${conditions.join(" AND ")}
    ORDER BY ${EVAL_RUN_EPOCH} DESC
  `);
}

async function evalFilterMessages({
  startEpoch,
  endEpoch,
}: {
  startEpoch: number | null;
  endEpoch: number | null;
}): Promise<EvalFilterMessage[]> {
  const conditions = [EVAL_HAS_RESULTS];
  if (startEpoch !== null) conditions.push(`${EVAL_RUN_EPOCH} >= ${startEpoch}`);
  if (endEpoch !== null) conditions.push(`${EVAL_RUN_EPOCH} <= ${endEpoch}`);

  return queryDatabricks<EvalFilterMessage>(`
    SELECT CAST(message AS STRING) AS m,
      ${EVAL_RUN_EPOCH} AS d
    FROM ${EVAL_TABLE}
    WHERE ${conditions.join(" AND ")}
  `);
}

// Schema applied via from_json to the message:samples array. Older `kind=sample`
// (singular) rows wrap the single entry into a 1-element array via SQL.
const SAMPLE_SCHEMA = `array<struct<
  doc_id: bigint,
  task: string,
  filter: string,
  exact_match: double,
  doc: struct<question: string, answer: string>,
  arguments: map<string, struct<arg_0: string>>,
  target: string,
  resps: array<array<string>>,
  filtered_resps: array<string>
>>`.replace(/\s+/g, " ");

function buildSamplesCte(conds: string[]): string {
  return `
    WITH src AS (
      SELECT
        CAST(message:task AS STRING) AS task,
        from_json(
          COALESCE(
            CAST(message:samples AS STRING),
            CONCAT('[', CAST(message:sample AS STRING), ']')
          ),
          '${SAMPLE_SCHEMA}'
        ) AS arr
      FROM ${EVAL_TABLE}
      WHERE ${conds.join(" AND ")}
    ),
    flat AS (
      SELECT src.task AS task, s
      FROM src LATERAL VIEW EXPLODE(arr) AS s
    )
  `;
}

async function evalSamples({
  buildId,
  task,
  workload,
  correct,
  limit,
}: EvalSamplesQuery): Promise<{ rows: EvalSampleRow[]; counts: EvalSampleCounts }> {
  const conds = [
    "CAST(message:kind AS STRING) IN ('sample', 'samples')",
    `CAST(message:buildkite_build_id AS STRING) = '${escapeSqlString(buildId)}'`,
  ];
  if (task) conds.push(`CAST(message:task AS STRING) = '${escapeSqlString(task)}'`);
  if (workload) conds.push(`CAST(message:workload AS STRING) = '${escapeSqlString(workload)}'`);

  const cte = buildSamplesCte(conds);
  const correctnessClause =
    correct === "true"
      ? "WHERE s.exact_match >= 1"
      : correct === "false"
      ? "WHERE s.exact_match < 1 OR s.exact_match IS NULL"
      : "";

  const samplesSql = `
    ${cte}
    SELECT
      task,
      s.doc_id AS doc_id,
      COALESCE(s.filter, '') AS filter,
      COALESCE(s.exact_match, 0.0) AS exact_match,
      COALESCE(s.doc.question, '') AS question,
      COALESCE(MAP_VALUES(s.arguments)[0].arg_0, '') AS prompt,
      COALESCE(s.target, s.doc.answer, '') AS target,
      COALESCE(s.resps[0][0], '') AS response,
      COALESCE(s.filtered_resps[0], '') AS filtered_response
    FROM flat
    ${correctnessClause}
    ORDER BY doc_id, filter
    LIMIT ${Math.max(1, Math.floor(limit))}
  `;

  const countsSql = `
    ${cte}
    SELECT
      SUM(CASE WHEN s.exact_match >= 1 THEN 1 ELSE 0 END) AS correct,
      SUM(CASE WHEN s.exact_match < 1 OR s.exact_match IS NULL THEN 1 ELSE 0 END) AS incorrect
    FROM flat
  `;

  const [rows, countRows] = await Promise.all([
    queryDatabricks<EvalSampleRow>(samplesSql),
    queryDatabricks<EvalSampleCounts>(countsSql),
  ]);
  return { rows, counts: countRows[0] ?? { correct: 0, incorrect: 0 } };
}

export const databricksPerfEvalStore: PerfEvalStore = {
  perfRows,
  perfFilterRows,
  perfRowsByImages,
  evalResultMessages,
  evalFilterMessages,
  evalSamples,
};
