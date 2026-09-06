"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { JobName } from "@/components/job-name";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelEmpty } from "@/components/panel";
import { StatCard } from "@/components/stat-card";
import { formatRelativeTime } from "@/lib/alerts-shared";
import type {
  OverviewBuild,
  OverviewResponse,
} from "@/lib/overview-types";

const fetcher = async (url: string) => {
  const response = await fetch(url);
  const data = (await response.json()) as OverviewResponse;
  if (!response.ok && !data.generatedAt) {
    throw new Error(`Overview failed with ${response.status}`);
  }
  return data;
};

const REASON_LABEL: Record<string, string> = {
  infra: "infra",
  flaky: "flaky",
  code: "code",
  test: "test",
  unknown: "unknown",
  unanalyzed: "not analyzed",
};

const REASON_TONE: Record<string, string> = {
  infra: "bg-warn-soft text-warn",
  flaky: "bg-warn-soft text-warn",
  code: "bg-bad-soft text-bad",
  test: "bg-bad-soft text-bad",
  unknown: "bg-surface-muted text-muted",
  unanalyzed: "bg-surface-muted text-muted",
};

function stateTone(state: string): "green" | "red" | "yellow" | "default" {
  if (state === "passed") return "green";
  if (state === "failed" || state === "failing") return "red";
  if (state === "running" || state === "scheduled") return "yellow";
  return "default";
}

function stateBlock(state: string): string {
  switch (state) {
    case "passed":
      return "bg-ok";
    case "failed":
    case "failing":
      return "bg-bad";
    case "running":
    case "scheduled":
      return "bg-warn animate-pulse";
    default:
      return "bg-line-strong";
  }
}

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function SourceUnavailable({ what }: { what: string }) {
  return (
    <PanelEmpty>
      <span>
        {what} could not be loaded right now.
        <br />
        <span className="text-xs">The rest of the overview is unaffected.</span>
      </span>
    </PanelEmpty>
  );
}

function PanelLink({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className="dashboard-control text-xs font-medium text-accent hover:text-accent-strong"
    >
      {children} →
    </Link>
  );
}

function BuildStrip({ builds, now }: { builds: OverviewBuild[]; now: Date }) {
  const ordered = [...builds].reverse();
  return (
    <div className="flex items-end gap-1">
      {ordered.map((build) => (
        <a
          key={build.number}
          href={build.webUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`#${build.number} · ${build.state} · ${formatRelativeTime(build.createdAt, now)}\n${build.message}`}
          aria-label={`Build ${build.number}, ${build.state}`}
          className={`dashboard-control h-7 min-w-0 flex-1 rounded-sm ${stateBlock(build.state)} hover:opacity-80`}
        />
      ))}
    </div>
  );
}

