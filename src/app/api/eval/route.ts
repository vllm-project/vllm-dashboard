import { NextRequest, NextResponse } from "next/server";
import { load } from "js-yaml";
import { queryDatabricks } from "@/lib/databricks";

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
  version: number;
  git_hash: string | null;
  lm_eval_version: string | null;
  eval_seconds: number;
  metrics: EvalMetric[];
  config: Record<string, unknown>;
  model_args: Record<string, unknown>;
  image: string | null;
  // From buildkite metadata on newer ingest format. May be null for older rows.
  buildkite_build_id: string | null;
  buildkite_build_number: string | null;
  buildkite_build_url: string | null;
  buildkite_commit: string | null;
  buildkite_branch: string | null;
  workload: string | null;
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
  // newer "results"-kind rows wrap the lm-eval blob under `data` and add
  // buildkite metadata at the top level
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
}

const PERF_EVAL_RAW_BASE =
  "https://raw.githubusercontent.com/vllm-project/perf-eval";
const DEFAULT_VLLM_IMAGE = "vllm/vllm-openai:latest";
const workloadImageCache = new Map<string, Promise<string | null>>();

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function workloadFromSourceFile(sourceFile?: string): string | null {
  const match = sourceFile?.match(/^results\/([^/]+)/);
  return match?.[1] ?? null;
}

function workloadPathCandidates(workload: string): string[] {
  const base = workload.trim().replace(/\.ya?ml$/, "");
  const underscored = base.replace(/-/g, "_");
  return [...new Set([base, underscored])].map((name) => `workloads/${name}.yaml`);
}

async function resolveWorkloadImage(
  commit: string,
  workload: string
): Promise<string | null> {
  for (const path of workloadPathCandidates(workload)) {
    const response = await fetch(`${PERF_EVAL_RAW_BASE}/${commit}/${path}`);
    if (response.status === 404) continue;
    if (!response.ok) continue;

    const parsed = recordValue(load(await response.text()));
    const vllm = recordValue(parsed.vllm);
    return stringValue(vllm.image) ?? DEFAULT_VLLM_IMAGE;
  }
  return null;
}

function getWorkloadImage(commit: string, workload: string) {
  const key = `${commit}|${workload}`;
  let cached = workloadImageCache.get(key);
  if (!cached) {
    cached = resolveWorkloadImage(commit, workload).catch((error) => {
      console.warn("Failed to resolve eval workload image:", error);
      return null;
    });
    workloadImageCache.set(key, cached);
  }
  return cached;
}

function imageFromMessage(
  raw: LmEvalMessage,
  core: LmEvalCore,
  taskName: string
): string | null {
  const rawRecord = raw as Record<string, unknown>;
  const coreRecord = core as Record<string, unknown>;
  const taskConfig = core.configs?.[taskName] ?? {};
  const metadata = recordValue(taskConfig.metadata);
  const modelArgs = core.config?.model_args ?? {};

  return (
    stringValue(rawRecord.image) ??
    stringValue(rawRecord.vllm_image) ??
    stringValue(rawRecord.docker_image) ??
    stringValue(coreRecord.image) ??
    stringValue(coreRecord.vllm_image) ??
    stringValue(coreRecord.docker_image) ??
    stringValue(modelArgs.image) ??
    stringValue(metadata.image)
  );
}

function parseMetrics(
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

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const model = sp.get("model");
    const task = sp.get("task");

    // Both old (top-level `results`) and new (`data.results` under `kind=results`)
    // ingest formats are accepted.
    const conditions = [
      "(message:results IS NOT NULL OR message:data:results IS NOT NULL)",
    ];
    if (model) {
      const esc = model.replace(/'/g, "''");
      conditions.push(
        `(message:config:model_args:model::STRING = '${esc}' OR message:data:config:model_args:model::STRING = '${esc}')`
      );
    }
    const where = conditions.join(" AND ");

    const rawRows = await queryDatabricks<RawRow>(`
      SELECT
        CAST(request_metadata:timestamp AS STRING) AS ingest_ts,
        CAST(message AS STRING) AS m
      FROM vllm_data_warehouse.default.vllm_eval_data_ingest
      WHERE ${where}
      ORDER BY COALESCE(message:date::DOUBLE, message:data:date::DOUBLE) DESC
    `);

    const out: EvalRow[] = [];
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
        const metrics = parseMetrics(taskResults, hib);
        const epoch = core.date ?? 0;

        const workload = raw.workload ?? workloadFromSourceFile(raw.source_file);

        out.push({
          ingest_ts: r.ingest_ts,
          run_epoch: epoch,
          run_date: new Date(epoch * 1000).toISOString(),
          model: (core.config?.model_args?.model as string) ?? "",
          task: taskName,
          n_shot: core["n-shot"]?.[taskName] ?? 0,
          n_samples: core["n-samples"]?.[taskName]?.effective ?? 0,
          version: core.versions?.[taskName] ?? 0,
          git_hash: core.git_hash ?? null,
          lm_eval_version: core.lm_eval_version ?? null,
          eval_seconds:
            typeof core.total_evaluation_time_seconds === "number"
              ? core.total_evaluation_time_seconds
              : parseFloat(String(core.total_evaluation_time_seconds ?? "0")),
          metrics,
          config: core.configs?.[taskName] ?? {},
          model_args: core.config?.model_args ?? {},
          image: imageFromMessage(raw, core, taskName),
          buildkite_build_id: raw.buildkite_build_id ?? null,
          buildkite_build_number: raw.buildkite_build_number ?? null,
          buildkite_build_url: raw.buildkite_build_url ?? null,
          buildkite_commit: raw.buildkite_commit ?? null,
          buildkite_branch: raw.buildkite_branch ?? null,
          workload,
        });
      }
    }

    await Promise.all(
      out.map(async (row) => {
        if (row.image || !row.buildkite_commit || !row.workload) return;
        row.image = await getWorkloadImage(row.buildkite_commit, row.workload);
      })
    );

    return NextResponse.json({ rows: out });
  } catch (error) {
    console.error("Failed to fetch eval data:", error);
    return NextResponse.json(
      { error: "Failed to fetch evaluation data" },
      { status: 500 }
    );
  }
}
