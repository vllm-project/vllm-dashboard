/**
 * Where the perf and eval pages read their ingest tables from.
 *
 * The same perf-eval events land in Databricks (`vllm_perf_data_ingest`,
 * `vllm_eval_data_ingest`) and ClickHouse (`ci.perf_data_ingest`,
 * `ci.eval_data_ingest`). Each source has its own query builders behind the
 * `PerfEvalStore` interface, so the Databricks side can be deleted by removing
 * `perf-eval-databricks.ts` and the switch below.
 *
 * Precedence: `?source=clickhouse|databricks` wins, then the
 * `PERF_EVAL_SOURCE` env var, else `databricks`.
 */
import { clickHousePerfEvalStore } from "@/lib/perf-eval-clickhouse";
import { databricksPerfEvalStore } from "@/lib/perf-eval-databricks";

export type PerfEvalSource = "clickhouse" | "databricks";

type Cell = string | number | null;

/** One perf datapoint as the /api/perf route returns it. */
export interface PerfRow {
  date: string | null;
  model: string | null;
  device: string | null;
  tp: Cell;
  conc: Cell;
  isl: Cell;
  osl: Cell;
  precision: string | null;
  image: string | null;
  tput_per_gpu: Cell;
  input_tput_per_gpu: Cell;
  output_tput_per_gpu: Cell;
  mean_ttft: Cell;
  mean_tpot: Cell;
  mean_itl: Cell;
  mean_e2el: Cell;
  p99_ttft: Cell;
  p99_tpot: Cell;
  p99_itl: Cell;
  p99_e2el: Cell;
  median_ttft: Cell;
  median_tpot: Cell;
  median_itl: Cell;
  median_e2el: Cell;
}

/** A perf datapoint for image comparison (no median columns). */
export type PerfRunRow = Omit<PerfRow, "median_ttft" | "median_tpot" | "median_itl" | "median_e2el">;

export interface PerfRowsQuery {
  startDate: string;
  model?: string | null;
  device?: string | null;
  tp?: number | null;
  conc?: number | null;
}

export interface PerfFilterRows {
  modelRows: { model: string | null; n: Cell }[];
  dimRows: {
    device: string | null;
    tp: string | null;
    conc: string | null;
    precision: string | null;
    image: string | null;
  }[];
  imageDateRows: { image: string | null; last_date: string | null }[];
}

/** A raw lm-eval results message, as JSON text. */
export interface EvalResultMessage {
  ingest_ts: string | null;
  m: string;
}

export interface EvalFilterMessage {
  m: string;
  d: Cell;
}

export interface EvalSamplesQuery {
  buildId: string;
  task?: string | null;
  workload?: string | null;
  correct?: "true" | "false" | null;
  /** Maximum rows to return. */
  limit: number;
}

export interface EvalSampleRow {
  task: string | null;
  doc_id: Cell;
  filter: string | null;
  exact_match: Cell;
  question: string | null;
  prompt: string | null;
  target: string | null;
  response: string | null;
  filtered_response: string | null;
}

export interface EvalSampleCounts {
  correct: Cell;
  incorrect: Cell;
}

export interface PerfEvalStore {
  /** Rows for /api/perf, ordered by date then concurrency. */
  perfRows(query: PerfRowsQuery): Promise<PerfRow[]>;
  /** Raw dimension rows for /api/perf/filters. `end` is a YYYY-MM-DD date. */
  perfFilterRows(query: { startDate: string; end?: string | null }): Promise<PerfFilterRows>;
  /** Rows for the given images since the default start date, newest first. */
  perfRowsByImages(
    images: string[],
    opts: { model?: string | null; device?: string | null },
  ): Promise<PerfRunRow[]>;
  /** lm-eval results messages, newest run first. */
  evalResultMessages(query: { model?: string | null }): Promise<EvalResultMessage[]>;
  /** lm-eval results messages with their run epoch, bounded by epoch seconds. */
  evalFilterMessages(query: {
    startEpoch: number | null;
    endEpoch: number | null;
  }): Promise<EvalFilterMessage[]>;
  /** Per-sample rows for one build plus correct/incorrect totals over the full set. */
  evalSamples(query: EvalSamplesQuery): Promise<{ rows: EvalSampleRow[]; counts: EvalSampleCounts }>;
}

function parseSource(value: string | null | undefined): PerfEvalSource | undefined {
  if (value === "clickhouse" || value === "databricks") return value;
  return undefined;
}

export function resolvePerfEvalSource(searchParams?: URLSearchParams): PerfEvalSource {
  return parseSource(searchParams?.get("source"))
    ?? parseSource(process.env.PERF_EVAL_SOURCE)
    ?? "databricks";
}

export function perfEvalStore(source: PerfEvalSource): PerfEvalStore {
  return source === "clickhouse" ? clickHousePerfEvalStore : databricksPerfEvalStore;
}
