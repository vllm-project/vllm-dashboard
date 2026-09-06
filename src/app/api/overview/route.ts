import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { queryDatabricks } from "@/lib/databricks";
import { queryGpuLatest } from "@/lib/gpu-data";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import {
  toMainCiJobAlert,
  type MainCiAnalysisClassification,
  type MainCiJobAlertRow,
} from "@/lib/alerts-main-ci";
import type {
  OverviewAlerts,
  OverviewFastFailures,
  OverviewGpu,
  OverviewMain,
  OverviewQueues,
  OverviewResponse,
} from "@/lib/overview-types";

export const dynamic = "force-dynamic";

const TTL = 60_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 300 };
const RECENT_BUILDS = 24;
const TOP_ALERTS = 8;
const HOT_QUEUES = 8;
const BUSIEST_HOSTS = 6;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function isFailed(state: string): boolean {
  return state === "failed" || state === "failing";
}

function isFinished(state: string): boolean {
  return state === "passed" || isFailed(state);
}

/* ---------------------------------------------------------------- main */

async function loadMain(): Promise<OverviewMain> {
  const rows = await queryDatabricks(`
    SELECT
      b.number AS build_number,
      b.web_url,
      b.message,
      b.commit AS commit_sha,
      b.state,
      b.created_at,
      b.started_at,
      b.finished_at,
      b.github_author_username AS author,
      b.pr_number,
      TIMESTAMPDIFF(MINUTE, b.started_at, b.finished_at) AS duration_mins
    FROM vllm_data_warehouse.buildkite.build AS b
    INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p
      ON b.pipeline_id = p.id
    WHERE b._fivetran_deleted = false
      AND p.name = 'CI'
      AND b.branch = 'main'
      AND b.created_at >= CURRENT_TIMESTAMP - INTERVAL 7 DAYS
    ORDER BY b.created_at DESC
  `);

  const builds = rows.map((row) => ({
    number: str(row.build_number),
    state: str(row.state),
    webUrl: str(row.web_url),
    commit: str(row.commit_sha),
    message: str(row.message).split("\n")[0].slice(0, 160),
    author: row.author ? str(row.author) : null,
    prNumber: row.pr_number ? str(row.pr_number) : null,
    createdAt: str(row.created_at),
    finishedAt: row.finished_at ? str(row.finished_at) : null,
    durationMins: row.duration_mins === null ? null : num(row.duration_mins),
  }));

  const now = Date.now();
  const dayMs = 86_400_000;
  // "failing" is still running with failures; it counts against the pass rate
  // but is not a finished build.
  const finished = builds.filter((build) => isFinished(build.state));
  const completed = builds.filter(
    (build) => build.state === "passed" || build.state === "failed",
  );
  const window = (from: number, to: number) =>
    finished.filter((build) => {
      const t = new Date(build.createdAt).getTime();
      return t >= from && t < to;
    });
  const rate = (set: typeof finished) =>
    set.length === 0
      ? null
      : Math.round(
          (set.filter((build) => !isFailed(build.state)).length / set.length) *
            100,
        );

  const last24h = window(now - dayMs, now + dayMs);
  const prior24h = window(now - 2 * dayMs, now - dayMs);

  const byDay = new Map<string, { total: number; passed: number }>();
  for (const build of finished) {
    const day = build.createdAt.slice(0, 10);
    const entry = byDay.get(day) ?? { total: 0, passed: 0 };
    entry.total += 1;
    if (!isFailed(build.state)) entry.passed += 1;
    byDay.set(day, entry);
  }
  const dailyPassRate = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, d]) => Math.round((d.passed / d.total) * 100));

  return {
    passRate24h: rate(last24h),
    passRatePrior24h: rate(prior24h),
    builds24h: last24h.length,
    failed24h: last24h.filter((build) => isFailed(build.state)).length,
    dailyPassRate,
    latest: builds[0] ?? null,
    latestFinished: completed[0] ?? null,
    recent: builds.slice(0, RECENT_BUILDS),
  };
}

/* -------------------------------------------------------------- alerts */

