export const PERF_DATA_START_DATE = "2026-06-14";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function resolvePerfDataStartDate(value?: string | null): string {
  if (!value || !ISO_DATE_PATTERN.test(value)) return PERF_DATA_START_DATE;

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return PERF_DATA_START_DATE;
  }

  return value;
}

export function perfDataStartCondition(value?: string | null): string {
  return `message:date::STRING >= '${resolvePerfDataStartDate(value)}'`;
}

export const PERF_DATA_START_CONDITION = perfDataStartCondition();

// ── Row identity / de-duplication ────────────────────────────────────────────

// The minimal set of fields (all strings, as returned by the perf API) that
// identify a single benchmark data point.
export interface PerfRowIdentity {
  device: string;
  tp: string;
  conc: string;
  isl: string;
  osl: string;
  precision: string;
  image: string;
  date: string;
}

// A single benchmark point is fully identified by its config
// (device/tp/conc/isl/osl/precision) on a specific build `image`. The warehouse
// can legitimately hold several rows for one such point — a run re-ingested or
// retried, or more than one producer posting the same nightly into the shared
// `vllm_perf_data_ingest` table. Those extra rows are what make a trend line
// zig-zag. Keying on the full config + image lets us collapse them to one point
// per build, matching the commit-keyed de-dup the standalone AMD dashboard uses.
//
// ROCm nightlies are published under both a floating `…-rocm:nightly` tag and a
// commit-pinned `…-rocm:nightly-<sha>` tag, so the same build can be ingested
// under two different `image` strings. Keying ROCm rows on the embedded commit
// sha (when present) makes those collapse to one point per commit instead of
// being double-counted. Non-ROCm images are left untouched.
const ROCM_NIGHTLY_SHA = /nightly-([0-9a-f]{7,40})\b/i;

export function imageIdentity(image?: string): string {
  const img = image ?? "";
  if (/rocm/i.test(img)) {
    const m = img.match(ROCM_NIGHTLY_SHA);
    if (m) return `rocm@${m[1].toLowerCase()}`;
  }
  return img;
}

export function perfPointKey(r: PerfRowIdentity): string {
  return [r.device, r.tp, r.conc, r.isl, r.osl, r.precision, imageIdentity(r.image)]
    .map((v) => (v ?? "").toString())
    .join("|");
}

// Collapse duplicate rows to the latest (by `date`) per config+image.
export function dedupePerfRows<T extends PerfRowIdentity>(rows: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const key = perfPointKey(row);
    const prev = byKey.get(key);
    if (!prev || (row.date ?? "") > (prev.date ?? "")) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}
