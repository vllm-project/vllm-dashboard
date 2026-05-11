import { queryDatabricks } from "@/lib/databricks";
import type { EvalMetric, EvalRow } from "@/lib/eval-data";

export type Area = "perf" | "eval";
export type DeltaStatus = "regression" | "improvement" | "unchanged" | "noisy";

export interface PerfMetricInfo {
  key: string;
  label: string;
  unit: string;
  higherIsBetter: boolean;
}

export const PERF_METRICS: PerfMetricInfo[] = [
  { key: "tput_per_gpu", label: "Throughput / GPU", unit: "token/s/gpu", higherIsBetter: true },
  { key: "input_tput_per_gpu", label: "Input Throughput / GPU", unit: "token/s/gpu", higherIsBetter: true },
  { key: "output_tput_per_gpu", label: "Output Throughput / GPU", unit: "token/s/gpu", higherIsBetter: true },
  { key: "mean_ttft", label: "Mean TTFT", unit: "s", higherIsBetter: false },
  { key: "mean_tpot", label: "Mean TPOT", unit: "s", higherIsBetter: false },
  { key: "mean_itl", label: "Mean ITL", unit: "s", higherIsBetter: false },
  { key: "mean_e2el", label: "Mean E2E Latency", unit: "s", higherIsBetter: false },
  { key: "p99_ttft", label: "P99 TTFT", unit: "s", higherIsBetter: false },
  { key: "p99_tpot", label: "P99 TPOT", unit: "s", higherIsBetter: false },
  { key: "p99_itl", label: "P99 ITL", unit: "s", higherIsBetter: false },
  { key: "p99_e2el", label: "P99 E2E Latency", unit: "s", higherIsBetter: false },
];

interface RawPerfRow {
  date: string | null;
  model: string | null;
  device: string | null;
  tp: string | number | null;
  conc: string | number | null;
  isl: string | number | null;
  osl: string | number | null;
  precision: string | null;
  image: string | null;
  tput_per_gpu: string | number | null;
  input_tput_per_gpu: string | number | null;
  output_tput_per_gpu: string | number | null;
  mean_ttft: string | number | null;
  mean_tpot: string | number | null;
  mean_itl: string | number | null;
  mean_e2el: string | number | null;
  p99_ttft: string | number | null;
  p99_tpot: string | number | null;
  p99_itl: string | number | null;
  p99_e2el: string | number | null;
}

export interface PerfRun {
  date: string;
  model: string;
  device: string;
  tp: string;
  conc: string;
  isl: string;
  osl: string;
  precision: string;
  image: string;
  metrics: Record<string, number>;
}

export interface CoverageItem {
  area: Area;
  key: string;
  model: string;
  dimension: string;
  metric: string;
  metricLabel: string;
  presentImage: string;
  runDate: string | null;
}

export interface DeltaItem {
  area: Area;
  key: string;
  model: string;
  dimension: string;
  metric: string;
  metricLabel: string;
  unit: string;
  higherIsBetter: boolean;
  baselineValue: number;
  candidateValue: number;
  delta: number;
  deltaPct: number | null;
  status: DeltaStatus;
  severity: number;
  significance: number | null;
  baselineRun: string | null;
  candidateRun: string | null;
  baselineDetail: string;
  candidateDetail: string;
}

interface EvalMetricRun {
  row: EvalRow;
  metric: EvalMetric;
}

export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function stringValue(value: string | number | null): string {
  if (value === null || value === undefined || value === "") return "unknown";
  return String(value);
}

function numberValue(value: unknown): number | null {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : null;
}

