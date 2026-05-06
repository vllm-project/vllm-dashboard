"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { SearchableSelect } from "@/components/searchable-select";

type Area = "perf" | "eval";
type DeltaStatus = "regression" | "improvement" | "unchanged" | "noisy";
type AreaFilter = "all" | "perf" | "eval";

interface PerfFilters {
  models: string[];
  devices: string[];
  images: string[];
}

interface EvalFilters {
  models: string[];
  tasks: string[];
  images: string[];
}

interface DeltaItem {
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

interface CoverageItem {
  area: Area;
  key: string;
  model: string;
  dimension: string;
  metric: string;
  metricLabel: string;
  presentImage: string;
  runDate: string | null;
}

interface CompareResponse {
  baseline: string;
  candidate: string;
  thresholds: {
    perf: number;
    evalSigma: number;
  };
  summary: {
    matched: number;
    perfMatched: number;
    evalMatched: number;
    regressions: number;
    improvements: number;
    noisy: number;
    unchanged: number;
    missingBaseline: number;
    missingCandidate: number;
  };
  worstRegressions: DeltaItem[];
  perf: {
    deltas: DeltaItem[];
    missingBaseline: CoverageItem[];
    missingCandidate: CoverageItem[];
  };
  eval: {
    deltas: DeltaItem[];
    missingBaseline: CoverageItem[];
    missingCandidate: CoverageItem[];
  };
  generatedAt: string;
}

interface CompareFilters {
  baseline: string;
  candidate: string;
  model: string;
  device: string;
  task: string;
  perfThresholdPct: string;
}

const DEFAULT_EVAL_SIGMA = 2;

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error ?? "Request failed");
  }
  return data;
};

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function formatNumericInput(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function parsePerfThresholdParam(value: string | null): string | null {
  if (value === null) return null;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  return formatNumericInput(parsed <= 1 ? parsed * 100 : parsed);
}

function setQueryParam(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
}

function shortImage(image: string): string {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) return image.slice(colon + 1);
  return image;
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatValue(item: DeltaItem, value: number): string {
  if (item.area === "eval") return `${(value * 100).toFixed(2)}%`;
  if (item.unit === "s") {
    return value < 1 ? `${value.toFixed(4)}s` : `${value.toFixed(2)}s`;
  }
  return `${value.toFixed(2)} ${item.unit}`;
}

function formatDelta(item: DeltaItem): string {
  const sign = item.delta >= 0 ? "+" : "";
  if (item.area === "eval") {
    return `${sign}${(item.delta * 100).toFixed(2)} pp`;
  }
  if (item.deltaPct === null) {
    return `${sign}${item.delta.toFixed(4)}`;
  }
  return `${sign}${(item.deltaPct * 100).toFixed(1)}%`;
}

function formatDeltaRaw(item: DeltaItem): string | null {
  const sign = item.delta >= 0 ? "+" : "";
  if (item.area === "eval") {
    if (item.deltaPct === null) return null;
    return `${sign}${(item.deltaPct * 100).toFixed(1)}%`;
  }
  if (item.unit === "s") {
    const abs = Math.abs(item.delta);
    return `${sign}${abs < 1 ? item.delta.toFixed(4) : item.delta.toFixed(2)}s`;
  }
  return `${sign}${item.delta.toFixed(2)}${item.unit ? ` ${item.unit}` : ""}`;
}

// X coordinate (in chart percent units) for a delta item
function deltaX(item: DeltaItem): number {
  if (item.area === "eval") return item.delta * 100; // pp
  return (item.deltaPct ?? 0) * 100; // %
}

function statusLabel(status: DeltaStatus): string {
  switch (status) {
    case "regression":
      return "Regressed";
    case "improvement":
      return "Improved";
    case "noisy":
    case "unchanged":
      return "Noise";
  }
}

// Reclassify an item using a single percentage threshold:
//   - perf:  uses |deltaPct|     (relative %)
//   - eval:  uses |delta * 100|  (percentage points on score)
// Below threshold → "unchanged" (rendered as "Noise"). Above → direction-aware.
function reclassify(item: DeltaItem, thresholdPct: number): DeltaStatus {
  const magnitudePct =
    item.area === "eval"
      ? Math.abs(item.delta * 100)
      : Math.abs((item.deltaPct ?? 0) * 100);
  if (magnitudePct < thresholdPct) return "unchanged";
  const directional = item.higherIsBetter ? item.delta : -item.delta;
  return directional > 0 ? "improvement" : "regression";
}

const STATUS_DOT: Record<DeltaStatus, string> = {
  regression: "bg-red-500",
  improvement: "bg-emerald-500",
  noisy: "bg-yellow-500",
  unchanged: "bg-zinc-400",
};

function StatusBadge({ status }: { status: DeltaStatus }) {
  const classes = {
    regression:
      "bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900",
    improvement:
      "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900",
    noisy:
      "bg-yellow-50 text-yellow-700 ring-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-300 dark:ring-yellow-900",
    unchanged:
      "bg-zinc-100 text-zinc-600 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800",
  }[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${classes}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
      {statusLabel(status)}
    </span>
  );
}

function AreaTag({ area }: { area: Area }) {
  return (
    <span className="rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
      {area}
    </span>
  );
}

interface DerivedSummary {
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

function VerdictHero({
  summary,
  perfThreshold,
}: {
  summary: DerivedSummary;
  perfThreshold: number;
}) {
  const s = summary;
  const coverage = s.missingBaseline + s.missingCandidate;
  let kind: "good" | "bad" | "warn" = "good";
  let title = "Ready to ship";
  let sub = `No regressions exceed the ${perfThreshold.toFixed(1)}% threshold. ${s.improvements} direction-aware wins, ${s.unchanged} within noise.`;

  if (s.regressions > 0) {
    kind = "bad";
    title = "Hold ship — regressions detected";
    sub = `${s.regressions} check${s.regressions > 1 ? "s" : ""} exceeded the configured threshold. Investigate worst regressions before promoting.`;
  } else if (coverage > 0) {
    kind = "warn";
    title = "Ready, with coverage gaps";
    sub = `${coverage} check${coverage > 1 ? "s" : ""} missing across the two images. Review what's missing before signing off.`;
  }

  const statusLabelText =
    kind === "good"
      ? "Verdict · Pass"
      : kind === "bad"
        ? "Verdict · Fail"
        : "Verdict · Review";
  const statusDot = {
    good: "bg-emerald-500 ring-emerald-200 dark:ring-emerald-900/60",
    bad: "bg-red-500 ring-red-200 dark:ring-red-900/60",
    warn: "bg-yellow-500 ring-yellow-200 dark:ring-yellow-900/60",
  }[kind];

  const passClean = s.matched - s.regressions;
  const passRate =
    s.matched > 0 ? Math.round((passClean / s.matched) * 100) : 100;

  return (
    <div className="grid gap-px overflow-hidden rounded-xl border border-zinc-200/80 bg-zinc-200 dark:border-zinc-800/80 dark:bg-zinc-800 lg:grid-cols-[1.1fr_1.6fr]">
      <div className="bg-white px-6 py-5 dark:bg-zinc-950">
        <div className="mb-2.5 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          <span
            className={`h-2 w-2 rounded-full ring-4 ${statusDot}`}
          />
          {statusLabelText}
        </div>
        <h2 className="mb-2 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {title}
        </h2>
        <p className="max-w-prose text-sm text-zinc-500 dark:text-zinc-400">
          {sub}
        </p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
          <span>
            Threshold{" "}
            <b className="font-semibold text-zinc-700 dark:text-zinc-200">
              ±{perfThreshold.toFixed(1)}%
            </b>
          </span>
        </div>
      </div>
      <div className="bg-white p-px dark:bg-zinc-950">
        <div className="grid grid-cols-2 gap-px bg-zinc-200 sm:grid-cols-4 dark:bg-zinc-800">
          <MiniStat
            label="Pass rate"
            big={`${passRate}%`}
            sub={`${passClean} / ${s.matched} clean`}
            tone="good"
          />
          <MiniStat
            label="Wins"
            big={String(s.improvements)}
            sub="direction-aware"
            tone="good"
            mono
          />
          <MiniStat
            label="Regressions"
            big={String(s.regressions)}
            sub="above threshold"
            tone={s.regressions ? "bad" : "neutral"}
            mono
          />
          <MiniStat
            label="Noise"
            big={String(s.unchanged)}
            sub="below threshold"
            tone="neutral"
            mono
          />
        </div>
      </div>
    </div>
  );
}

function MiniStat({
  label,
  big,
  sub,
  tone,
  mono,
}: {
  label: string;
  big: string;
  sub: string;
  tone: "good" | "bad" | "warn" | "neutral";
  mono?: boolean;
}) {
  const toneClass = {
    good: "text-emerald-600 dark:text-emerald-400",
    bad: "text-red-600 dark:text-red-400",
    warn: "text-yellow-600 dark:text-yellow-500",
    neutral: "text-zinc-900 dark:text-zinc-100",
  }[tone];
  return (
    <div className="bg-white px-4 py-3 dark:bg-zinc-950">
      <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-semibold leading-none ${mono ? "font-mono" : ""} ${toneClass}`}
      >
        {big}
      </div>
      <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        {sub}
      </div>
    </div>
  );
}

function SummaryStrip({
  summary,
  perfThreshold,
}: {
  summary: DerivedSummary;
  perfThreshold: number;
}) {
  const s = summary;
  const total = Math.max(1, s.matched);
  const goodPct = (s.improvements / total) * 100;
  const badPct = (s.regressions / total) * 100;
  const neutralPct = Math.max(0, 100 - goodPct - badPct);
  const coverage = s.missingBaseline + s.missingCandidate;

  return (
    <div className="grid gap-px overflow-hidden rounded-xl border border-zinc-200/80 bg-zinc-200 dark:border-zinc-800/80 dark:bg-zinc-800 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
      <div className="bg-white px-5 py-4 dark:bg-zinc-950">
        <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">
          Matched checks
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <div className="text-3xl font-semibold leading-none text-zinc-900 dark:text-zinc-100">
            {s.matched}
          </div>
          <div className="font-mono text-xs text-zinc-400">
            {s.perfMatched} perf · {s.evalMatched} eval
          </div>
        </div>
        <div className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          {goodPct > 0 && (
            <div className="h-full bg-emerald-500" style={{ width: `${goodPct}%` }} />
          )}
          {badPct > 0 && (
            <div className="h-full bg-red-500" style={{ width: `${badPct}%` }} />
          )}
          {neutralPct > 0 && (
            <div
              className="h-full bg-zinc-400/60"
              style={{ width: `${neutralPct}%` }}
            />
          )}
        </div>
        <div className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
          {s.improvements} wins · {s.regressions} regressions · {s.unchanged} noise
        </div>
      </div>
      <SimpleStat
        label="Regressions"
        dot="bg-red-500"
        value={s.regressions}
        valueClass={s.regressions ? "text-red-600 dark:text-red-400" : ""}
        hint={`Beyond ±${perfThreshold.toFixed(1)}% threshold`}
      />
      <SimpleStat
        label="Improvements"
        dot="bg-emerald-500"
        value={s.improvements}
        valueClass={s.improvements ? "text-emerald-600 dark:text-emerald-400" : ""}
        hint="Direction-aware wins"
      />
      <SimpleStat
        label="Noise"
        dot="bg-zinc-400"
        value={s.unchanged}
        hint={`Within ±${perfThreshold.toFixed(1)}% threshold`}
      />
      <SimpleStat
        label="Coverage gaps"
        dot="bg-zinc-400"
        value={coverage}
        hint={`${s.missingCandidate} candidate-only · ${s.missingBaseline} baseline-only`}
      />
    </div>
  );
}

function SimpleStat({
  label,
  dot,
  value,
  valueClass,
  hint,
}: {
  label: string;
  dot: string;
  value: number;
  valueClass?: string;
  hint: string;
}) {
  return (
    <div className="bg-white px-5 py-4 dark:bg-zinc-950">
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {label}
      </div>
      <div
        className={`mt-1 text-3xl font-semibold leading-none ${valueClass ?? "text-zinc-900 dark:text-zinc-100"}`}
      >
        {value}
      </div>
      <div className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
        {hint}
      </div>
    </div>
  );
}

function Distribution({
  perf,
  evals,
  perfThreshold,
}: {
  perf: DeltaItem[];
  evals: DeltaItem[];
  perfThreshold: number;
}) {
  const all = useMemo(() => [...perf, ...evals], [perf, evals]);
  const min = -10;
  const max = 30;
  const xPct = (v: number) =>
    Math.max(2, Math.min(98, ((v - min) / (max - min)) * 100));
  const yByStatus: Record<DeltaStatus, number> = {
    regression: 18,
    improvement: 38,
    noisy: 58,
    unchanged: 78,
  };
  const ptColor: Record<DeltaStatus, string> = {
    regression: "bg-red-500",
    improvement: "bg-emerald-500",
    noisy: "bg-yellow-500",
    unchanged: "bg-zinc-400",
  };
  const [hover, setHover] = useState<{
    item: DeltaItem;
    x: number;
    y: number;
  } | null>(null);

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Delta distribution
          </h3>
          <span className="font-mono text-[11px] text-zinc-400">
            {all.length} checks
          </span>
        </div>
        <div className="flex flex-wrap gap-3 font-mono text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          <Legend dot="bg-emerald-500" label="Improvement" />
          <Legend dot="bg-red-500" label="Regression" />
          <Legend dot="bg-zinc-400" label="Noise" />
        </div>
      </div>
      <div className="px-5 pb-5 pt-4">
        <div className="relative h-24 border-b border-dashed border-zinc-200 dark:border-zinc-800">
          <div
            className="absolute top-0 bottom-0 w-px bg-zinc-300 dark:bg-zinc-700"
            style={{ left: `${xPct(0)}%` }}
          />
          <div
            className="absolute top-0 bottom-0 border-l border-dashed border-red-400/60"
            style={{ left: `${xPct(-perfThreshold)}%` }}
          />
          <div
            className="absolute top-0 bottom-0 border-l border-dashed border-emerald-500/60"
            style={{ left: `${xPct(perfThreshold)}%` }}
          />
          {all.map((p) => {
            const x = deltaX(p);
            return (
              <div
                key={p.key}
                className={`absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full ring-2 ring-white transition-transform hover:scale-150 dark:ring-zinc-950 ${ptColor[p.status]}`}
                style={{
                  left: `${xPct(x)}%`,
                  top: `${yByStatus[p.status]}%`,
                }}
                onMouseEnter={(e) =>
                  setHover({ item: p, x: e.clientX, y: e.clientY })
                }
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-zinc-400">
          <span>−10%</span>
          <span>−{perfThreshold.toFixed(1)}%</span>
          <span>0</span>
          <span>+{perfThreshold.toFixed(1)}%</span>
          <span>+10%</span>
          <span>+30%</span>
        </div>
      </div>
      {hover && (
        <div
          className="pointer-events-none fixed z-50 rounded-md bg-zinc-900 px-2.5 py-1.5 font-mono text-[11px] text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
          style={{ left: hover.x + 12, top: hover.y - 30 }}
        >
          <b>
            {hover.item.area === "perf"
              ? `${deltaX(hover.item) > 0 ? "+" : ""}${deltaX(hover.item).toFixed(1)}%`
              : `${deltaX(hover.item) > 0 ? "+" : ""}${deltaX(hover.item).toFixed(2)} pp`}
          </b>
          {" · "}
          {hover.item.model.split("/").pop()} ·{" "}
          {hover.item.metricLabel.split(" ")[0]}
        </div>
      )}
    </div>
  );
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function ByModel({ items }: { items: DeltaItem[] }) {
  const map = new Map<
    string,
    { good: number; bad: number; warn: number; neutral: number; total: number }
  >();
  for (const r of items) {
    const cur = map.get(r.model) ?? {
      good: 0,
      bad: 0,
      warn: 0,
      neutral: 0,
      total: 0,
    };
    cur.total++;
    if (r.status === "improvement") cur.good++;
    else if (r.status === "regression") cur.bad++;
    else if (r.status === "noisy") cur.warn++;
    else cur.neutral++;
    map.set(r.model, cur);
  }
  const models = [...map.entries()].sort((a, b) => b[1].good - a[1].good);

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
      <div className="flex items-baseline justify-between gap-2 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            By model
          </h3>
          <span className="font-mono text-[11px] text-zinc-400">
            {models.length} models
          </span>
        </div>
      </div>
      <div className="divide-y divide-zinc-100 px-5 dark:divide-zinc-800">
        {models.length === 0 && (
          <div className="py-8 text-center text-sm text-zinc-400">
            No matched checks for the current filters.
          </div>
        )}
        {models.map(([name, c]) => {
          const seg = (n: number) => `${(n / c.total) * 100}%`;
          return (
            <div
              key={name}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-3 py-2"
            >
              <div
                className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-200"
                title={name}
              >
                {name}
              </div>
              <div className="flex h-3 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                {c.good > 0 && (
                  <div className="bg-emerald-500" style={{ width: seg(c.good) }} />
                )}
                {c.bad > 0 && (
                  <div className="bg-red-500" style={{ width: seg(c.bad) }} />
                )}
                {c.warn > 0 && (
                  <div className="bg-yellow-500" style={{ width: seg(c.warn) }} />
                )}
                {c.neutral > 0 && (
                  <div
                    className="bg-zinc-400/40"
                    style={{ width: seg(c.neutral) }}
                  />
                )}
              </div>
              <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                {c.good ? (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    +{c.good}
                  </span>
                ) : null}
                {c.good && c.bad ? " " : ""}
                {c.bad ? (
                  <span className="text-red-600 dark:text-red-400">−{c.bad}</span>
                ) : null}
                <span className="text-zinc-400"> / {c.total}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusChip({
  on,
  onClick,
  dot,
  children,
}: {
  on: boolean;
  onClick: () => void;
  dot: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition ${
        on
          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
          : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {children}
    </button>
  );
}

type SortKey = "status" | "model" | "delta" | "baseline" | "candidate";

function DeltaTable({
  kind,
  title,
  subtitle,
  rows,
  totalCount,
  thresholds,
  expandedRow,
  setExpandedRow,
}: {
  kind: Area;
  title: string;
  subtitle: string;
  rows: DeltaItem[];
  totalCount: number;
  thresholds: { perfPct: number };
  expandedRow: string | null;
  setExpandedRow: (id: string | null) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("delta");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      if (sortKey === "delta") {
        av = kind === "perf" ? (a.deltaPct ?? 0) : a.delta;
        bv = kind === "perf" ? (b.deltaPct ?? 0) : b.delta;
      } else if (sortKey === "model") {
        av = a.model;
        bv = b.model;
      } else if (sortKey === "status") {
        const order: Record<DeltaStatus, number> = {
          regression: 0,
          improvement: 1,
          noisy: 2,
          unchanged: 3,
        };
        av = order[a.status];
        bv = order[b.status];
      } else if (sortKey === "candidate") {
        av = a.candidateValue;
        bv = b.candidateValue;
      } else if (sortKey === "baseline") {
        av = a.baselineValue;
        bv = b.baselineValue;
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [rows, sortKey, sortDir, kind]);

  const sort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  const arrow = (k: SortKey) =>
    sortKey === k ? (
      <span className="ml-1 opacity-60">{sortDir === "asc" ? "↑" : "↓"}</span>
    ) : null;

  const range = kind === "perf" ? 30 : 5;

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {title}
          </h3>
          <span className="font-mono text-[11px] text-zinc-400">
            {rows.length} of {totalCount}
          </span>
        </div>
        <div className="font-mono text-[11px] text-zinc-400">{subtitle}</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:bg-zinc-900/50 dark:text-zinc-400">
            <tr>
              <th className="w-6 px-2 py-2.5"></th>
              <th
                className="cursor-pointer px-3 py-2.5 text-left hover:text-zinc-900 dark:hover:text-zinc-100"
                onClick={() => sort("status")}
              >
                Status {arrow("status")}
              </th>
              <th className="px-3 py-2.5 text-left">Area</th>
              <th
                className="cursor-pointer px-3 py-2.5 text-left hover:text-zinc-900 dark:hover:text-zinc-100"
                onClick={() => sort("model")}
              >
                Model {arrow("model")}
              </th>
              <th className="px-3 py-2.5 text-left">
                {kind === "perf" ? "Config" : "Task"}
              </th>
              <th className="px-3 py-2.5 text-left">Metric</th>
              <th
                className="cursor-pointer px-3 py-2.5 text-right hover:text-zinc-900 dark:hover:text-zinc-100"
                onClick={() => sort("baseline")}
              >
                Baseline {arrow("baseline")}
              </th>
              <th
                className="cursor-pointer px-3 py-2.5 text-right hover:text-zinc-900 dark:hover:text-zinc-100"
                onClick={() => sort("candidate")}
              >
                Candidate {arrow("candidate")}
              </th>
              <th
                className="w-56 cursor-pointer px-3 py-2.5 text-right hover:text-zinc-900 dark:hover:text-zinc-100"
                onClick={() => sort("delta")}
              >
                Delta {arrow("delta")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {sorted.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-3 py-8 text-center font-mono text-xs text-zinc-400"
                >
                  No checks match the current filters.
                </td>
              </tr>
            )}
            {sorted.map((r) => {
              const id = r.key;
              const isExp = expandedRow === id;
              const dv = kind === "perf" ? (r.deltaPct ?? 0) * 100 : r.delta * 100;
              const w = Math.min(50, (Math.abs(dv) / range) * 50);
              const left = dv >= 0 ? 50 : 50 - w;
              const sparkColor = {
                improvement: "bg-emerald-500",
                regression: "bg-red-500",
                noisy: "bg-yellow-500",
                unchanged: "bg-zinc-400/60",
              }[r.status];
              const deltaColor = {
                improvement:
                  "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
                regression:
                  "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400",
                noisy:
                  "bg-yellow-50 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-500",
                unchanged:
                  "bg-zinc-100 text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400",
              }[r.status];

              return (
                <Fragment key={id}>
                  <tr
                    className={`cursor-pointer align-top transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/40 ${
                      isExp ? "bg-zinc-50 dark:bg-zinc-900/40" : ""
                    } ${
                      r.status === "noisy" || r.status === "unchanged"
                        ? "text-zinc-500 dark:text-zinc-400"
                        : ""
                    }`}
                    onClick={() => setExpandedRow(isExp ? null : id)}
                  >
                    <td className="px-2 py-2 text-center text-zinc-400">
                      <span
                        className={`inline-block transition-transform ${
                          isExp ? "rotate-90 text-zinc-700 dark:text-zinc-200" : ""
                        }`}
                      >
                        ›
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-3 py-2">
                      <AreaTag area={r.area} />
                    </td>
                    <td className="max-w-[220px] px-3 py-2 font-mono text-xs">
                      <span className="block truncate" title={r.model}>
                        {r.model}
                      </span>
                    </td>
                    <td className="min-w-[240px] px-3 py-2 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                      {r.dimension}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      <div>{r.metricLabel}</div>
                      <div className="text-[10px] text-zinc-400">
                        {r.higherIsBetter ? "higher is better" : "lower is better"}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-zinc-500">
                      {formatValue(r, r.baselineValue)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs font-medium text-zinc-900 dark:text-zinc-100">
                      {formatValue(r, r.candidateValue)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-2">
                        <div
                          className="relative hidden h-4 w-32 sm:block"
                          aria-hidden
                        >
                          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-zinc-200 dark:bg-zinc-700" />
                          <div
                            className={`absolute top-1 h-2 rounded-sm ${sparkColor}`}
                            style={{ left: `${left}%`, width: `${w}%` }}
                          />
                        </div>
                        <div className="flex flex-col items-end gap-0.5">
                          <span
                            className={`inline-flex min-w-[64px] justify-center rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${deltaColor}`}
                          >
                            {formatDelta(r)}
                          </span>
                          {formatDeltaRaw(r) && (
                            <span className="font-mono text-[10px] text-zinc-400">
                              {formatDeltaRaw(r)}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                  {isExp && (
                    <tr>
                      <td
                        colSpan={9}
                        className="bg-zinc-50 px-0 py-0 dark:bg-zinc-900/40"
                      >
                        <div className="grid gap-4 px-12 py-4 sm:grid-cols-2 lg:grid-cols-4">
                          <ExpandCell
                            label="Direction"
                            value={
                              r.higherIsBetter
                                ? "higher is better"
                                : "lower is better"
                            }
                          />
                          <ExpandCell
                            label="Baseline"
                            value={formatValue(r, r.baselineValue)}
                          />
                          <ExpandCell
                            label="Candidate"
                            value={formatValue(r, r.candidateValue)}
                          />
                          <ExpandCell
                            label="Evidence"
                            value={
                              r.area === "eval"
                                ? r.significance === null
                                  ? "stderr unavailable"
                                  : `${r.significance.toFixed(1)}σ separation`
                                : r.deltaPct === null
                                  ? "baseline zero"
                                  : `${(Math.abs(r.deltaPct) * 100).toFixed(1)}% delta`
                            }
                          />
                          <ExpandCell
                            label="Threshold"
                            value={`±${thresholds.perfPct.toFixed(1)}%`}
                          />
                          <ExpandCell
                            label="Baseline run"
                            value={r.baselineRun ?? "—"}
                          />
                          <ExpandCell
                            label="Candidate run"
                            value={r.candidateRun ?? "—"}
                          />
                          <ExpandCell
                            label="Image"
                            value={shortImage(r.candidateDetail)}
                            mono
                            title={r.candidateDetail}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExpandCell({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">
        {label}
      </div>
      <div
        className={`mt-1 truncate text-xs text-zinc-900 dark:text-zinc-100 ${mono ? "font-mono" : ""}`}
        title={title ?? value}
      >
        {value}
      </div>
    </div>
  );
}

function CoverageCard({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: CoverageItem[];
  emptyText: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
      <div className="flex items-baseline justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {title}
        </h3>
        <span className="font-mono text-[11px] text-zinc-400">
          {items.length} checks
        </span>
      </div>
      {items.length === 0 ? (
        <div className="m-4 rounded-lg border border-dashed border-zinc-200 px-5 py-6 text-center font-mono text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <div className="mx-auto mb-2 grid h-7 w-7 place-items-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400">
            ✓
          </div>
          <div>{emptyText}</div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-[10px] font-medium uppercase tracking-wider text-zinc-500 dark:bg-zinc-900/50 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">Area</th>
                <th className="px-3 py-2 text-left">Model</th>
                <th className="px-3 py-2 text-left">Config / task</th>
                <th className="px-3 py-2 text-left">Metric</th>
                <th className="px-3 py-2 text-left">Image</th>
                <th className="px-3 py-2 text-right">Run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {items.map((item) => (
                <tr key={`${item.key}-${item.presentImage}`}>
                  <td className="px-3 py-2">
                    <AreaTag area={item.area} />
                  </td>
                  <td className="max-w-[220px] px-3 py-2 font-mono text-xs">
                    <span className="block truncate" title={item.model}>
                      {item.model}
                    </span>
                  </td>
                  <td className="min-w-[260px] px-3 py-2 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                    {item.dimension}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {item.metricLabel}
                  </td>
                  <td className="max-w-[260px] px-3 py-2 font-mono text-[11px] text-zinc-500">
                    <span className="block truncate" title={item.presentImage}>
                      {shortImage(item.presentImage)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[11px] text-zinc-500">
                    {formatDate(item.runDate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ComparePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [baseline, setBaseline] = useState(searchParams.get("baseline") ?? "");
  const [candidate, setCandidate] = useState(searchParams.get("candidate") ?? "");
  const [model, setModel] = useState(searchParams.get("model") ?? "");
  const [device, setDevice] = useState(searchParams.get("device") ?? "");
  const [task, setTask] = useState(searchParams.get("task") ?? "");
  const [perfThresholdPct, setPerfThresholdPct] = useState(
    parsePerfThresholdParam(
      searchParams.get("perf_threshold") ?? searchParams.get("perfThreshold")
    ) ?? "2"
  );

  const [statusFilters, setStatusFilters] = useState<Record<DeltaStatus, boolean>>({
    regression: true,
    improvement: true,
    noisy: false,
    unchanged: false, // "Noise" chip — covers both reclassified-stable and any leftover noisy
  });
  const [areaFilter, setAreaFilter] = useState<AreaFilter>("all");
  const [search, setSearch] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const updateCompareUrl = (updates: Partial<CompareFilters>) => {
    const next: CompareFilters = {
      baseline,
      candidate,
      model,
      device,
      task,
      perfThresholdPct,
      ...updates,
    };
    const params = new URLSearchParams();
    const perfThresholdParam = parseFloat(next.perfThresholdPct);

    setQueryParam(params, "baseline", next.baseline);
    setQueryParam(params, "candidate", next.candidate);
    setQueryParam(params, "model", next.model);
    setQueryParam(params, "device", next.device);
    setQueryParam(params, "task", next.task);
    if (
      Number.isFinite(perfThresholdParam) &&
      perfThresholdParam >= 0 &&
      perfThresholdParam !== 2
    ) {
      params.set("perf_threshold", String(perfThresholdParam / 100));
    }

    const queryString = params.toString();
    router.replace(queryString ? `/compare?${queryString}` : "/compare", {
      scroll: false,
    });
  };

  const updateBaseline = (value: string) => {
    setBaseline(value);
    updateCompareUrl({ baseline: value });
  };

  const updateCandidate = (value: string) => {
    setCandidate(value);
    updateCompareUrl({ candidate: value });
  };

  const updateModel = (value: string) => {
    setModel(value);
    updateCompareUrl({ model: value });
  };

  const updateDevice = (value: string) => {
    setDevice(value);
    updateCompareUrl({ device: value });
  };

  const updateTask = (value: string) => {
    setTask(value);
    updateCompareUrl({ task: value });
  };

  const updatePerfThresholdPct = (value: string) => {
    setPerfThresholdPct(value);
    updateCompareUrl({ perfThresholdPct: value });
  };

  const { data: perfFilters } = useSWR<PerfFilters>("/api/perf/filters", fetcher);
  const { data: evalFilters } = useSWR<EvalFilters>("/api/eval/filters", fetcher);

  const imageOptions = useMemo(
    () => uniqueSorted([...(perfFilters?.images ?? []), ...(evalFilters?.images ?? [])]),
    [perfFilters?.images, evalFilters?.images]
  );
  const modelOptions = useMemo(
    () => uniqueSorted([...(perfFilters?.models ?? []), ...(evalFilters?.models ?? [])]),
    [perfFilters?.models, evalFilters?.models]
  );
  const deviceOptions = perfFilters?.devices ?? [];
  const taskOptions = evalFilters?.tasks ?? [];

  const perfThreshold = Number.isFinite(parseFloat(perfThresholdPct))
    ? Math.max(0, parseFloat(perfThresholdPct))
    : 2;
  const evalSigmaValue = DEFAULT_EVAL_SIGMA;

  const compareUrl = useMemo(() => {
    if (!baseline || !candidate || baseline === candidate) return null;

    const params = new URLSearchParams();
    params.set("baseline", baseline);
    params.set("candidate", candidate);
    params.set("perf_threshold", String(perfThreshold / 100));
    params.set("eval_sigma", String(evalSigmaValue));
    if (model) params.set("model", model);
    if (device) params.set("device", device);
    if (task) params.set("task", task);
    return `/api/compare?${params.toString()}`;
  }, [baseline, candidate, model, device, task, perfThreshold, evalSigmaValue]);

  const { data, error, isLoading } = useSWR<CompareResponse>(
    compareUrl,
    fetcher,
    { refreshInterval: 10 * 60 * 1000 }
  );

  const classifiedPerf = useMemo(
    () =>
      data?.perf.deltas.map((it) => ({
        ...it,
        status: reclassify(it, perfThreshold),
      })) ?? [],
    [data?.perf.deltas, perfThreshold]
  );

  const classifiedEval = useMemo(
    () =>
      data?.eval.deltas.map((it) => ({
        ...it,
        status: reclassify(it, perfThreshold),
      })) ?? [],
    [data?.eval.deltas, perfThreshold]
  );

  const derivedSummary = useMemo(() => {
    const all = [...classifiedPerf, ...classifiedEval];
    return {
      matched: all.length,
      perfMatched: classifiedPerf.length,
      evalMatched: classifiedEval.length,
      regressions: all.filter((r) => r.status === "regression").length,
      improvements: all.filter((r) => r.status === "improvement").length,
      noisy: 0,
      unchanged: all.filter((r) => r.status === "unchanged").length,
      missingBaseline: data?.summary.missingBaseline ?? 0,
      missingCandidate: data?.summary.missingCandidate ?? 0,
    };
  }, [classifiedPerf, classifiedEval, data?.summary]);

  const filterRow = (r: DeltaItem) => {
    if (!statusFilters[r.status]) return false;
    if (search) {
      const hay = `${r.model} ${r.metricLabel} ${r.dimension}`.toLowerCase();
      if (!hay.includes(search.toLowerCase())) return false;
    }
    return true;
  };

  const perfRows = useMemo(
    () => classifiedPerf.filter(filterRow),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [classifiedPerf, statusFilters, search]
  );
  const evalRows = useMemo(
    () => classifiedEval.filter(filterRow),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [classifiedEval, statusFilters, search]
  );

  const showPerf = areaFilter !== "eval";
  const showEval = areaFilter !== "perf";

  const missingBaseline = data
    ? [...data.perf.missingBaseline, ...data.eval.missingBaseline]
    : [];
  const missingCandidate = data
    ? [...data.perf.missingCandidate, ...data.eval.missingCandidate]
    : [];
  const hasFilters = imageOptions.length > 0;

  const toggleStatus = (k: DeltaStatus) =>
    setStatusFilters({ ...statusFilters, [k]: !statusFilters[k] });

  const baselineShort = data ? shortImage(data.baseline) : null;
  const candidateShort = data ? shortImage(data.candidate) : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Perf &amp; Eval Compare</h1>
        <p className="mt-1 max-w-prose text-sm text-zinc-500 dark:text-zinc-400">
          Compare two vLLM images across performance benchmarks and accuracy
          evaluations. Verdict reflects the configured perf and eval thresholds.
        </p>
      </div>

      <div className="rounded-xl border border-zinc-200/80 bg-white px-5 py-4 dark:border-zinc-800/80 dark:bg-zinc-950">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <SearchableSelect
            label="Baseline image"
            value={baseline}
            onChange={updateBaseline}
            options={imageOptions}
            allLabel="Select baseline"
          />
          <SearchableSelect
            label="Candidate image"
            value={candidate}
            onChange={updateCandidate}
            options={imageOptions}
            allLabel="Select candidate"
          />
          <button
            type="button"
            onClick={() => {
              setBaseline(candidate);
              setCandidate(baseline);
              updateCompareUrl({ baseline: candidate, candidate: baseline });
            }}
            disabled={!baseline && !candidate}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Swap
          </button>
          <SearchableSelect
            label="Model"
            value={model}
            onChange={updateModel}
            options={modelOptions}
            allLabel="All Models"
          />
          <SearchableSelect
            label="Device"
            value={device}
            onChange={updateDevice}
            options={deviceOptions}
            allLabel="All Devices"
          />
          <SearchableSelect
            label="Task"
            value={task}
            onChange={updateTask}
            options={taskOptions}
            allLabel="All Tasks"
          />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Threshold
            </span>
            <div className="group relative w-28">
              <input
                type="number"
                min="0"
                step="0.5"
                value={perfThresholdPct}
                onChange={(event) => updatePerfThresholdPct(event.target.value)}
                className="w-full rounded-md border border-zinc-200 bg-white py-1.5 pl-3 pr-7 text-sm tabular-nums shadow-sm outline-none transition-colors hover:border-zinc-300 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:focus:border-zinc-500 dark:focus:ring-zinc-100/10 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-zinc-400">
                %
              </span>
            </div>
          </label>
        </div>
      </div>

      {!hasFilters && (
        <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700">
          <span className="text-sm text-zinc-400">Loading image filters...</span>
        </div>
      )}

      {hasFilters && (!baseline || !candidate) && (
        <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700">
          <span className="text-sm text-zinc-400">
            Select a baseline image and a candidate image to compare release metrics.
          </span>
        </div>
      )}

      {baseline && candidate && baseline === candidate && (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 px-5 py-4 text-sm text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/30 dark:text-yellow-200">
          Pick two different images. Baseline and candidate are currently the same.
        </div>
      )}

      {compareUrl && isLoading && (
        <div className="flex h-64 items-center justify-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-300" />
          <span className="text-sm text-zinc-400">Comparing images...</span>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error.message}
        </div>
      )}

      {data && !isLoading && (
        <>
          <VerdictHero
            summary={derivedSummary}
            perfThreshold={perfThreshold}
          />

          <div className="rounded-xl border border-zinc-200/80 bg-white px-5 py-4 dark:border-zinc-800/80 dark:bg-zinc-950">
            <div className="grid gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 md:grid-cols-[1fr_auto_1fr] dark:border-zinc-800 dark:bg-zinc-800">
              <div className="bg-white p-4 dark:bg-zinc-950">
                <div className="mb-1.5 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
                  Baseline image
                </div>
                <div
                  className="truncate font-mono text-sm text-zinc-900 dark:text-zinc-100"
                  title={data.baseline}
                >
                  {baselineShort}
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-zinc-400">
                  {data.baseline}
                </div>
              </div>
              <div className="grid place-items-center bg-white px-3 dark:bg-zinc-950">
                <button
                  type="button"
                  onClick={() => {
                    setBaseline(candidate);
                    setCandidate(baseline);
                    updateCompareUrl({
                      baseline: candidate,
                      candidate: baseline,
                    });
                  }}
                  className="grid h-8 w-8 place-items-center rounded-full border border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:text-zinc-100"
                  title="Swap baseline & candidate"
                  aria-label="Swap baseline and candidate"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path d="M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8" />
                  </svg>
                </button>
              </div>
              <div className="bg-white p-4 dark:bg-zinc-950">
                <div className="mb-1.5 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                  Candidate image
                </div>
                <div
                  className="truncate font-mono text-sm text-zinc-900 dark:text-zinc-100"
                  title={data.candidate}
                >
                  {candidateShort}
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-zinc-400">
                  {data.candidate}
                </div>
              </div>
            </div>
            <div className="mt-3 font-mono text-[11px] text-zinc-400">
              Generated {formatDate(data.generatedAt)}
            </div>
          </div>

          <SummaryStrip
            summary={derivedSummary}
            perfThreshold={perfThreshold}
          />

          <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
            <Distribution
              perf={classifiedPerf}
              evals={classifiedEval}
              perfThreshold={perfThreshold}
            />
            <ByModel items={[...classifiedPerf, ...classifiedEval]} />
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200/80 bg-white px-4 py-3 dark:border-zinc-800/80 dark:bg-zinc-950">
            <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">
              Show
            </span>
            <StatusChip
              on={statusFilters.regression}
              onClick={() => toggleStatus("regression")}
              dot="bg-red-500"
            >
              Regressions
            </StatusChip>
            <StatusChip
              on={statusFilters.improvement}
              onClick={() => toggleStatus("improvement")}
              dot="bg-emerald-500"
            >
              Improvements
            </StatusChip>
            <StatusChip
              on={statusFilters.unchanged}
              onClick={() => toggleStatus("unchanged")}
              dot="bg-zinc-400"
            >
              Noise
            </StatusChip>
            <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
            <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">
              Area
            </span>
            <select
              value={areaFilter}
              onChange={(e) => setAreaFilter(e.target.value as AreaFilter)}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="all">All</option>
              <option value="perf">Performance</option>
              <option value="eval">Accuracy</option>
            </select>
            <div className="ml-auto flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                className="text-zinc-400"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                placeholder="Search model, metric, config…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-44 bg-transparent text-xs outline-none placeholder:text-zinc-400"
              />
            </div>
          </div>

          {showPerf && (
            <DeltaTable
              kind="perf"
              title="Performance delta"
              subtitle="Throughput, latency, and tokens-per-second deltas across configs."
              rows={perfRows}
              totalCount={data.perf.deltas.length}
              thresholds={{ perfPct: perfThreshold }}
              expandedRow={expandedRow}
              setExpandedRow={setExpandedRow}
            />
          )}

          {showEval && (
            <DeltaTable
              kind="eval"
              title="Accuracy delta"
              subtitle="Eval task scores compared in percentage points."
              rows={evalRows}
              totalCount={data.eval.deltas.length}
              thresholds={{ perfPct: perfThreshold }}
              expandedRow={expandedRow}
              setExpandedRow={setExpandedRow}
            />
          )}

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <CoverageCard
              title="Missing from baseline"
              items={missingBaseline}
              emptyText="Every candidate check has a matching baseline check."
            />
            <CoverageCard
              title="Missing from candidate"
              items={missingCandidate}
              emptyText="Every baseline check has a matching candidate check."
            />
          </div>
        </>
      )}
    </div>
  );
}
