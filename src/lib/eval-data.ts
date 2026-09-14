import { queryDatabricks } from "@/lib/databricks";
import { commitFromImage } from "@/lib/commit-from-image";
import {
  imageFromMessage,
  resolveEvalImage,
  workloadFromSourceFile,
} from "@/lib/eval-images";

export interface EvalMetric {
  name: string;
  filter: string;
  value: number;
  stderr: number;
  higher_is_better: boolean;
}

export interface EvalRow {
  ingest_ts: string;
  run_date: string;
  run_epoch: number;
  model: string;
  task: string;
  n_shot: number;
  n_samples: number;
  git_hash: string | null;
  eval_seconds: number;
  metrics: EvalMetric[];
  image: string | null;
  buildkite_build_id: string | null;
  buildkite_build_number: string | null;
  buildkite_build_url: string | null;
  buildkite_commit: string | null;
  vllm_commit: string | null;
  workload: string | null;
  duplicateCount: number;
}

interface RawRow {
  ingest_ts: string;
  m: string;
}

interface LmEvalCore {
  date?: number;
  config?: { model_args?: Record<string, unknown> };
  configs?: Record<string, Record<string, unknown>>;
  results?: Record<string, Record<string, number | string>>;
  versions?: Record<string, number>;
  higher_is_better?: Record<string, Record<string, boolean>>;
  total_evaluation_time_seconds?: string | number;
  lm_eval_version?: string;
  git_hash?: string;
  ["n-shot"]?: Record<string, number>;
  ["n-samples"]?: Record<string, { effective?: number; original?: number }>;
}

interface LmEvalMessage extends LmEvalCore {
  kind?: string;
  data?: LmEvalCore;
  task?: string;
  workload?: string;
  source_file?: string;
  buildkite_build_id?: string;
  buildkite_build_number?: string;
  buildkite_build_url?: string;
  buildkite_commit?: string;
  buildkite_branch?: string;
  buildkite_pipeline_slug?: string;
  vllm_commit?: string;
  [key: string]: unknown;
}

