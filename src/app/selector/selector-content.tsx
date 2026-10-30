"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { StatCard } from "@/components/stat-card";
import {
  SELECTOR_COMPONENT_LABELS,
  SELECTOR_COMPONENTS,
  SELECTOR_CONDITION_LABELS,
  buildUrl,
  componentFigure,
  componentOf,
  componentTitle,
  recordingFreshness,
  summarizeDecisions,
  summarizeEpisode,
  type ComponentStatus,
  type SelectorHealthResponse,
} from "@/lib/selector-health";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const CELL: Record<ComponentStatus, string> = {
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  broken: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  off: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  pending: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

const RECORDING_NAMES = {
  fnrec: "Python (fnrec)",
  kernrec_cuda: "CUDA kernels (kernrec)",
  kernrec_rocm: "ROCm kernels (kernrec)",
} as const;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatHours(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return "—";
  return seconds < 120 ? `${Math.round(seconds)}s` : `${(seconds / 60).toFixed(1)}m`;
}

function BuildLink({ build }: { build: number | null }) {
  if (build === null) return <span className="text-zinc-400">—</span>;
  return (
    <a
      href={buildUrl(build)}
      target="_blank"
      rel="noopener"
      className="tabular-nums text-blue-600 hover:underline dark:text-blue-400"
    >
      #{build}
    </a>
  );
}

function Reasons({ items }: { items: Array<{ reason: string; builds: number }> }) {
  if (items.length === 0) return <span className="text-zinc-400">0</span>;
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.reason} className="truncate" title={item.reason}>
          <span className="tabular-nums">{item.builds}</span>{" "}
          <span className="text-zinc-500 dark:text-zinc-400">{item.reason}</span>
        </li>
      ))}
    </ul>
  );
}

