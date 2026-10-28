/**
 * Resolves a dynamic eval baseline from Databricks.
 *
 * The baseline is the latest release image that has eval data, unless a
 * specific image is requested.  No static YAML — the baseline always comes
 * from the data warehouse.
 *
 * All resolution functions accept a pre-loaded row set to avoid redundant
 * Databricks scans.  The cron path calls loadEvalRows() once and threads
 * the result through.
 */

import { loadEvalRows, type EvalRow, type EvalMetric } from "@/lib/eval-data";
import {
  classifyImage,
  groupImagesByKind,
  type ImageInfo,
} from "@/lib/commit-from-image";

export interface BaselineMetric {
  model: string;
  task: string;
  metric: string;
  filter: string;
  value: number;
  stderr: number;
  higherIsBetter: boolean;
  nShot: number;
  nSamples: number;
  runDate: string;
  image: string;
}

export interface EvalBaseline {
  baselineImage: string;
  imageInfo: ImageInfo;
  resolvedAt: string;
  metrics: BaselineMetric[];
}

function baselineKey(
  model: string,
  task: string,
  metric: string,
  filter: string,
): string {
  return [model, task, metric, filter].join("|");
}

function extractMetrics(rows: EvalRow[]): BaselineMetric[] {
  const latest = new Map<string, { row: EvalRow; metric: EvalMetric }>();

  for (const row of rows) {
    for (const m of row.metrics) {
      const key = baselineKey(row.model, row.task, m.name, m.filter);
      const existing = latest.get(key);
      if (!existing || row.run_epoch > existing.row.run_epoch) {
        latest.set(key, { row, metric: m });
      }
    }
  }

  const out: BaselineMetric[] = [];
  for (const { row, metric } of latest.values()) {
    out.push({
      model: row.model,
      task: row.task,
      metric: metric.name,
      filter: metric.filter,
      value: metric.value,
      stderr: metric.stderr,
      higherIsBetter: metric.higher_is_better,
      nShot: row.n_shot,
      nSamples: row.n_samples,
      runDate: row.run_date,
      image: row.image ?? "",
    });
  }

  return out.sort((a, b) =>
    a.model.localeCompare(b.model) ||
    a.task.localeCompare(b.task) ||
    a.metric.localeCompare(b.metric) ||
    a.filter.localeCompare(b.filter),
  );
}

/** Build epoch-keyed date map and grouped images from a row set. */
function groupRows(rows: EvalRow[]) {
  const images = [...new Set(
    rows.map((r) => r.image).filter((img): img is string => img !== null),
  )];

  const epochByImage = new Map<string, number>();
  for (const row of rows) {
    if (!row.image) continue;
    const prev = epochByImage.get(row.image) ?? 0;
    if (row.run_epoch > prev) epochByImage.set(row.image, row.run_epoch);
  }

  const dates: Record<string, string> = {};
  for (const [img, epoch] of epochByImage) {
    dates[img] = new Date(epoch * 1000).toISOString();
  }

  return { images, dates, groups: groupImagesByKind(images, dates) };
}

/**
 * Find the latest release image from a pre-loaded row set.
 * Pass `allRows` to avoid a redundant Databricks scan.
 */
export function resolveLatestReleaseImageFromRows(
  allRows: EvalRow[],
): string | null {
  const { groups } = groupRows(allRows);
  return groups.release[0] ?? null;
}

/**
 * Find the latest nightly image from a pre-loaded row set.
 * Pass `allRows` to avoid a redundant Databricks scan.
 */
export function resolveLatestNightlyImageFromRows(
  allRows: EvalRow[],
): string | null {
  const { groups } = groupRows(allRows);
  return groups.nightly[0] ?? null;
}

/**
 * Resolve the eval baseline.
 *
 * @param image     Explicit baseline image.  When omitted, the latest
 *                  release image with eval data is used.
 * @param allRows   Pre-loaded rows to avoid a redundant Databricks scan.
 *                  When omitted, rows are loaded on demand.
 */
export async function resolveEvalBaseline(
  image?: string | null,
  allRows?: EvalRow[],
): Promise<EvalBaseline | null> {
  const rows = allRows ?? await loadEvalRows();
  const baselineImage = image || resolveLatestReleaseImageFromRows(rows);
  if (!baselineImage) return null;

  const baselineRows = rows.filter((r) => r.image === baselineImage);
  if (baselineRows.length === 0) return null;

  return {
    baselineImage,
    imageInfo: classifyImage(baselineImage),
    resolvedAt: new Date().toISOString(),
    metrics: extractMetrics(baselineRows),
  };
}
