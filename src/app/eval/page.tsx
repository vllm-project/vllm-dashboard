"use client";

import { useState, useMemo, useEffect, useSyncExternalStore } from "react";
import useSWR from "swr";
import dynamic from "next/dynamic";
import { SearchableSelect } from "@/components/searchable-select";
import { StatCard } from "@/components/stat-card";
import { commitFromImage } from "@/lib/commit-from-image";

const Plot = dynamic(() => import("@/components/plotly-chart"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] items-center justify-center">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-300" />
    </div>
  ),
});

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface EvalMetric {
  name: string;
  filter: string;
  value: number;
  stderr: number;
  higher_is_better: boolean;
}

interface EvalRow {
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
  buildkite_build_id: string | null;
  buildkite_build_number: string | null;
  buildkite_build_url: string | null;
  buildkite_commit: string | null;
  buildkite_branch: string | null;
  vllm_commit: string | null;
  workload: string | null;
}

interface FiltersResponse {
  models: string[];
  tasks: string[];
  images: string[];
  filters: string[];
  metrics: string[];
}

interface EvalSample {
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

interface SamplesResponse {
  samples: EvalSample[];
  total: number;
  correct: number;
  incorrect: number;
  truncated: boolean;
}

const COLORS = [
  "#818cf8", "#fb923c", "#34d399", "#f87171",
  "#a78bfa", "#22d3ee", "#f472b6", "#fbbf24",
];

function subscribeToColorScheme(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onStoreChange);
  return () => mq.removeEventListener("change", onStoreChange);
}

function getColorSchemeSnapshot() {
  return typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

function useDarkMode() {
  return useSyncExternalStore(
    subscribeToColorScheme,
    getColorSchemeSnapshot,
    () => false
  );
}

function formatPct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return timeStr;
  }
  const msPerDay = 86400000;
  const daysAgo = (now.getTime() - d.getTime()) / msPerDay;
  if (daysAgo < 7) {
    return `${DAYS[d.getDay()]} ${timeStr}`;
  }
  const month = d.toLocaleString("en-US", { month: "short" });
  return `${month} ${d.getDate()} ${timeStr}`;
}

function shortCommit(row: {
  vllm_commit: string | null;
  buildkite_commit: string | null;
  git_hash: string | null;
  image: string | null;
}): string {
  const s =
    commitFromImage(row.image) ??
    row.vllm_commit ??
    row.buildkite_commit ??
    row.git_hash;
  return s ? s.slice(0, 7) : "—";
}

