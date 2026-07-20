"use client";

import { useState } from "react";
import useSWR from "swr";
import { StatCard } from "@/components/stat-card";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type DeltaStatus = "regression" | "improvement" | "unchanged" | "noisy";

interface BuildRow {
  id: string;
  number: string;
  state: string;
  branch: string;
  commit: string;
  created_at: string;
  finished_at: string;
  web_url: string;
  message: string;
}

interface TaggedJob {
  name: string;
  state: string;
  web_url: string;
  started_at: string;
  finished_at: string;
  soft_failed: string;
  category: "new" | "recurring" | "unknown";
}

interface DeltaItem {
  area: "perf" | "eval";
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
  significance: number | null;
}

interface CompareSummary {
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

interface NightlyEntry {
  commit: string;
  shortCommit: string;
  image: string;
  sourceImage: string;
  date: string;
  perfEval: {
    build: BuildRow;
  };
  fullCI: {
    build: BuildRow | null;
    match: {
      type: "schedule";
      commitMatches: boolean;
      scheduleDeltaSeconds: number;
    } | null;
    comparisonAvailable: boolean;
    failedJobs: TaggedJob[];
    fixedJobs: TaggedJob[];
  };
  deltaVsPrev: {
    prevCommit: string | null;
    prevImage: string | null;
    prevSourceImage: string | null;
    summary: CompareSummary | null;
    worstRegressions: DeltaItem[];
    perfDeltas: DeltaItem[];
    evalDeltas: DeltaItem[];
  };
}

interface NightlyResponse {
  nightlies: NightlyEntry[];
  generatedAt: string;
  error?: string;
}

function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
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
  if (item.area === "eval") return `${sign}${(item.delta * 100).toFixed(2)} pp`;
  if (item.deltaPct === null) return `${sign}${item.delta.toFixed(4)}`;
  return `${sign}${(item.deltaPct * 100).toFixed(1)}%`;
}

function StateBadge({ state }: { state: string }) {
  const cls =
    state === "passed"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
      : state === "failed"
        ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
        : state === "failing"
          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
          : state === "running" || state === "scheduled"
            ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
            : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>
      {state}
    </span>
  );
}