export default function OverviewContent() {
  const now = useNow();
  const { data, error, isLoading } = useSWR<OverviewResponse>(
    "/api/overview",
    fetcher,
    { refreshInterval: 60_000, keepPreviousData: true },
  );

  const main = data?.main ?? null;
  const alerts = data?.alerts ?? null;
  const fast = data?.fastFailures ?? null;
  const queues = data?.queues ?? null;
  const gpu = data?.gpu ?? null;

  const latest = main?.latestFinished ?? main?.latest ?? null;
  const passDelta =
    main && main.passRate24h !== null && main.passRatePrior24h !== null
      ? main.passRate24h - main.passRatePrior24h
      : null;

  const reasonSummary = alerts
    ? Object.entries(alerts.byReason)
        .filter(([, count]) => count > 0)
        .sort(([, a], [, b]) => b - a)
        .map(([reason, count]) => `${count} ${REASON_LABEL[reason] ?? reason}`)
        .join(" · ")
    : "";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="vLLM CI at a glance: main branch health, open failures, queue backlog, and GPU fleet load."
        meta={
          data ? (
            <span>
              Updated {formatRelativeTime(data.generatedAt, now)} · refreshes
              every minute
            </span>
          ) : isLoading ? (
            "Loading…"
          ) : error ? (
            <span className="text-bad">Overview data is unavailable.</span>
          ) : null
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Main pass rate · 24h"
          value={main?.passRate24h === null || !main ? "—" : `${main.passRate24h}%`}
          color={
            !main || main.passRate24h === null
              ? "default"
              : main.passRate24h >= 80
                ? "green"
                : main.passRate24h >= 50
                  ? "yellow"
                  : "red"
          }
          delta={
            passDelta === null
              ? undefined
              : { value: passDelta, unit: "pp", label: "vs prior 24h" }
          }
          detail={
            main
              ? `${main.builds24h} builds · ${main.failed24h} failed`
              : undefined
          }
          trend={main?.dailyPassRate}
          href="/builds"
        />
        <StatCard
          label="Latest main build"
          value={
            latest
              ? latest.state.charAt(0).toUpperCase() + latest.state.slice(1)
              : "—"
          }
          color={latest ? stateTone(latest.state) : "default"}
          detail={
            latest ? (
              <>
                <a
                  href={latest.webUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-accent hover:underline"
                >
                  #{latest.number}
                </a>
                {" · "}
                <span className="font-mono">{latest.commit.slice(0, 7)}</span>
                {" · "}
                {formatRelativeTime(latest.createdAt, now)}
              </>
            ) : undefined
          }
        />
        <StatCard
          label="Open failures on main"
          value={alerts ? alerts.open : "—"}
          color={alerts ? (alerts.open > 0 ? "red" : "green") : "default"}
          detail={reasonSummary || (alerts ? "No open alerts" : undefined)}
          href="/alerts?tab=main-ci"
        />
        <StatCard
          label="Fast failures · 24h"
          value={fast ? fast.events24h : "—"}
          color={fast ? (fast.events24h > 0 ? "yellow" : "green") : "default"}
          detail={
            fast
              ? `${fast.jobs24h} jobs across ${fast.builds24h} builds`
              : undefined
          }
          href="/alerts?tab=fast-ci&window=1d"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Open failures on main"
          description="Exact Buildkite jobs failing on main until they pass again."
          actions={<PanelLink href="/alerts?tab=main-ci">All alerts</PanelLink>}
        >
          {!alerts ? (
            <SourceUnavailable what="Main CI alerts" />
          ) : alerts.top.length === 0 ? (
            <PanelEmpty>No open failures on main.</PanelEmpty>
          ) : (
            <ul className="divide-y divide-line">
              {alerts.top.map((alert) => {
                const reason = alert.classification ?? "unanalyzed";
                return (
                  <li
                    key={alert.alertId}
                    className="flex items-center gap-3 px-4 py-2.5 sm:px-5"
                  >
                    <a
                      href={alert.jobUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 flex-1 truncate text-sm font-medium text-foreground hover:text-accent"
                    >
                      <JobName name={alert.jobName} />
                    </a>
                    <span
                      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${REASON_TONE[reason]}`}
                    >
                      {REASON_LABEL[reason]}
                    </span>
                    <span
                      className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums text-bad"
                      title="Failures while open"
                    >
                      {alert.failureCount}
                    </span>
                    <span className="hidden w-16 shrink-0 text-right text-xs text-muted sm:block">
                      {formatRelativeTime(alert.lastFailedAt, now)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          title="Queue backlog"
          description={
            queues
              ? `${queues.waitingJobs} jobs waiting across ${queues.queuesWithBacklog} queues · ${queues.busyAgents}/${queues.totalAgents} agents busy`
              : "Jobs waiting for an agent, by queue."
          }
          actions={<PanelLink href="/queue">All queues</PanelLink>}
        >
          {!queues ? (
            <SourceUnavailable what="Queue snapshots" />
          ) : queues.hot.length === 0 ? (
            <PanelEmpty>No queue has waiting jobs.</PanelEmpty>
          ) : (
            <ul className="divide-y divide-line">
              {queues.hot.map((queue) => (
                <li
                  key={queue.queue}
                  className="flex items-center gap-3 px-4 py-2.5 sm:px-5"
                >
                  <Link
                    href={`/queue?queue=${encodeURIComponent(queue.queue)}`}
                    className="min-w-0 flex-1 truncate font-mono text-sm text-foreground hover:text-accent"
                  >
                    {queue.queue}
                  </Link>
                  <span
                    className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-warn"
                    title="Waiting jobs"
                  >
                    {queue.waiting}
                  </span>
                  <span
                    className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted sm:block"
                    title="Busy agents / total agents"
                  >
                    {queue.busy}/{queue.agents} busy
                  </span>
                  <span
                    className="w-14 shrink-0 text-right text-xs tabular-nums text-muted"
                    title="Median wait"
                  >
                    {formatSeconds(queue.p50WaitSecs)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Recent main builds"
          description="Newest on the right. Hover for the commit."
          actions={<PanelLink href="/builds">All builds</PanelLink>}
          padded
        >
          {!main ? (
            <SourceUnavailable what="Build history" />
          ) : main.recent.length === 0 ? (
            <PanelEmpty>No main builds in the last 7 days.</PanelEmpty>
          ) : (
            <div className="space-y-4">
              <BuildStrip builds={main.recent} now={now} />
              <ul className="divide-y divide-line text-sm">
                {main.recent.slice(0, 6).map((build) => (
                  <li
                    key={build.number}
                    className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
                  >
                    <span
                      aria-label={build.state}
                      className={`h-2 w-2 shrink-0 rounded-full ${stateBlock(build.state)}`}
                    />
                    <a
                      href={build.webUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 font-medium tabular-nums text-accent hover:underline"
                    >
                      #{build.number}
                    </a>
                    <span className="min-w-0 flex-1 truncate text-muted">
                      {build.message}
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      {formatRelativeTime(build.createdAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel
          title="GPU fleet"
          description={
            gpu
              ? `${gpu.hosts} hosts · ${gpu.gpus} GPUs · ${gpu.avgUtilPct}% average utilization · ${gpu.memPct}% memory in use`
              : "Hosts reporting telemetry, busiest first."
          }
          actions={<PanelLink href="/gpu">Fleet detail</PanelLink>}
        >
          {!gpu ? (
            <SourceUnavailable what="GPU telemetry" />
          ) : gpu.busiest.length === 0 ? (
            <PanelEmpty>No hosts are reporting.</PanelEmpty>
          ) : (
            <ul className="divide-y divide-line">
              {gpu.busiest.map((host) => (
                <li
                  key={host.hostname}
                  className="flex items-center gap-3 px-4 py-2.5 sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {host.hostname}
                      </span>
                      <span className="shrink-0 text-xs text-muted">
                        {host.gpuType ?? "GPU"} × {host.gpus}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                      <div
                        className={`h-full rounded-full ${
                          host.memPct >= 90 ? "bg-bad" : "bg-accent"
                        }`}
                        style={{ width: `${Math.min(100, host.memPct)}%` }}
                      />
                    </div>
                  </div>
                  <span
                    className="w-14 shrink-0 text-right text-sm font-semibold tabular-nums"
                    title="Memory in use"
                  >
                    {host.memPct}%
                  </span>
                  <span
                    className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-muted sm:block"
                    title="GPU utilization"
                  >
                    {host.utilPct}% util
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