export function parseThreshold(value: string | null, fallback: number): number {
  const parsed = value === null ? NaN : parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function runTime(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function latestRun<T>(current: T | undefined, next: T, getTime: (row: T) => number): T {
  if (!current) return next;
  return getTime(next) >= getTime(current) ? next : current;
}

function normalizePerfRow(row: RawPerfRow): PerfRun | null {
  if (!row.image || !row.model) return null;

  const metrics: Record<string, number> = {};
  for (const metric of PERF_METRICS) {
    const value = numberValue(row[metric.key as keyof RawPerfRow]);
    if (value !== null) metrics[metric.key] = value;
  }

  return {
    date: row.date ?? "",
    model: row.model,
    device: stringValue(row.device),
    tp: stringValue(row.tp),
    conc: stringValue(row.conc),
    isl: stringValue(row.isl),
    osl: stringValue(row.osl),
    precision: stringValue(row.precision),
    image: row.image,
    metrics,
  };
}

function perfKey(row: PerfRun): string {
  return [
    row.model,
    row.device,
    row.tp,
    row.conc,
    row.isl,
    row.osl,
    row.precision,
  ].join("|");
}

function perfDimension(row: PerfRun): string {
  return `${row.device} - TP ${row.tp} - conc ${row.conc} - ISL ${row.isl} - OSL ${row.osl} - ${row.precision}`;
}

function evalKey(row: EvalRow, metric: EvalMetric): string {
  return [
    row.model,
    row.task,
    row.n_shot,
    metric.name,
    metric.filter,
  ].join("|");
}

function evalDimension(row: EvalRow, metric: EvalMetric): string {
  return `${row.task} - ${row.n_shot}-shot - ${metric.filter}`;
}

function evalDetail(row: EvalRow): string {
  const samples = row.n_samples ? `n=${row.n_samples}` : "n=unknown";
  const commit =
    row.vllm_commit ?? row.buildkite_commit ?? row.git_hash ?? row.image ?? "unknown";
  return `${samples} - ${commit.slice(0, 12)}`;
}

function classifyPerfDelta(
  baselineValue: number,
  candidateValue: number,
  higherIsBetter: boolean,
  threshold: number
): { status: DeltaStatus; severity: number; deltaPct: number | null } {
  const delta = candidateValue - baselineValue;
  const deltaPct =
    baselineValue === 0 ? null : delta / Math.abs(baselineValue);
  const impact = higherIsBetter
    ? deltaPct ?? Math.sign(delta)
    : -(deltaPct ?? Math.sign(delta));

  if (impact < -threshold) {
    return { status: "regression", severity: Math.abs(impact), deltaPct };
  }
  if (impact > threshold) {
    return { status: "improvement", severity: Math.abs(impact), deltaPct };
  }
  return { status: "unchanged", severity: Math.abs(impact), deltaPct };
}

function classifyEvalDelta(
  baselineValue: number,
  candidateValue: number,
  baselineStderr: number,
  candidateStderr: number,
  higherIsBetter: boolean,
  sigmaThreshold: number
): { status: DeltaStatus; severity: number; significance: number | null } {
  const delta = candidateValue - baselineValue;
  if (Math.abs(delta) < 1e-12) {
    return { status: "unchanged", severity: 0, significance: null };
  }

  const sigma = Math.sqrt(baselineStderr ** 2 + candidateStderr ** 2);
  const significance = sigma > 0 ? Math.abs(delta) / sigma : null;
  if (significance !== null && significance < sigmaThreshold) {
    return {
      status: "noisy",
      severity: Math.abs(delta),
      significance,
    };
  }

  const impact = higherIsBetter ? delta : -delta;
  return {
    status: impact < 0 ? "regression" : "improvement",
    severity: Math.abs(delta),
    significance,
  };
}

export async function loadPerfRowsByImages(
  images: string[],
  opts: { model?: string | null; device?: string | null } = {}
): Promise<PerfRun[]> {
  if (images.length === 0) return [];
  const escapedImages = images.map((i) => `'${escapeSqlString(i)}'`).join(", ");
  const conditions = [
    "message:model IS NOT NULL",
    `message:image::STRING IN (${escapedImages})`,
  ];
  if (opts.model) {
    conditions.push(`message:model::STRING = '${escapeSqlString(opts.model)}'`);
  }
  if (opts.device) {
    conditions.push(`message:device::STRING = '${escapeSqlString(opts.device)}'`);
  }

  const rows = await queryDatabricks<RawPerfRow>(`
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
    FROM vllm_data_warehouse.default.vllm_perf_data_ingest
    WHERE ${conditions.join(" AND ")}
    ORDER BY message:date::STRING DESC
  `);

  return rows
    .map(normalizePerfRow)
    .filter((row): row is PerfRun => row !== null);
}

export function loadPerfRows({
  baseline,
  candidate,
  model,
  device,
}: {
  baseline: string;
  candidate: string;
  model?: string | null;
  device?: string | null;
}): Promise<PerfRun[]> {
  return loadPerfRowsByImages([baseline, candidate], { model, device });
}

export function comparePerfRows(
  rows: PerfRun[],
  baseline: string,
  candidate: string,
  threshold: number
) {
  const baselineRuns = new Map<string, PerfRun>();
  const candidateRuns = new Map<string, PerfRun>();

  for (const row of rows) {
    const map = row.image === baseline ? baselineRuns : row.image === candidate ? candidateRuns : null;
    if (!map) continue;
    const key = perfKey(row);
    map.set(key, latestRun(map.get(key), row, (r) => runTime(r.date)));
  }

  const deltas: DeltaItem[] = [];
  const missingBaseline: CoverageItem[] = [];
  const missingCandidate: CoverageItem[] = [];
  const keys = new Set([...baselineRuns.keys(), ...candidateRuns.keys()]);

  for (const key of keys) {
    const baselineRun = baselineRuns.get(key);
    const candidateRun = candidateRuns.get(key);
    const referenceRun = candidateRun ?? baselineRun;
    if (!referenceRun) continue;

    for (const metric of PERF_METRICS) {
      const baselineValue = baselineRun?.metrics[metric.key];
      const candidateValue = candidateRun?.metrics[metric.key];
      const coverageItem = {
        area: "perf" as const,
        key: `${key}|${metric.key}`,
        model: referenceRun.model,
        dimension: perfDimension(referenceRun),
        metric: metric.key,
        metricLabel: metric.label,
      };

      if (baselineValue === undefined && candidateValue !== undefined && candidateRun) {
        missingBaseline.push({
          ...coverageItem,
          presentImage: candidate,
          runDate: candidateRun.date || null,
        });
        continue;
      }
      if (candidateValue === undefined && baselineValue !== undefined && baselineRun) {
        missingCandidate.push({
          ...coverageItem,
          presentImage: baseline,
          runDate: baselineRun.date || null,
        });
        continue;
      }
      if (
        baselineValue === undefined ||
        candidateValue === undefined ||
        !baselineRun ||
        !candidateRun
      ) {
        continue;
      }

      const classified = classifyPerfDelta(
        baselineValue,
        candidateValue,
        metric.higherIsBetter,
        threshold
      );
      deltas.push({
        area: "perf",
        key: `${key}|${metric.key}`,
        model: baselineRun.model,
        dimension: perfDimension(baselineRun),
        metric: metric.key,
        metricLabel: metric.label,
        unit: metric.unit,
        higherIsBetter: metric.higherIsBetter,
        baselineValue,
        candidateValue,
        delta: candidateValue - baselineValue,
        deltaPct: classified.deltaPct,
        status: classified.status,
        severity: classified.severity,
        significance: null,
        baselineRun: baselineRun.date || null,
        candidateRun: candidateRun.date || null,
        baselineDetail: baselineRun.image,
        candidateDetail: candidateRun.image,
      });
    }
  }

  return { deltas, missingBaseline, missingCandidate };
}

export function compareEvalRows(
  rows: EvalRow[],
  baseline: string,
  candidate: string,
  sigmaThreshold: number
) {
  const baselineRuns = new Map<string, EvalMetricRun>();
  const candidateRuns = new Map<string, EvalMetricRun>();

  for (const row of rows) {
    const map = row.image === baseline ? baselineRuns : row.image === candidate ? candidateRuns : null;
    if (!map) continue;
    for (const metric of row.metrics) {
      const key = evalKey(row, metric);
      map.set(
        key,
        latestRun(map.get(key), { row, metric }, (entry) => entry.row.run_epoch)
      );
    }
  }

  const deltas: DeltaItem[] = [];
  const missingBaseline: CoverageItem[] = [];
  const missingCandidate: CoverageItem[] = [];
  const keys = new Set([...baselineRuns.keys(), ...candidateRuns.keys()]);

  for (const key of keys) {
    const baselineRun = baselineRuns.get(key);
    const candidateRun = candidateRuns.get(key);
    const referenceRun = candidateRun ?? baselineRun;
    if (!referenceRun) continue;

    const coverageItem = {
      area: "eval" as const,
      key,
      model: referenceRun.row.model,
      dimension: evalDimension(referenceRun.row, referenceRun.metric),
      metric: referenceRun.metric.name,
      metricLabel: `${referenceRun.metric.name} (${referenceRun.metric.filter})`,
    };

    if (!baselineRun && candidateRun) {
      missingBaseline.push({
        ...coverageItem,
        presentImage: candidate,
        runDate: candidateRun.row.run_date,
      });
      continue;
    }
    if (baselineRun && !candidateRun) {
      missingCandidate.push({
        ...coverageItem,
        presentImage: baseline,
        runDate: baselineRun.row.run_date,
      });
      continue;
    }
    if (!baselineRun || !candidateRun) continue;

    const classified = classifyEvalDelta(
      baselineRun.metric.value,
      candidateRun.metric.value,
      baselineRun.metric.stderr,
      candidateRun.metric.stderr,
      baselineRun.metric.higher_is_better,
      sigmaThreshold
    );
    deltas.push({
      area: "eval",
      key,
      model: baselineRun.row.model,
      dimension: evalDimension(baselineRun.row, baselineRun.metric),
      metric: baselineRun.metric.name,
      metricLabel: `${baselineRun.metric.name} (${baselineRun.metric.filter})`,
      unit: "score",
      higherIsBetter: baselineRun.metric.higher_is_better,
      baselineValue: baselineRun.metric.value,
      candidateValue: candidateRun.metric.value,
      delta: candidateRun.metric.value - baselineRun.metric.value,
      deltaPct:
        baselineRun.metric.value === 0
          ? null
          : (candidateRun.metric.value - baselineRun.metric.value) /
            Math.abs(baselineRun.metric.value),
      status: classified.status,
      severity: classified.severity,
      significance: classified.significance,
      baselineRun: baselineRun.row.run_date,
      candidateRun: candidateRun.row.run_date,
      baselineDetail: evalDetail(baselineRun.row),
      candidateDetail: evalDetail(candidateRun.row),
    });
  }

  return { deltas, missingBaseline, missingCandidate };
}

export function sortDeltas(a: DeltaItem, b: DeltaItem): number {
  const statusRank: Record<DeltaStatus, number> = {
    regression: 0,
    improvement: 1,
    noisy: 2,
    unchanged: 3,
  };
  if (statusRank[a.status] !== statusRank[b.status]) {
    return statusRank[a.status] - statusRank[b.status];
  }
  if (b.severity !== a.severity) return b.severity - a.severity;
  return a.metricLabel.localeCompare(b.metricLabel);
}

export interface CompareSummary {
  matched: number;
  perfMatched: number;
  evalMatched: number;
  regressions: number;
  improvements: number;
  noisy: number;
  unchanged: number;
  missingBaseline: number;
  missingCandidate: number;
}

export function buildSummary(
  perf: ReturnType<typeof comparePerfRows>,
  evalData: ReturnType<typeof compareEvalRows>
): CompareSummary {
  const deltas = [...perf.deltas, ...evalData.deltas];
  return {
    matched: deltas.length,
    perfMatched: perf.deltas.length,
    evalMatched: evalData.deltas.length,
    regressions: deltas.filter((d) => d.status === "regression").length,
    improvements: deltas.filter((d) => d.status === "improvement").length,
    noisy: deltas.filter((d) => d.status === "noisy").length,
    unchanged: deltas.filter((d) => d.status === "unchanged").length,
    missingBaseline:
      perf.missingBaseline.length + evalData.missingBaseline.length,
    missingCandidate:
      perf.missingCandidate.length + evalData.missingCandidate.length,
  };
}