function StatusPill({ status }: { status: DeltaStatus }) {
  const map: Record<DeltaStatus, { label: string; cls: string }> = {
    regression: {
      label: "Regression",
      cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    },
    improvement: {
      label: "Improvement",
      cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    },
    noisy: {
      label: "Noisy",
      cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    },
    unchanged: {
      label: "Unchanged",
      cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    },
  };
  const { label, cls } = map[status];
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function FailureSection({
  title,
  jobs,
  titleColor,
}: {
  title: string;
  jobs: TaggedJob[];
  titleColor: string;
}) {
  if (jobs.length === 0) return null;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <span className={`text-xs font-semibold ${titleColor}`}>
          {title} ({jobs.length})
        </span>
      </div>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {jobs.map((j) => (
          <li key={j.name} className="flex items-center justify-between px-4 py-2 text-sm">
            <span className="truncate">{j.name}</span>
            {j.web_url && (
              <a
                href={j.web_url}
                target="_blank"
                rel="noreferrer"
                className="ml-3 shrink-0 text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                log
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeltaList({ deltas, limit = 8 }: { deltas: DeltaItem[]; limit?: number }) {
  const shown = deltas.slice(0, limit);
  if (shown.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900/50 dark:text-zinc-400">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2 text-left font-medium">Metric</th>
            <th className="px-3 py-2 text-left font-medium">Model · Dim</th>
            <th className="px-3 py-2 text-right font-medium">Baseline</th>
            <th className="px-3 py-2 text-right font-medium">Candidate</th>
            <th className="px-3 py-2 text-right font-medium">Δ</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/50">
          {shown.map((d, i) => (
            <tr key={`${d.area}|${d.model}|${d.dimension}|${d.metric}|${i}`}>
              <td className="px-3 py-2"><StatusPill status={d.status} /></td>
              <td className="px-3 py-2">{d.metricLabel}</td>
              <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                {d.model.split("/").pop()} · {d.dimension}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{formatValue(d, d.baselineValue)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatValue(d, d.candidateValue)}</td>
              <td className={`px-3 py-2 text-right tabular-nums font-medium ${
                d.status === "regression"
                  ? "text-red-600 dark:text-red-400"
                  : d.status === "improvement"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-zinc-500"
              }`}>
                {formatDelta(d)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {deltas.length > limit && (
        <div className="border-t border-zinc-200 px-3 py-2 text-right text-xs text-zinc-400 dark:border-zinc-800">
          Showing {limit} of {deltas.length}. Use Compare for the full list.
        </div>
      )}
    </div>
  );
}

function NightlyRow({ entry }: { entry: NightlyEntry }) {
  const [open, setOpen] = useState(false);
  const { fullCI, deltaVsPrev } = entry;
  const summary = deltaVsPrev.summary;
  const newCount = fullCI.failedJobs.filter((j) => j.category === "new").length;
  const recurringCount = fullCI.failedJobs.filter((j) => j.category === "recurring").length;
  const compareHref =
    deltaVsPrev.prevSourceImage
      ? `/compare?baseline=${encodeURIComponent(deltaVsPrev.prevSourceImage)}&candidate=${encodeURIComponent(entry.sourceImage)}`
      : null;
  const ciCommit = fullCI.build?.commit.slice(0, 7);

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-base font-semibold tracking-tight">
              {entry.shortCommit}
            </span>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              {formatDateTime(entry.date)}
            </span>
            {fullCI.build && <StateBadge state={fullCI.build.state} />}
            {!fullCI.build && (
              <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                no paired Full CI
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <span
              className="font-mono"
              title={
                entry.sourceImage === entry.image
                  ? entry.image
                  : `Tested as ${entry.sourceImage}`
              }
            >
              {entry.image}
            </span>
            {entry.sourceImage !== entry.image && (
              <span title={entry.sourceImage}>tested via the equivalent ECR artifact</span>
            )}
            <a
              href={entry.perfEval.build.web_url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Perf/eval #{entry.perfEval.build.number}
            </a>
            {fullCI.build && (
              <a
                href={fullCI.build.web_url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                Full CI #{fullCI.build.number}
              </a>
            )}
            {fullCI.build && fullCI.match && (
              <span
                title={
                  fullCI.match.commitMatches
                    ? "Full CI and image use the same vLLM commit"
                    : "The independently scheduled builds use different commits"
                }
              >
                CI commit {ciCommit}
                {!fullCI.match.commitMatches &&
                  ` · paired ${fullCI.match.scheduleDeltaSeconds}s apart`}
              </span>
            )}
            {compareHref && (
              <a
                href={compareHref}
                onClick={(e) => e.stopPropagation()}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                Compare vs {deltaVsPrev.prevCommit?.slice(0, 7)}
              </a>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-3 text-right text-xs">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-400">CI fails</div>
            <div className={`text-lg font-semibold tabular-nums ${
              !fullCI.build
                ? "text-zinc-400"
                : fullCI.failedJobs.length > 0
                  ? "text-red-600 dark:text-red-400"
                  : fullCI.comparisonAvailable
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-zinc-400"
            }`}>
              {fullCI.build ? fullCI.failedJobs.length : "\u2014"}
            </div>
            {fullCI.failedJobs.length > 0 && (
              <div className="text-[10px] text-zinc-400">
                {fullCI.comparisonAvailable
                  ? `${newCount} new · ${recurringCount} recurring`
                  : "observed so far"}
              </div>
            )}
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-400">Regressions</div>
            <div className={`text-lg font-semibold tabular-nums ${
              summary && summary.regressions > 0 ? "text-red-600 dark:text-red-400" : "text-zinc-400"
            }`}>
              {summary ? summary.regressions : "—"}
            </div>
            {summary && (
              <div className="text-[10px] text-zinc-400">
                +{summary.improvements} improved
              </div>
            )}
          </div>
          <span className={`mt-2 inline-block text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}>
            ▾
          </span>
        </div>
      </button>

      {open && (
        <div className="space-y-5 border-t border-zinc-200 bg-zinc-50/40 px-5 py-5 dark:border-zinc-800 dark:bg-zinc-900/20">
          {/* Full CI block */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Full CI vs previous nightly
            </h3>
            {!fullCI.build ? (
              <p className="text-sm text-zinc-500">
                No scheduled Full CI build was found within five minutes of this
                perf/eval nightly.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Full CI commit <span className="font-mono">{ciCommit}</span>
                  {fullCI.match && !fullCI.match.commitMatches && (
                    <>
                      {" "}is paired to image commit{" "}
                      <span className="font-mono">{entry.shortCommit}</span> by
                      their schedule time ({fullCI.match.scheduleDeltaSeconds}s apart).
                    </>
                  )}
                </p>
                {!fullCI.comparisonAvailable && (
                  <p className="text-sm text-zinc-500">
                    New, recurring, and fixed classifications are available once
                    both this and the previous paired Full CI builds are complete.
                  </p>
                )}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {fullCI.comparisonAvailable ? (
                    <>
                      <FailureSection
                        title="New failures"
                        jobs={fullCI.failedJobs.filter((j) => j.category === "new")}
                        titleColor="text-red-600 dark:text-red-400"
                      />
                      <FailureSection
                        title="Recurring failures"
                        jobs={fullCI.failedJobs.filter((j) => j.category === "recurring")}
                        titleColor="text-orange-600 dark:text-orange-400"
                      />
                      <FailureSection
                        title="Fixed since previous"
                        jobs={fullCI.fixedJobs}
                        titleColor="text-emerald-600 dark:text-emerald-400"
                      />
                    </>
                  ) : (
                    <FailureSection
                      title="Observed failures"
                      jobs={fullCI.failedJobs}
                      titleColor="text-red-600 dark:text-red-400"
                    />
                  )}
                  {fullCI.failedJobs.length === 0 && fullCI.fixedJobs.length === 0 && (
                    <p className="text-sm text-zinc-500 md:col-span-3">
                      {fullCI.comparisonAvailable
                        ? "No failed or fixed jobs vs the previous nightly."
                        : "No failed jobs have been reported for this build."}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Delta block */}
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Perf / Eval deltas vs previous nightly
              {compareHref && (
                <a
                  href={compareHref}
                  className="text-[10px] font-medium normal-case tracking-normal text-blue-600 hover:underline dark:text-blue-400"
                >
                  Open in Compare →
                </a>
              )}
            </h3>
            {!summary ? (
              <p className="text-sm text-zinc-500">
                No previous nightly to compare against.
              </p>
            ) : summary.matched === 0 ? (
              <p className="text-sm text-zinc-500">
                No matched perf/eval metrics between the two nightlies (
                {summary.missingBaseline} missing in baseline, {summary.missingCandidate}{" "}
                in candidate).
              </p>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
                  <span>{summary.perfMatched} perf · {summary.evalMatched} eval matched</span>
                  <span>·</span>
                  <span className="text-red-600 dark:text-red-400">{summary.regressions} regressions</span>
                  <span className="text-emerald-600 dark:text-emerald-400">{summary.improvements} improvements</span>
                  <span>{summary.noisy} noisy</span>
                  <span>{summary.unchanged} unchanged</span>
                </div>
                {deltaVsPrev.worstRegressions.length > 0 && (
                  <div>
                    <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                      Worst regressions
                    </h4>
                    <DeltaList deltas={deltaVsPrev.worstRegressions} />
                  </div>
                )}
                {deltaVsPrev.perfDeltas.length > 0 && (
                  <div>
                    <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                      Perf
                    </h4>
                    <DeltaList deltas={deltaVsPrev.perfDeltas} />
                  </div>
                )}
                {deltaVsPrev.evalDeltas.length > 0 && (
                  <div>
                    <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                      Eval
                    </h4>
                    <DeltaList deltas={deltaVsPrev.evalDeltas} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function NightlyPage() {
  const { data, isLoading, error } = useSWR<NightlyResponse>(
    "/api/nightly",
    fetcher,
    { refreshInterval: 10 * 60 * 1000 }
  );

  const nightlies = data?.nightlies ?? [];
  const latest = nightlies[0];
  const latestSummary = latest?.deltaVsPrev.summary;
  const latestCI = latest?.fullCI;
  const newFailures =
    latestCI?.failedJobs.filter((j) => j.category === "new").length ?? 0;
  const totalFailures = latestCI?.failedJobs.length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Nightly</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Recent nightly builds with their Full CI status and perf/eval deltas
          vs the previous nightly. Rows come from scheduled perf/eval builds;
          Full CI is paired to the same schedule cycle, even when the two builds
          captured different vLLM commits.
        </p>
      </div>

      {isLoading && (
        <div className="flex h-48 items-center justify-center text-sm text-zinc-400">
          Loading nightly summary...
        </div>
      )}

      {(error || data?.error) && (
        <div className="flex h-48 items-center justify-center text-sm text-red-500">
          Failed to load nightly data.
        </div>
      )}

      {!isLoading && nightlies.length === 0 && !error && (
        <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-zinc-300 text-sm text-zinc-400 dark:border-zinc-700">
          No scheduled perf/eval nightly builds were found.
        </div>
      )}

      {latest && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Latest nightly"
            value={latest.shortCommit}
            detail={formatDateTime(latest.date)}
          />
          <StatCard
            label="Full CI failures"
            value={latestCI?.build ? totalFailures : "\u2014"}
            detail={
              !latestCI?.build
                ? "no paired build"
                : !latestCI.comparisonAvailable
                  ? `${latestCI.build.state} · ${totalFailures} observed`
                  : totalFailures > 0
                    ? `${newFailures} new`
                    : "all green"
            }
            color={
              !latestCI?.build
                ? "default"
                : !latestCI.comparisonAvailable
                  ? "yellow"
                  : totalFailures === 0
                    ? "green"
                    : newFailures > 0
                      ? "red"
                      : "yellow"
            }
          />
          <StatCard
            label="Regressions vs prev"
            value={latestSummary?.regressions ?? "—"}
            detail={
              latestSummary
                ? `${latestSummary.improvements} improvements`
                : "no previous nightly"
            }
            color={
              !latestSummary
                ? "default"
                : latestSummary.regressions > 0
                  ? "red"
                  : "green"
            }
          />
          <StatCard
            label="Metrics matched"
            value={latestSummary?.matched ?? 0}
            detail={
              latestSummary
                ? `${latestSummary.perfMatched} perf · ${latestSummary.evalMatched} eval`
                : undefined
            }
          />
        </div>
      )}

      <div className="space-y-3">
        {nightlies.map((n) => (
          <NightlyRow key={n.perfEval.build.id} entry={n} />
        ))}
      </div>
    </div>
  );
}