async function loadAlerts(): Promise<OverviewAlerts> {
  const db = getDb();
  const rows = await db<MainCiJobAlertRow[]>`
    SELECT a.alert_id, a.job_key, a.job_name, a.status, a.opened_at,
           a.first_failure_job_id, a.first_failure_state,
           a.first_failure_build_id, a.first_failure_build_number,
           a.first_failure_build_url, a.first_failure_job_url,
           a.first_failure_commit_sha,
           a.last_failed_at, a.last_failure_job_id, a.last_failure_state,
           a.last_failure_build_id, a.last_failure_build_number,
           a.last_failure_build_url, a.last_failure_job_url,
           a.last_failure_commit_sha, a.failure_count,
           a.resolved_at, a.resolution_job_id, a.resolution_build_id,
           a.resolution_build_number, a.resolution_build_url,
           a.resolution_job_url, a.resolution_commit_sha, a.resolution_kind,
           an.analyzed_failure_job_id AS analysis_analyzed_failure_job_id,
           an.classification AS analysis_classification,
           an.confidence AS analysis_confidence,
           an.summary AS analysis_summary,
           an.evidence_urls AS analysis_evidence_urls,
           an.recommended_action AS analysis_recommended_action,
           an.suspected_fix_prs AS analysis_suspected_fix_prs,
           an.model_version AS analysis_model_version,
           an.analyzed_at AS analysis_analyzed_at
    FROM alerting_main_ci_job_alerts AS a
    LEFT JOIN alerting_main_ci_job_analysis AS an
      ON an.alert_id = a.alert_id
    WHERE a.status = 'open'
    ORDER BY a.last_failed_at DESC
  `;
  const alerts = rows.map(toMainCiJobAlert);
  const byReason: Record<MainCiAnalysisClassification | "unanalyzed", number> = {
    infra: 0,
    flaky: 0,
    code: 0,
    test: 0,
    unknown: 0,
    unanalyzed: 0,
  };
  for (const alert of alerts) {
    byReason[alert.analysis?.classification ?? "unanalyzed"] += 1;
  }
  return {
    open: alerts.length,
    byReason,
    top: alerts.slice(0, TOP_ALERTS).map((alert) => ({
      alertId: alert.alertId,
      jobName: alert.jobName,
      classification: alert.analysis?.classification ?? null,
      confidence: alert.analysis?.confidence ?? null,
      failureCount: alert.failureCount,
      openedAt: alert.openedAt,
      lastFailedAt: alert.lastFailure.finishedAt,
      jobUrl: alert.lastFailure.jobUrl,
    })),
  };
}

/* ------------------------------------------------------- fast failures */

async function loadFastFailures(): Promise<OverviewFastFailures> {
  const db = getDb();
  const [row] = await db<
    { events: number; jobs: number; builds: number }[]
  >`
    SELECT COUNT(*)::int AS events,
           COUNT(DISTINCT job_name)::int AS jobs,
           COUNT(DISTINCT build_url)::int AS builds
    FROM alerting_fast_failure_events
    WHERE finished_at >= NOW() - INTERVAL '24 hours'
      AND soft_failed = false
  `;
  return {
    events24h: row?.events ?? 0,
    jobs24h: row?.jobs ?? 0,
    builds24h: row?.builds ?? 0,
  };
}

/* -------------------------------------------------------------- queues */

async function loadQueues(): Promise<OverviewQueues> {
  const db = getDb();
  const cutoff = new Date(Date.now() - 2 * 3600 * 1000);
  const rows = await db<
    {
      queue: string;
      polled_at: Date;
      agents_busy: number;
      agents_total: number;
      jobs_running: number;
      jobs_scheduled: number;
      jobs_waiting: number;
      p50_wait_secs: number | null;
    }[]
  >`
    SELECT DISTINCT ON (queue) queue, polled_at,
      agents_busy, agents_total, jobs_running, jobs_scheduled, jobs_waiting, p50_wait_secs
    FROM queue_snapshots
    WHERE polled_at >= ${cutoff}
    ORDER BY queue, polled_at DESC
  `;
  const queues = rows.map((row) => ({
    queue: row.queue,
    // Buildkite reports queued command jobs as "scheduled"; "waiting" is the
    // dependency-blocked state. Both are jobs an agent has not picked up.
    waiting: num(row.jobs_scheduled) + num(row.jobs_waiting),
    running: num(row.jobs_running),
    agents: num(row.agents_total),
    busy: num(row.agents_busy),
    p50WaitSecs: row.p50_wait_secs === null ? null : num(row.p50_wait_secs),
  }));
  const hot = [...queues]
    .filter((queue) => queue.waiting > 0)
    .sort((a, b) => b.waiting - a.waiting || b.busy - a.busy)
    .slice(0, HOT_QUEUES);
  return {
    totalAgents: queues.reduce((sum, queue) => sum + queue.agents, 0),
    busyAgents: queues.reduce((sum, queue) => sum + queue.busy, 0),
    waitingJobs: queues.reduce((sum, queue) => sum + queue.waiting, 0),
    queuesWithBacklog: queues.filter((queue) => queue.waiting > 0).length,
    polledAt: rows[0]?.polled_at ? rows[0].polled_at.toISOString() : null,
    hot,
  };
}