export default function SelectorContent() {
  const { data, error, isLoading } = useSWR<SelectorHealthResponse & { error?: string }>(
    "/api/selector",
    fetcher,
    { refreshInterval: 5 * 60 * 1000 },
  );

  const freshness = useMemo(
    () => (data?.runs ? recordingFreshness(data.runs, data.inUse, new Date()) : []),
    [data],
  );
  const days = useMemo(
    () =>
      data?.decisionCounts
        ? summarizeDecisions(data.decisionCounts, data.decisionTimings)
        : [],
    [data],
  );

  if (isLoading && !data) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading CI selector health...
      </div>
    );
  }
  if (error || data?.error || !data) {
    return (
      <div className="flex h-64 items-center justify-center text-red-400">
        Failed to load CI selector health.
      </div>
    );
  }
  if (data.schemaStatus === "pending") {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        CI selector health records are not set up on this database yet
        (migration 0036).
      </div>
    );
  }

  const openEpisodes = data.episodes.filter((episode) => episode.status === "open");
  const latest = data.runs.find((run) => run.settled);
  const brokenLatest = latest
    ? latest.components.filter((item) => item.status === "broken").length
    : 0;
  const today = days[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">CI Selector</h1>
        <p className="mt-1 text-zinc-500 dark:text-zinc-400">
          Whether the recordings the test selector decides from are whole and
          fresh, and whether PR builds pick them up.
        </p>
        <p className="mt-3 rounded-lg border border-zinc-200 bg-white p-3 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          PR builds run only the test steps{" "}
          <a
            href="https://github.com/vllm-project/ci-infra/tree/main/buildkite/ci_selector"
            target="_blank"
            rel="noopener"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            ci-selector
          </a>{" "}
          picks, from recordings the scheduled Full CI runs on main make: a
          Python function table and CUDA and ROCm kernel tables, each kernel
          table paired with a symbol map from the image builds. The collect
          steps are soft-fail, so a broken one never turns a build red; this
          page and its alerts are how it gets noticed. Hover a cell for its
          verdict.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Open alerts"
          value={openEpisodes.length}
          color={openEpisodes.length ? "red" : "green"}
          detail="selector-health episodes"
        />
        <StatCard
          label="Latest completed run"
          value={latest ? `#${latest.buildNumber}` : "—"}
          color={latest ? (brokenLatest ? "red" : "green") : "default"}
          detail={
            latest
              ? `${latest.kind} · ${brokenLatest ? `${brokenLatest} not whole` : "all whole"}`
              : undefined
          }
        />
        <StatCard
          label="PR decisions today"
          value={today?.total ?? 0}
          detail={
            today
              ? `${today.applied} applied · ${today.fallback.reduce((sum, item) => sum + item.builds, 0)} fallback`
              : "UTC day"
          }
        />
        <StatCard
          label="Selector time today"
          value={formatSeconds(today?.p50Seconds ?? null)}
          detail={`p50 · p95 ${formatSeconds(today?.p95Seconds ?? null)}`}
        />
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Freshness</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-5 py-3 font-medium">Recording</th>
                <th className="px-3 py-3 font-medium">Published by</th>
                <th className="px-3 py-3 text-right font-medium">Age</th>
                <th
                  className="px-3 py-3 text-right font-medium whitespace-nowrap"
                  title="How far the published recording trails the newest completed full run"
                >
                  Behind newest run
                </th>
                <th
                  className="px-3 py-3 font-medium whitespace-nowrap"
                  title={`Median recording build in PR decisions over the last ${data.inUse?.windowHours ?? 6} hours`}
                >
                  PR builds use
                </th>
              </tr>
            </thead>
            <tbody>
              {freshness.map((row) => {
                const stale = row.behindHours !== null && row.behindHours > 30;
                return (
                  <tr
                    key={row.recording}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50"
                  >
                    <td className="px-5 py-2.5">{RECORDING_NAMES[row.recording]}</td>
                    <td className="px-3 py-2.5">
                      <BuildLink build={row.published?.buildNumber ?? null} />
                      {row.published && (
                        <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                          {row.published.kind} · {formatTime(row.published.createdAt)}
                        </span>
                      )}
                      {!row.published && (
                        <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                          nothing in {data.windowDays} days
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {formatHours(row.ageHours)}
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right tabular-nums ${stale ? "font-medium text-red-600 dark:text-red-400" : ""}`}
                    >
                      {formatHours(row.behindHours)}
                    </td>
                    <td className="px-3 py-2.5">
                      {row.recording === "kernrec_rocm" ? (
                        <span className="text-xs text-zinc-400">not in decisions</span>
                      ) : (
                        <BuildLink build={row.usedBuild} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Scheduled full runs</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-5 py-3 font-medium">Build</th>
                <th className="px-3 py-3 font-medium">Started</th>
                {SELECTOR_COMPONENTS.map((component) => (
                  <th key={component} className="px-2 py-3 font-medium whitespace-nowrap">
                    {SELECTOR_COMPONENT_LABELS[component]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => (
                <tr
                  key={run.buildNumber}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50"
                >
                  <td className="px-5 py-2 whitespace-nowrap">
                    <BuildLink build={run.buildNumber} />
                    <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                      {run.kind}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                    {formatTime(run.createdAt)}
                  </td>
                  {SELECTOR_COMPONENTS.map((component) => {
                    const item = componentOf(run, component);
                    return (
                      <td key={component} className="px-2 py-1.5">
                        <span
                          className={`block rounded px-2 py-1 text-xs whitespace-nowrap tabular-nums ${CELL[item?.status ?? "off"]}`}
                          title={componentTitle(item)}
                        >
                          {componentFigure(item)}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {data.runs.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-zinc-400">
                    No scheduled full runs recorded yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
          Cells show usable rows and delivered/expected jobs. Runs before
          ci-infra#881 have no job counts; their cells come from the collect log.
        </p>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">PR decisions by day</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-5 py-3 font-medium">Day (UTC)</th>
                <th className="px-3 py-3 text-right font-medium">Builds</th>
                <th className="px-3 py-3 text-right font-medium">Applied</th>
                <th className="px-3 py-3 font-medium">Skipped</th>
                <th className="px-3 py-3 font-medium">Fallback</th>
                <th
                  className="px-3 py-3 text-right font-medium"
                  title="No decision artifact: docs-only builds, or a bootstrap that failed"
                >
                  Missing
                </th>
                <th className="px-3 py-3 text-right font-medium whitespace-nowrap">p50 / p95</th>
                <th className="px-3 py-3 font-medium">ci-infra</th>
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr
                  key={day.day}
                  className="border-b border-zinc-100 align-top last:border-0 dark:border-zinc-800/50"
                >
                  <td className="px-5 py-2.5 whitespace-nowrap">{day.day}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{day.total}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{day.applied}</td>
                  <td className="max-w-[16rem] px-3 py-2.5 text-xs">
                    <Reasons items={day.skipped} />
                  </td>
                  <td
                    className={`max-w-[16rem] px-3 py-2.5 text-xs ${day.selectorErrors ? "text-red-600 dark:text-red-400" : ""}`}
                  >
                    <Reasons items={day.fallback} />
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{day.missing}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">
                    {formatSeconds(day.p50Seconds)} / {formatSeconds(day.p95Seconds)}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs">
                    {day.ciInfraCommits.map((commit) => (
                      <a
                        key={commit}
                        href={`https://github.com/vllm-project/ci-infra/commit/${commit}`}
                        target="_blank"
                        rel="noopener"
                        className="block text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {commit.slice(0, 10)}
                      </a>
                    ))}
                  </td>
                </tr>
              ))}
              {days.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-zinc-400">
                    No PR decisions recorded yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Alerts</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-5 py-3 font-medium">Condition</th>
                <th className="px-3 py-3 font-medium">Summary</th>
                <th className="px-3 py-3 font-medium whitespace-nowrap">Opened</th>
                <th className="px-3 py-3 font-medium whitespace-nowrap">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {data.episodes.map((episode) => (
                <tr
                  key={episode.alertId}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50"
                >
                  <td className="px-5 py-2.5 whitespace-nowrap">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${episode.status === "open" ? CELL.broken : CELL.ok}`}
                    >
                      {episode.status}
                    </span>{" "}
                    {SELECTOR_CONDITION_LABELS[episode.condition]}
                  </td>
                  <td className="px-3 py-2.5">{summarizeEpisode(episode)}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                    {formatTime(episode.openedAt)}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                    {episode.resolvedAt ? formatTime(episode.resolvedAt) : "—"}
                  </td>
                </tr>
              ))}
              {data.episodes.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-zinc-400">
                    No selector-health alerts in the last {data.windowDays} days
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Recorded by the alerting worker after each full run (04:45 and 16:45
        Pacific) and hourly for PR decisions · last {data.windowDays} days ·
        generated {new Date(data.generatedAt).toLocaleString()}
      </p>
    </div>
  );
}
