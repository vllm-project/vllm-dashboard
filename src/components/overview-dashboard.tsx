"use client";

import Link from "next/link";
import useSWR from "swr";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}`);
  return response.json();
};

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

interface BuildSummaryResponse {
  summary: { total: number; passed: number; failed: number; passRate: number };
  builds: Array<{
    number: string | null;
    state: string;
    commit: string | null;
    author: string | null;
    message: string;
    created_at: string | null;
  }>;
  error?: string;
}

interface QueueRow {
  queue: string;
  polled_at: string;
  agents_idle: number;
  agents_busy: number;
  agents_total: number;
  jobs_scheduled: number;
  jobs_running: number;
  jobs_waiting: number;
  p90_wait_secs: number | null;
}

interface MetricsResponse {
  latest: QueueRow[];
  error?: string;
}

interface Regression {
  area: "perf" | "eval";
  key: string;
  deltaPct: number | null;
  significance: number | null;
}

interface CompareSummary {
  matched: number;
  perfMatched: number;
  evalMatched: number;
  regressions: number;
  improvements: number;
  noisy: number;
  missingBaseline: number;
  missingCandidate: number;
}

interface NightlyResponse {
  nightlies: Array<{
    shortCommit: string;
    date: string;
    fullCI: {
      build: { state: string } | null;
      failedJobs: Array<{ category: "new" | "recurring" | "unknown" }>;
    };
    deltaVsPrev: {
      summary: CompareSummary | null;
      worstRegressions: Regression[];
    };
  }>;
  error?: string;
}

type Tone = "neutral" | "good" | "warning" | "critical" | "info";

const toneClasses: Record<Tone, string> = {
  neutral:
    "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  good:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  warning:
    "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  critical:
    "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300",
  info:
    "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
};

function StatusBadge({ children, tone }: { children: React.ReactNode; tone: Tone }) {
  return (
    <span
      className={`inline-flex min-h-6 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}