export interface EvalRowsQuery {
  model?: string | null;
  task?: string | null;
  image?: string | null;
  images?: string[];
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function buildConditions(model?: string | null): string[] {
  const conditions = [
    "(message:results IS NOT NULL OR message:data:results IS NOT NULL)",
  ];
  if (model) {
    const esc = escapeSqlString(model);
    conditions.push(
      `(message:config:model_args:model::STRING = '${esc}' OR message:data:config:model_args:model::STRING = '${esc}' OR message:config:model_args::STRING LIKE '%model=${esc}%' OR message:data:config:model_args::STRING LIKE '%model=${esc}%')`
    );
  }
  return conditions;
}

export function parseEvalMetrics(
  taskResults: Record<string, number | string>,
  hib: Record<string, boolean>
): EvalMetric[] {
  const groups = new Map<
    string,
    { name: string; filter: string; value?: number; stderr?: number }
  >();

  for (const key of Object.keys(taskResults)) {
    if (key === "alias") continue;
    const m = key.match(/^(.+?)(_stderr)?,(.+)$/);
    if (!m) continue;
    const [, metricName, stderrSuffix, filterName] = m;
    const k = `${metricName}|${filterName}`;
    if (!groups.has(k)) groups.set(k, { name: metricName, filter: filterName });
    const entry = groups.get(k)!;
    const v = taskResults[key];
    const num = typeof v === "number" ? v : parseFloat(String(v));
    if (stderrSuffix) entry.stderr = num;
    else entry.value = num;
  }

  const out: EvalMetric[] = [];
  for (const g of groups.values()) {
    if (g.value === undefined || isNaN(g.value)) continue;
    out.push({
      name: g.name,
      filter: g.filter,
      value: g.value,
      stderr: g.stderr ?? 0,
      higher_is_better: hib[g.name] ?? true,
    });
  }
  return out;
}

function extractModel(modelArgs: unknown): string | null {
  if (!modelArgs) return null;
  if (typeof modelArgs === "object" && modelArgs !== null && "model" in modelArgs) {
    return (modelArgs as Record<string, unknown>).model as string;
  }
  if (typeof modelArgs === "string") {
    const m = modelArgs.match(/(?:^|,)model=([^,]+)/);
    if (m) return m[1];
  }
  return null;
}

// CI often ingests the same lm-eval result more than once (retries, mirror
// uploads). Runs are duplicates when every identifying field matches and they
// land within this window of the first occurrence.
export const DEDUPE_WINDOW_SECONDS = 10 * 60;

// Number of prior runs (same model+task, newest first) that form the rolling
// baseline a run is compared against.
export const BASELINE_WINDOW = 5;

// A change is only worth flagging when it exceeds both the statistical noise
// (2 × stderr) and a floor of one percentage point.
export const FLAG_FLOOR = 0.01;

function dedupeKey(row: EvalRow): string {
  const commit =
    commitFromImage(row.image) ??
    row.vllm_commit ??
    row.buildkite_commit ??
    row.git_hash ??
    "";
  const metrics = row.metrics
    .map((m) => `${m.name},${m.filter}=${m.value}:${m.stderr}`)
    .sort()
    .join(";");
  return [row.model, row.task, commit, row.image ?? "", metrics, row.n_samples].join("|");
}

// Collapse duplicate ingests: same model, task, commit, image, score, stderr
// and sample count within DEDUPE_WINDOW_SECONDS keep only the earliest run,
// which records how many rows were merged into it.
export function dedupeEvalRows(rows: EvalRow[]): EvalRow[] {
  const sorted = [...rows].sort((a, b) => a.run_epoch - b.run_epoch);
  const open = new Map<string, { firstEpoch: number; kept: EvalRow }>();
  const kept: EvalRow[] = [];
  for (const row of sorted) {
    const key = dedupeKey(row);
    const group = open.get(key);
    if (group && row.run_epoch - group.firstEpoch <= DEDUPE_WINDOW_SECONDS) {
      group.kept.duplicateCount += 1;
      continue;
    }
    const copy = { ...row, duplicateCount: 1 };
    open.set(key, { firstEpoch: row.run_epoch, kept: copy });
    kept.push(copy);
  }
  return kept.sort((a, b) => b.run_epoch - a.run_epoch);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface BaselineComparison {
  baseline: number;
  baselineCount: number;
  delta: number;
  sigma: number;
  flagged: boolean;
}

// Compare a run against the rolling baseline: the median of the last
// `window` prior runs for the same model+task. `prior` is newest-first.
// Sigma combines the run's stderr with the median baseline stderr.
export function compareToRollingBaseline(
  current: { value: number; stderr: number },
  prior: { value: number; stderr: number }[],
  window: number = BASELINE_WINDOW
): BaselineComparison | null {
  const sample = prior.slice(0, Math.max(0, window));
  const baseline = median(sample.map((p) => p.value));
  if (baseline === null) return null;
  const baseStderr = median(sample.map((p) => p.stderr)) ?? 0;
  const delta = current.value - baseline;
  const combined = Math.sqrt(current.stderr ** 2 + baseStderr ** 2);
  const sigma = combined > 0 ? Math.abs(delta) / combined : 0;
  const flagged = Math.abs(delta) > Math.max(2 * current.stderr, FLAG_FLOOR);
  return { baseline, baselineCount: sample.length, delta, sigma, flagged };
}

export async function loadEvalRows({
  model,
  task,
  image,
  images,
}: EvalRowsQuery = {}): Promise<EvalRow[]> {
  const conditions = buildConditions(model);

  const rawRows = await queryDatabricks<RawRow>(`
    SELECT
      CAST(request_metadata:timestamp AS STRING) AS ingest_ts,
      CAST(message AS STRING) AS m
    FROM vllm_data_warehouse.default.vllm_eval_data_ingest
    WHERE ${conditions.join(" AND ")}
    ORDER BY COALESCE(message:date::DOUBLE, message:data:date::DOUBLE) DESC
  `);

  const out: EvalRow[] = [];
  const imageBackfills: {
    row: EvalRow;
    raw: LmEvalMessage;
    core: LmEvalCore;
    taskName: string;
  }[] = [];

  for (const r of rawRows) {
    let raw: LmEvalMessage;
    try {
      raw = JSON.parse(r.m);
    } catch {
      continue;
    }
    const core: LmEvalCore = raw.data ?? raw;
    if (!core?.results) continue;

    for (const taskName of Object.keys(core.results)) {
      if (task && taskName !== task) continue;
      const taskResults = core.results[taskName];
      const hib = core.higher_is_better?.[taskName] ?? {};
      const metrics = parseEvalMetrics(taskResults, hib);
      const ingestEpoch = r.ingest_ts ? Math.floor(new Date(r.ingest_ts).getTime() / 1000) : 0;
      const epoch = core.date || ingestEpoch;
      const workload = raw.workload ?? workloadFromSourceFile(raw.source_file);
      const row: EvalRow = {
        ingest_ts: r.ingest_ts,
        run_epoch: epoch,
        run_date: new Date(epoch * 1000).toISOString(),
        model: extractModel(core.config?.model_args) ?? "",
        task: taskName,
        n_shot: core["n-shot"]?.[taskName] ?? 0,
        n_samples: core["n-samples"]?.[taskName]?.effective ?? 0,
        git_hash: core.git_hash ?? null,
        eval_seconds:
          typeof core.total_evaluation_time_seconds === "number"
            ? core.total_evaluation_time_seconds
            : parseFloat(String(core.total_evaluation_time_seconds ?? "0")),
        metrics,
        image: imageFromMessage(raw, core, taskName),
        buildkite_build_id: raw.buildkite_build_id ?? null,
        buildkite_build_number: raw.buildkite_build_number ?? null,
        buildkite_build_url: raw.buildkite_build_url ?? null,
        buildkite_commit: raw.buildkite_commit ?? null,
        vllm_commit: raw.vllm_commit ?? null,
        workload,
        duplicateCount: 1,
      };

      out.push(row);
      if (!row.image) imageBackfills.push({ row, raw, core, taskName });
    }
  }

  await Promise.all(
    imageBackfills.map(async ({ row, raw, core, taskName }) => {
      row.image = await resolveEvalImage(raw, core, taskName);
    })
  );

  const imageValues = [...(images ?? []), image ?? ""].filter(Boolean);
  if (imageValues.length === 0) return dedupeEvalRows(out);

  const imageSet = new Set(imageValues);
  return dedupeEvalRows(
    out.filter((row) => row.image !== null && imageSet.has(row.image))
  );
}

// Distinct task count over the full filtered dataset. The rows query is
// truncated by Databricks INLINE limits, so client-side counting only sees
// the first page. Selecting just the results map keeps the payload small
// enough to count every task server-side. The image filter is resolved in
// JS and cannot be pushed into SQL, so it is not applied here.
export async function loadEvalTaskCount({
  model,
  task,
}: Pick<EvalRowsQuery, "model" | "task"> = {}): Promise<number> {
  const conditions = buildConditions(model);
  const rows = await queryDatabricks<{ r: string | null }>(`
    SELECT CAST(COALESCE(message:results, message:data:results) AS STRING) AS r
    FROM vllm_data_warehouse.default.vllm_eval_data_ingest
    WHERE ${conditions.join(" AND ")}
  `);
  const tasks = new Set<string>();
  for (const row of rows) {
    if (!row.r) continue;
    try {
      for (const key of Object.keys(JSON.parse(row.r))) {
        if (!task || key === task) tasks.add(key);
      }
    } catch {
      continue;
    }
  }
  return tasks.size;
}