function primaryMetric(rows: EvalRow[]): { metric: string; filter: string } | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const m of r.metrics) {
      const key = `${m.name}\0${m.filter}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  if (!best) return null;
  const [metric, filter] = best.split("\0");
  return { metric, filter };
}

function pickMetric(row: EvalRow, metric: string, filter: string): EvalMetric | null {
  return (
    row.metrics.find((m) => m.name === metric && m.filter === filter) ?? null
  );
}

function ScoreChart({ rows }: { rows: EvalRow[] }) {
  const dark = useDarkMode();

  const traces = useMemo(() => {
    const byTask = new Map<string, EvalRow[]>();
    for (const r of rows) {
      if (!byTask.has(r.task)) byTask.set(r.task, []);
      byTask.get(r.task)!.push(r);
    }
    const sortedTasks = [...byTask.keys()].sort();
    const result: object[] = [];
    sortedTasks.forEach((task, i) => {
      const taskRows = byTask.get(task)!;
      const pm = primaryMetric(taskRows);
      if (!pm) return;
      const color = COLORS[i % COLORS.length];
      const series = [...taskRows].sort((a, b) => a.run_epoch - b.run_epoch);
      const points = series
        .map((r) => ({ r, m: pickMetric(r, pm.metric, pm.filter) }))
        .filter((p) => p.m !== null);
      if (points.length === 0) return;
      result.push({
        x: points.map((p) => new Date(p.r.run_epoch * 1000)),
        y: points.map((p) => p.m!.value),
        error_y: {
          type: "data",
          array: points.map((p) => p.m!.stderr),
          visible: true,
          thickness: 1,
          width: 4,
          color,
        },
        mode: "lines+markers",
        name: task,
        line: { color, width: 2, shape: "spline" },
        marker: { color, size: 8, line: { color: dark ? "#18181b" : "#ffffff", width: 1.5 } },
        customdata: points.map((p) => [
          shortCommit(p.r),
          p.r.n_shot,
          p.r.n_samples,
          pm.metric,
          pm.filter,
        ]),
        hovertemplate:
          `<b>${task}</b><br>` +
          `%{customdata[3]} (%{customdata[4]}): <b>%{y:.4f}</b><br>` +
          `commit: <b>%{customdata[0]}</b><br>` +
          `n-shot: %{customdata[1]}  samples: %{customdata[2]}` +
          `<extra></extra>`,
      });
    });
    return result;
  }, [rows, dark]);

  const axisColor = dark ? "#52525b" : "#d4d4d8";
  const gridColor = dark ? "rgba(63,63,70,0.4)" : "rgba(228,228,231,0.6)";
  const textColor = dark ? "#a1a1aa" : "#71717a";

  if (traces.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-zinc-800/80 dark:bg-zinc-950 dark:shadow-[0_1px_3px_rgba(0,0,0,0.3)]">
      <div className="px-5 pt-4 pb-0">
        <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Scores over time
        </h3>
      </div>
      <div className="-mx-px">
        <Plot
          data={traces}
          layout={{
            paper_bgcolor: "transparent",
            plot_bgcolor: "transparent",
            font: {
              family: "system-ui, -apple-system, sans-serif",
              color: textColor,
              size: 11,
            },
            xaxis: {
              type: "date" as const,
              title: { text: "Run date", font: { size: 11 }, standoff: 10 },
              tickfont: { size: 10 },
              gridcolor: gridColor,
              linecolor: axisColor,
              showline: true,
              zeroline: false,
              showgrid: true,
              ticks: "outside" as const,
              tickcolor: axisColor,
              ticklen: 4,
            },
            yaxis: {
              title: { text: "Score", font: { size: 11 }, standoff: 8 },
              tickfont: { size: 10 },
              gridcolor: gridColor,
              linecolor: axisColor,
              showline: true,
              zeroline: false,
              rangemode: "tozero" as const,
              showgrid: true,
              ticks: "outside" as const,
              tickcolor: axisColor,
              ticklen: 4,
              tickformat: ".0%",
            },
            legend: {
              font: { size: 10 },
              bgcolor: "transparent",
              borderwidth: 0,
              orientation: "h" as const,
              y: -0.22,
              x: 0.5,
              xanchor: "center" as const,
              yanchor: "top" as const,
              tracegroupgap: 4,
              itemwidth: 30,
            },
            height: 420,
            margin: { l: 56, r: 16, t: 12, b: 80 },
            hovermode: "closest" as const,
            hoverlabel: {
              bgcolor: dark ? "#27272a" : "#ffffff",
              bordercolor: dark ? "#3f3f46" : "#e4e4e7",
              font: {
                size: 11,
                family: "system-ui, -apple-system, sans-serif",
                color: dark ? "#e4e4e7" : "#27272a",
              },
              align: "left" as const,
            },
            dragmode: "zoom" as const,
          }}
          config={{
            responsive: true,
            displaylogo: false,
            modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d", "toImage"],
          }}
          useResizeHandler
          style={{ width: "100%" }}
        />
      </div>
    </div>
  );
}

function SampleItem({ sample }: { sample: EvalSample }) {
  const [open, setOpen] = useState(false);
  const correct = sample.exact_match >= 1;
  const preview = (sample.question || sample.prompt || "").slice(0, 160);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
      >
        <span
          className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            correct
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
              : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
          }`}
          title={correct ? "correct" : "incorrect"}
        >
          {correct ? "✓" : "✗"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-mono">#{sample.doc_id}</span>
            <span>·</span>
            <span>{sample.filter}</span>
            <span>·</span>
            <span>
              answer: <span className="font-mono text-zinc-700 dark:text-zinc-300">{sample.filtered_response || "∅"}</span>
            </span>
          </div>
          <div className="mt-0.5 truncate text-sm text-zinc-700 dark:text-zinc-300">
            {preview}
            {(sample.question || sample.prompt).length > 160 ? "…" : ""}
          </div>
        </div>
        <svg
          className={`mt-1 h-4 w-4 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="space-y-3 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          {sample.question && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Question</div>
              <pre className="whitespace-pre-wrap break-words rounded bg-zinc-50 p-3 text-xs text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                {sample.question}
              </pre>
            </div>
          )}
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Reference answer</div>
            <pre className="whitespace-pre-wrap break-words rounded bg-zinc-50 p-3 text-xs text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
              {sample.target || "—"}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Model response</div>
            <pre className="whitespace-pre-wrap break-words rounded bg-zinc-50 p-3 text-xs text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
              {sample.response || "—"}
            </pre>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
            <span>extracted: <span className="font-mono text-zinc-700 dark:text-zinc-300">{sample.filtered_response || "∅"}</span></span>
            <span>exact_match: <span className="font-mono text-zinc-700 dark:text-zinc-300">{sample.exact_match}</span></span>
          </div>
        </div>
      )}
    </div>
  );
}

function SamplesDrawer({
  row,
  onClose,
}: {
  row: EvalRow;
  onClose: () => void;
}) {
  const [correctness, setCorrectness] = useState<"all" | "correct" | "incorrect">("all");

  const m = row.metrics[0] ?? null;
  const metric = m?.name ?? "";
  const filter = m?.filter ?? "";

  const params = new URLSearchParams();
  params.set("build_id", row.buildkite_build_id ?? "");
  params.set("task", row.task);
  if (row.workload) params.set("workload", row.workload);
  if (correctness === "correct") params.set("correct", "true");
  if (correctness === "incorrect") params.set("correct", "false");
  params.set("limit", "200");

  const { data, isLoading } = useSWR<SamplesResponse>(
    row.buildkite_build_id ? `/api/eval/samples?${params.toString()}` : null,
    fetcher
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const samples = data?.samples ?? [];

  return (
    <div className="fixed right-0 top-0 z-50 flex h-screen w-full max-w-3xl flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="truncate text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                {row.task}
              </h2>
              <span className="font-mono text-sm text-zinc-500">{row.model}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
              {m && (
                <span>
                  {metric} ({filter}):{" "}
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {formatPct(m.value)}
                  </span>
                  <span> ± {(m.stderr * 100).toFixed(2)}%</span>
                </span>
              )}
              <span>{row.n_shot}-shot · {row.n_samples} samples</span>
              {row.buildkite_build_url && row.buildkite_build_number ? (
                <a
                  href={row.buildkite_build_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  buildkite #{row.buildkite_build_number}
                </a>
              ) : null}
              <span className="font-mono">{shortCommit(row)}</span>
              {row.image ? (
                <span className="font-mono" title={row.image}>
                  image: {row.image}
                </span>
              ) : null}
              <span>{formatTime(row.run_date)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-200 px-2.5 py-1 text-sm text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Close
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
          {(["all", "correct", "incorrect"] as const).map((opt) => {
            const active = correctness === opt;
            const n =
              opt === "correct" ? data?.correct :
              opt === "incorrect" ? data?.incorrect :
              data?.total;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setCorrectness(opt)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? opt === "correct"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                      : opt === "incorrect"
                      ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                      : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                    : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {opt[0].toUpperCase() + opt.slice(1)}
                {typeof n === "number" ? <span className="ml-1.5 opacity-70">({n})</span> : null}
              </button>
            );
          })}
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto px-6 py-4">
          {!row.buildkite_build_id && (
            <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
              No buildkite build id on this run — per-sample data isn&apos;t linked.
            </div>
          )}
          {row.buildkite_build_id && isLoading && (
            <div className="flex h-32 items-center justify-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-300" />
              <span className="text-sm text-zinc-400">Loading samples...</span>
            </div>
          )}
          {row.buildkite_build_id && !isLoading && samples.length === 0 && (
            <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
              No samples for this filter.
            </div>
          )}
          {samples.map((s) => (
            <SampleItem key={`${s.task}-${s.doc_id}-${s.filter}`} sample={s} />
          ))}
          {data?.truncated && (
            <div className="pt-2 text-center text-xs text-zinc-400">
              Showing first 200 samples of {data.total}.
            </div>
          )}
        </div>
    </div>
  );
}

const PAGE_SIZE = 50;

function LeaderboardTable({
  rows,
  onSelect,
}: {
  rows: EvalRow[];
  onSelect: (row: EvalRow) => void;
}) {
  const [page, setPage] = useState(0);

  const allRuns = useMemo(() => {
    return [...rows].sort((a, b) => b.run_epoch - a.run_epoch);
  }, [rows]);

  const totalPages = Math.ceil(allRuns.length / PAGE_SIZE);
  const pageRows = allRuns.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (allRuns.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800/80 dark:bg-zinc-950">
      <div className="flex items-baseline justify-between px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <h3 className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          All runs ({allRuns.length}) — newest first
        </h3>
        <span className="text-xs text-zinc-400">Click a row to inspect samples</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-xs font-medium text-zinc-500 dark:bg-zinc-900/50 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-2 text-left">When</th>
              <th className="px-4 py-2 text-left">Commit</th>
              <th className="px-4 py-2 text-left">Image</th>
              <th className="px-4 py-2 text-left">Model</th>
              <th className="px-4 py-2 text-left">Task</th>
              <th className="px-4 py-2 text-right">Score</th>
              <th className="px-4 py-2 text-right">± stderr</th>
              <th className="px-4 py-2 text-right">n-shot</th>
              <th className="px-4 py-2 text-right">samples</th>
              <th className="px-4 py-2 text-right">eval (s)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {pageRows.map((r) => {
              const m = r.metrics[0] ?? null;
              const clickable = !!r.buildkite_build_id;
              return (
                <tr
                  key={`${r.model}|${r.task}|${r.ingest_ts}`}
                  onClick={clickable ? () => onSelect(r) : undefined}
                  className={
                    clickable
                      ? "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                      : "opacity-70"
                  }
                  title={clickable ? "Click to view per-sample answers" : "No per-sample data linked to this run"}
                >
                  <td className="px-4 py-2 text-zinc-500 whitespace-nowrap">
                    {formatTime(r.run_date)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-zinc-500">
                    {r.buildkite_build_url ? (
                      <a
                        href={r.buildkite_build_url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {shortCommit(r)}
                      </a>
                    ) : (
                      shortCommit(r)
                    )}
                  </td>
                  <td className="max-w-[260px] px-4 py-2 font-mono text-xs text-zinc-500">
                    <span className="block truncate" title={r.image ?? undefined}>
                      {r.image ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{r.model || "—"}</td>
                  <td className="px-4 py-2">{r.task}</td>
                  <td className="px-4 py-2 text-right font-medium" title={m ? `${m.name} (${m.filter})` : undefined}>
                    {m ? formatPct(m.value) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-zinc-500">
                    {m ? `±${(m.stderr * 100).toFixed(2)}%` : "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-zinc-500">{r.n_shot}</td>
                  <td className="px-4 py-2 text-right text-zinc-500">{r.n_samples}</td>
                  <td className="px-4 py-2 text-right text-zinc-500">
                    {r.eval_seconds.toFixed(1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <span className="text-xs text-zinc-400">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, allRuns.length)} of {allRuns.length}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
              className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={page >= totalPages - 1}
              onClick={() => setPage(page + 1)}
              className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function LatestStatCards({
  rows,
}: {
  rows: EvalRow[];
}) {
  const cards = useMemo(() => {
    const byKey = new Map<string, EvalRow[]>();
    for (const r of rows) {
      const key = `${r.model}|${r.task}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(r);
    }
    const out: {
      key: string;
      task: string;
      model: string;
      latest: EvalRow;
      prev: EvalRow | null;
      pm: { metric: string; filter: string } | null;
    }[] = [];
    for (const [key, runs] of byKey) {
      const sorted = [...runs].sort((a, b) => b.run_epoch - a.run_epoch);
      const latest = sorted[0];
      const prev = sorted[1] ?? null;
      out.push({
        key,
        task: latest.task,
        model: latest.model,
        latest,
        prev,
        pm: primaryMetric(runs),
      });
    }
    return out.sort((a, b) => a.task.localeCompare(b.task));
  }, [rows]);

  if (cards.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {cards.map((c) => {
        if (!c.pm) return null;
        const m = pickMetric(c.latest, c.pm.metric, c.pm.filter);
        const prevM = c.prev ? pickMetric(c.prev, c.pm.metric, c.pm.filter) : null;
        if (!m) return null;
        let color: "default" | "green" | "red" | "yellow" = "default";
        const commit = shortCommit(c.latest);
        let detail = `n=${c.latest.n_samples}, ${c.latest.n_shot}-shot, ${commit}`;
        if (prevM) {
          const delta = m.value - prevM.value;
          const sigma = Math.sqrt(m.stderr ** 2 + prevM.stderr ** 2);
          const zish = sigma > 0 ? Math.abs(delta) / sigma : 0;
          const dir = delta >= 0 ? "↑" : "↓";
          const sign = delta >= 0 ? "+" : "";
          detail = `${dir} ${sign}${(delta * 100).toFixed(2)}pp vs prev (${zish.toFixed(1)}σ)`;
          if (m.higher_is_better) {
            if (delta < 0 && zish > 2) color = "red";
            else if (delta > 0 && zish > 2) color = "green";
            else color = "yellow";
          } else {
            if (delta > 0 && zish > 2) color = "red";
            else if (delta < 0 && zish > 2) color = "green";
            else color = "yellow";
          }
        }
        return (
          <StatCard
            key={c.key}
            label={`${c.task} — ${c.model.split("/").pop()}`}
            value={formatPct(m.value)}
            detail={detail}
            color={color}
          />
        );
      })}
    </div>
  );
}