/* ----------------------------------------------------------------- gpu */

async function loadGpu(): Promise<OverviewGpu> {
  const latest = await queryGpuLatest();
  const byHost = new Map<
    string,
    { gpuType: string | null; gpus: number; util: number; used: number; total: number; reportedAt: string }
  >();
  for (const gpu of latest) {
    const host = byHost.get(gpu.hostname) ?? {
      gpuType: gpu.gpu_name,
      gpus: 0,
      util: 0,
      used: 0,
      total: 0,
      reportedAt: gpu.reported_at,
    };
    host.gpus += 1;
    host.util += gpu.gpu_util;
    host.used += gpu.mem_used_mb;
    host.total += gpu.mem_total_mb;
    if (gpu.reported_at > host.reportedAt) host.reportedAt = gpu.reported_at;
    byHost.set(gpu.hostname, host);
  }
  const hosts = [...byHost.entries()].map(([hostname, host]) => ({
    hostname,
    gpuType: host.gpuType,
    gpus: host.gpus,
    utilPct: host.gpus > 0 ? Math.round(host.util / host.gpus) : 0,
    memPct: host.total > 0 ? Math.round((host.used / host.total) * 100) : 0,
    reportedAt: host.reportedAt,
  }));
  const totalMem = latest.reduce((sum, gpu) => sum + gpu.mem_total_mb, 0);
  const usedMem = latest.reduce((sum, gpu) => sum + gpu.mem_used_mb, 0);
  return {
    hosts: hosts.length,
    gpus: latest.length,
    avgUtilPct:
      latest.length > 0
        ? Math.round(
            latest.reduce((sum, gpu) => sum + gpu.gpu_util, 0) / latest.length,
          )
        : 0,
    memPct: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
    busiest: [...hosts]
      .sort((a, b) => b.memPct - a.memPct || b.utilPct - a.utilPct)
      .slice(0, BUSIEST_HOSTS),
  };
}

/* --------------------------------------------------------------- route */

async function settle<T>(
  promise: Promise<T>,
): Promise<{ data: T; error?: undefined } | { data: null; error: string }> {
  try {
    return { data: await promise };
  } catch (error) {
    console.error("Overview source failed:", error);
    return { data: null, error: errorMessage(error) };
  }
}

export async function GET() {
  const cacheKey = "overview:v2";
  const cached = getCached<OverviewResponse>(cacheKey);
  if (cached) return cachedJson(cached, CDN_CACHE);

  const [main, alerts, fastFailures, queues, gpu] = await Promise.all([
    settle(loadMain()),
    settle(loadAlerts()),
    settle(loadFastFailures()),
    settle(loadQueues()),
    settle(loadGpu()),
  ]);

  const result: OverviewResponse = {
    generatedAt: new Date().toISOString(),
    main: main.data,
    alerts: alerts.data,
    fastFailures: fastFailures.data,
    queues: queues.data,
    gpu: gpu.data,
    errors: Object.fromEntries(
      (
        [
          ["main", main.error],
          ["alerts", alerts.error],
          ["fastFailures", fastFailures.error],
          ["queues", queues.error],
          ["gpu", gpu.error],
        ] as const
      ).flatMap(([source, error]) =>
        error ? [[source, error] as [string, string]] : [],
      ),
    ),
  };

  const allFailed = [main, alerts, fastFailures, queues, gpu].every(
    (source) => source.data === null,
  );
  if (allFailed) {
    return NextResponse.json(result, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  setCache(cacheKey, result, TTL);
  return cachedJson(result, CDN_CACHE);
}
