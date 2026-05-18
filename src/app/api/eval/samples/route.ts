import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";

export interface EvalSample {
  doc_id: number;
  task: string;
  filter: string;
  exact_match: number;
  question: string;
  prompt: string;
  target: string;
  response: string;
  filtered_response: string;
  metrics: string[];
}

interface FlatRow {
  task: string;
  doc_id: string | number | null;
  filter: string | null;
  exact_match: string | number | null;
  question: string | null;
  prompt: string | null;
  target: string | null;
  response: string | null;
  filtered_response: string | null;
}

interface CountRow {
  correct: string | number | null;
  incorrect: string | number | null;
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

function buildBaseCte(conds: string[]): string {
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
      FROM vllm_data_warehouse.default.vllm_eval_data_ingest
      WHERE ${conds.join(" AND ")}
    ),
    flat AS (
      SELECT src.task AS task, s
      FROM src LATERAL VIEW EXPLODE(arr) AS s
    )
  `;
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const buildId = sp.get("build_id");
    const taskParam = sp.get("task");
    const workloadParam = sp.get("workload");
    const correct = sp.get("correct"); // "true" | "false" | null (all)
    const limitParam = parseInt(sp.get("limit") ?? "200", 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 5000) : 200;

    if (!buildId) {
      return NextResponse.json({ error: "Missing build_id" }, { status: 400 });
    }

    const cacheKey = `eval:samples:${buildId}:${taskParam}:${workloadParam}:${correct}:${limit}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    const escBuild = buildId.replace(/'/g, "''");
    const escTask = taskParam ? taskParam.replace(/'/g, "''") : null;
    const escWorkload = workloadParam ? workloadParam.replace(/'/g, "''") : null;

    const conds = [
      "CAST(message:kind AS STRING) IN ('sample', 'samples')",
      `CAST(message:buildkite_build_id AS STRING) = '${escBuild}'`,
    ];
    if (escTask) conds.push(`CAST(message:task AS STRING) = '${escTask}'`);
    // Without workload, a multi-workload build's drawer would merge samples
    // from every model run against this task.
    if (escWorkload) conds.push(`CAST(message:workload AS STRING) = '${escWorkload}'`);

    const cte = buildBaseCte(conds);

    const correctnessClause =
      correct === "true"
        ? "WHERE s.exact_match >= 1"
        : correct === "false"
        ? "WHERE s.exact_match < 1 OR s.exact_match IS NULL"
        : "";

    // Fetch one extra row to detect truncation without a separate COUNT.
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
      LIMIT ${limit + 1}
    `;

    // Counts always reflect the FULL set so the drawer's filter pills show totals.
    const countsSql = `
      ${cte}
      SELECT
        SUM(CASE WHEN s.exact_match >= 1 THEN 1 ELSE 0 END) AS correct,
        SUM(CASE WHEN s.exact_match < 1 OR s.exact_match IS NULL THEN 1 ELSE 0 END) AS incorrect
      FROM flat
    `;

    const [flatRows, countRows] = await Promise.all([
      queryDatabricks<FlatRow>(samplesSql),
      queryDatabricks<CountRow>(countsSql),
    ]);

    const truncated = flatRows.length > limit;
    const sliced = truncated ? flatRows.slice(0, limit) : flatRows;

    const samples: EvalSample[] = sliced.map((r) => ({
      doc_id: r.doc_id == null ? -1 : Number(r.doc_id),
      task: r.task ?? "",
      filter: r.filter ?? "",
      exact_match: r.exact_match == null ? 0 : Number(r.exact_match),
      question: r.question ?? "",
      prompt: r.prompt ?? "",
      target: r.target ?? "",
      response: r.response ?? "",
      filtered_response: r.filtered_response ?? "",
      metrics: [],
    }));

    const correctCount = Number(countRows[0]?.correct ?? 0);
    const incorrectCount = Number(countRows[0]?.incorrect ?? 0);

    const result = {
      samples,
      total: correctCount + incorrectCount,
      correct: correctCount,
      incorrect: incorrectCount,
      truncated,
    };
    setCache(cacheKey, result, 60_000);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch eval samples:", error);
    return NextResponse.json(
      { error: "Failed to fetch evaluation samples" },
      { status: 500 }
    );
  }
}