export default function EvalPage() {
  const [model, setModel] = useState("");
  const [task, setTask] = useState("");
  const [image, setImage] = useState("");
  const [selectedRow, setSelectedRow] = useState<EvalRow | null>(null);

  const { data: filters } = useSWR<FiltersResponse>("/api/eval/filters", fetcher);

  const params = new URLSearchParams();
  if (model) params.set("model", model);
  if (task) params.set("task", task);
  if (image) params.set("image", image);

  const { data, isLoading } = useSWR<{ rows: EvalRow[] }>(
    `/api/eval?${params.toString()}`,
    fetcher,
    { refreshInterval: 10 * 60 * 1000 }
  );

  const rows = useMemo(() => data?.rows ?? [], [data?.rows]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Accuracy Evaluations
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          lm-evaluation-harness results ingested from CI runs. Click a leaderboard row
          to drill into per-sample answers (correct vs incorrect).
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border border-zinc-200/80 bg-white px-5 py-4 dark:border-zinc-800/80 dark:bg-zinc-950">
        <SearchableSelect
          label="Model"
          value={model}
          onChange={setModel}
          options={filters?.models ?? []}
          allLabel="All Models"
        />
        <SearchableSelect
          label="Task"
          value={task}
          onChange={setTask}
          options={filters?.tasks ?? []}
          allLabel="All Tasks"
        />
        <SearchableSelect
          label="Image"
          value={image}
          onChange={setImage}
          options={filters?.images ?? []}
          allLabel="All Images"
        />
      </div>

      {isLoading && (
        <div className="flex h-64 items-center justify-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600 dark:border-zinc-600 dark:border-t-zinc-300" />
          <span className="text-sm text-zinc-400">Loading evaluations...</span>
        </div>
      )}

      {!isLoading && rows.length === 0 && (
        <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700">
          <span className="text-sm text-zinc-400">
            No evaluation runs found.
          </span>
        </div>
      )}

      {!isLoading && rows.length > 0 && (
        <>
          {model && (
            <>
              <LatestStatCards rows={rows} />
              <ScoreChart rows={rows} />
            </>
          )}

          <LeaderboardTable
            rows={rows}
            onSelect={setSelectedRow}
          />
        </>
      )}

      {selectedRow && (
        <SamplesDrawer
          row={selectedRow}
          onClose={() => setSelectedRow(null)}
        />
      )}
    </div>
  );
}