function formatWait(seconds: number | null | undefined): string {
  if (!seconds) return "No wait";
  if (seconds < 60) return `${Math.round(seconds)}s P90 wait`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m P90 wait`;
  return `${(seconds / 3600).toFixed(1)}h P90 wait`;
}

function formatFreshness(value: string | null | undefined): string {
  if (!value) return "Recent";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recent";
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function StatusCard({
  title,
  value,
  detail,
  badge,
  tone,
  href,
  linkLabel,
}: {
  title: string;
  value: string;
  detail: string;
  badge: string;
  tone: Tone;
  href: string;
  linkLabel: string;
}) {
  return (
    <article className="flex min-w-0 min-h-[158px] flex-col gap-2.5 overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-3">
        <h2 className="min-w-0 text-sm font-semibold text-zinc-950 dark:text-zinc-50">
          {title}
        </h2>
        <StatusBadge tone={tone}>{badge}</StatusBadge>
      </div>
      <p className="text-3xl font-bold tracking-[-0.03em] text-zinc-950 dark:text-zinc-50">
        {value}
      </p>
      <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        {detail}
      </p>
      <Link
        href={href}
        className="dashboard-control mt-auto inline-flex min-h-10 items-center self-start rounded-md text-xs font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
      >
        {linkLabel} <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

interface AttentionItem {
  id: string;
  severity: "Critical" | "High" | "Medium";
  area: string;
  signal: string;
  scope: string;
  confidence: string;
  href: string;
  action: string;
}

function AttentionQueue({ items }: { items: AttentionItem[] }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 px-4 py-3.5 dark:border-zinc-800">
        <h2 className="text-[13px] font-semibold text-zinc-950 dark:text-zinc-50">
          Attention queue
        </h2>
        <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
          Live signals ordered by severity and recency
        </p>
      </div>
      {items.length === 0 ? (
        <div className="flex min-h-48 items-center justify-center px-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No urgent signals across the available data sources.
        </div>
      ) : (
        <>
          <div className="hidden grid-cols-[80px_100px_minmax(220px,1fr)_160px_90px_112px] gap-3 border-b border-zinc-200 bg-zinc-50 px-3.5 py-2 text-[10px] font-bold uppercase tracking-[0.05em] text-zinc-500 lg:grid dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
            <span>Severity</span>
            <span>Area</span>
            <span>Signal</span>
            <span>Scope</span>
            <span>Freshness</span>
            <span aria-hidden="true" />
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {items.map((item, index) => (
              <div
                key={item.id}
                className={`grid gap-2 px-4 py-3 text-xs lg:grid-cols-[80px_100px_minmax(220px,1fr)_160px_90px_112px] lg:items-center lg:gap-3 lg:px-3.5 lg:py-2.5 ${
                  index === 0 ? "bg-blue-50/70 dark:bg-blue-950/20" : ""
                }`}
              >
                <div className="flex items-center gap-2 font-medium">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      item.severity === "Critical"
                        ? "bg-red-500"
                        : item.severity === "High"
                          ? "bg-amber-500"
                          : "bg-zinc-400"
                    }`}
                    aria-hidden="true"
                  />
                  {item.severity}
                </div>
                <p className="text-zinc-600 dark:text-zinc-300">{item.area}</p>
                <p className="font-medium text-zinc-950 dark:text-zinc-50">
                  {item.signal}
                </p>
                <p className="truncate text-zinc-600 dark:text-zinc-300">
                  {item.scope}
                </p>
                <p className="text-zinc-500 dark:text-zinc-400">
                  {item.confidence}
                </p>
                <Link
                  href={item.href}
                  className="dashboard-control inline-flex min-h-10 items-center self-start rounded-md font-semibold text-blue-600 hover:text-blue-700 lg:min-h-8 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  {item.action} <span aria-hidden="true">→</span>
                </Link>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function OverviewDashboard() {
  const startDate = isoDaysAgo(1);
  const endDate = isoDaysAgo(0);
  const buildParams = `pipeline=CI&branch=main&startDate=${startDate}&endDate=${endDate}&format=json&jobs=false`;
  const { data: builds, error: buildsError } = useSWR<BuildSummaryResponse>(
    `/api/builds/summary?${buildParams}&per_page=5`,
    fetcher,
    { refreshInterval: 5 * 60 * 1000 },
  );
  const { data: failures } = useSWR<BuildSummaryResponse>(
    `/api/builds/summary?${buildParams}&state=failed&per_page=3`,
    fetcher,
    { refreshInterval: 5 * 60 * 1000 },
  );
  const { data: metrics, error: metricsError } = useSWR<MetricsResponse>(
    "/api/metrics?hours=24",
    fetcher,
    { refreshInterval: 60 * 1000 },
  );
  const { data: nightly, error: nightlyError } = useSWR<NightlyResponse>(
    "/api/nightly?limit=2",
    fetcher,
    { refreshInterval: 10 * 60 * 1000 },
  );

  const ci = builds?.summary;
  const latestNightly = nightly?.nightlies[0];
  const nightlySummary = latestNightly?.deltaVsPrev.summary;
  const queues = metrics?.latest ?? [];
  const worstQueue = queues.reduce<QueueRow | null>((worst, row) => {
    if (!worst) return row;
    return (row.p90_wait_secs ?? 0) > (worst.p90_wait_secs ?? 0) ? row : worst;
  }, null);
  const waitingJobs = queues.reduce(
    (total, row) => total + row.jobs_scheduled + row.jobs_waiting,
    0,
  );
  const staleQueues = queues.filter(
    (row) =>
      Math.max(...queues.map((item) => new Date(item.polled_at).getTime())) -
        new Date(row.polled_at).getTime() >
      10 * 60_000,
  ).length;
  const coverageMissing = nightlySummary
    ? nightlySummary.missingBaseline + nightlySummary.missingCandidate
    : 0;

  const attention: AttentionItem[] = [];
  for (const build of failures?.builds ?? []) {
    attention.push({
      id: `build-${build.number ?? build.commit ?? build.message}`,
      severity: "Critical",
      area: "CI Health",
      signal: build.message || "Full CI failure",
      scope: build.commit ?? `Build #${build.number ?? "—"}`,
      confidence: formatFreshness(build.created_at),
      href: "/ci/builds",
      action: "Investigate",
    });
  }
  for (const [index, regression] of (
    latestNightly?.deltaVsPrev.worstRegressions ?? []
  ).slice(0, 2).entries()) {
    const delta = regression.deltaPct;
    attention.push({
      id: `regression-${index}-${regression.key}`,
      severity: "High",
      area: regression.area === "perf" ? "Performance" : "Evaluation",
      signal: `${regression.key}${delta === null ? " regressed" : ` ${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`}`,
      scope: latestNightly?.shortCommit ?? "Latest nightly",
      confidence:
        regression.significance === null
          ? "Detected"
          : `${regression.significance.toFixed(1)}σ`,
      href: "/nightly",
      action: "Compare",
    });
  }
  if (worstQueue && ((worstQueue.p90_wait_secs ?? 0) > 600 || waitingJobs > 0)) {
    attention.push({
      id: `queue-${worstQueue.queue}`,
      severity: (worstQueue.p90_wait_secs ?? 0) > 1800 ? "High" : "Medium",
      area: "Infrastructure",
      signal: `${formatWait(worstQueue.p90_wait_secs)} · ${waitingJobs} waiting`,
      scope: worstQueue.queue,
      confidence: formatFreshness(worstQueue.polled_at),
      href: "/queue",
      action: "Open queue",
    });
  }
  if (coverageMissing > 0) {
    attention.push({
      id: "coverage-missing",
      severity: "Medium",
      area: "Coverage",
      signal: `${coverageMissing} metrics missing a comparison pair`,
      scope: latestNightly?.shortCommit ?? "Latest nightly",
      confidence: latestNightly ? formatFreshness(latestNightly.date) : "Unknown",
      href: "/nightly",
      action: "Review gaps",
    });
  }

  const isLoading = !builds && !metrics && !nightly;
  const hasError = buildsError || metricsError || nightlyError;

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-5 border-b border-zinc-200 pb-5 sm:flex-row sm:items-end sm:justify-between dark:border-zinc-800">
        <div>
          <h1 className="text-[28px] font-bold tracking-[-0.025em]">Overview</h1>
          <p className="mt-1 max-w-3xl text-[13px] leading-5 text-zinc-500 dark:text-zinc-400">
            A single attention queue across CI health, infrastructure,
            performance, and evaluation.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="rounded-md border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
            main · CI
          </span>
          <span className="rounded-md border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
            Last 24 hours
          </span>
        </div>
      </header>

      {hasError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Some live sources are unavailable. Available sections continue to update.
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        <StatusCard
          title="CI Health"
          value={ci ? `${ci.passRate}% pass` : isLoading ? "Loading…" : "Unavailable"}
          detail={
            ci
              ? `${ci.failed} failed · ${ci.total} builds in the last 24 hours`
              : "Buildkite summary has not returned yet"
          }
          badge={ci ? (ci.passRate >= 90 ? "Healthy" : "Degraded") : "Live data"}
          tone={ci ? (ci.passRate >= 90 ? "good" : "critical") : "neutral"}
          href="/ci/builds"
          linkLabel="Open CI Health"
        />
        <StatusCard
          title="Infrastructure"
          value={worstQueue ? formatWait(worstQueue.p90_wait_secs) : isLoading ? "Loading…" : "No active wait"}
          detail={`${waitingJobs} waiting jobs · ${staleQueues} stale queue${staleQueues === 1 ? "" : "s"}`}
          badge={
            (worstQueue?.p90_wait_secs ?? 0) > 1800
              ? "Capacity risk"
              : waitingJobs > 0
                ? "Watch"
                : "Healthy"
          }
          tone={
            (worstQueue?.p90_wait_secs ?? 0) > 1800
              ? "warning"
              : waitingJobs > 0
                ? "info"
                : "good"
          }
          href="/queue"
          linkLabel="Open Infrastructure"
        />
        <StatusCard
          title="Nightly Intelligence"
          value={
            latestNightly?.fullCI.build
              ? `Full CI ${latestNightly.fullCI.build.state}`
              : isLoading
                ? "Loading…"
                : "No paired build"
          }
          detail={
            nightlySummary
              ? `${nightlySummary.regressions} regressions · ${nightlySummary.improvements} improvements · ${nightlySummary.noisy} noisy`
              : "Waiting for a comparable nightly pair"
          }
          badge={
            nightlySummary?.regressions
              ? `${nightlySummary.regressions} regressions`
              : "No regressions"
          }
          tone={nightlySummary?.regressions ? "critical" : "good"}
          href="/nightly"
          linkLabel="Open Nightly"
        />
      </div>

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_372px]">
        <AttentionQueue items={attention.slice(0, 6)} />
        <aside className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-4 py-3.5 dark:border-zinc-800">
            <h2 className="text-[13px] font-semibold text-zinc-950 dark:text-zinc-50">
              Latest comparison coverage
            </h2>
            <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              Matched evidence from the latest nightly pair
            </p>
          </div>
          <div className="space-y-5 p-4">
            {[
              ["Performance", nightlySummary?.perfMatched ?? 0],
              ["Evaluation", nightlySummary?.evalMatched ?? 0],
            ].map(([label, matched]) => (
              <div
                key={label}
                className="flex min-h-14 items-center justify-between gap-4 rounded-md border border-zinc-200 bg-zinc-50 px-3 dark:border-zinc-800 dark:bg-zinc-900/60"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-xs font-semibold text-zinc-950 dark:text-zinc-50">
                    {label}
                  </h3>
                </div>
                <StatusBadge tone={matched ? "info" : "neutral"}>
                  {matched} matched
                </StatusBadge>
              </div>
            ))}
            <div className="flex items-center justify-between gap-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-xs dark:border-amber-900 dark:bg-amber-950/40">
              <span className="font-semibold text-amber-900 dark:text-amber-200">
                Comparison gaps
              </span>
              <span className="text-amber-700 dark:text-amber-300">
                {coverageMissing} total
              </span>
            </div>
            <Link
              href="/nightly"
              className="dashboard-control inline-flex min-h-10 items-center rounded-md text-xs font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              Review nightly evidence <span aria-hidden="true">→</span>
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
