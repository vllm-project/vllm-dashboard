import { getDb } from "./db";
import { AgentApiError, integer } from "./agent-buildkite";

export async function agentFailures(params: URLSearchParams) {
  const status = params.get("status") || "open";
  if (!["open", "resolved", "all"].includes(status)) throw new AgentApiError("status must be open, resolved, or all");
  const limit = integer(params, "limit", 20, 100, 1);
  const offset = integer(params, "offset", 0, 100000);
  const db = getDb();
  const rows = await db`
    SELECT a.alert_id AS "alertId", a.job_name AS "jobName", a.status,
      a.last_failed_at AS "lastFailedAt", a.failure_count AS "failureCount",
      a.last_failure_build_number AS "buildNumber", a.last_failure_job_id AS "jobId",
      a.last_failure_job_url AS "jobUrl", a.last_failure_commit_sha AS commit,
      a.resolved_at AS "resolvedAt", a.resolution_kind AS "resolutionKind",
      an.classification, an.confidence, LEFT(an.summary, 1000) AS analysis,
      an.analyzed_at AS "analyzedAt",
      CASE WHEN an.analyzed_failure_job_id IS NULL THEN NULL
        ELSE an.analyzed_failure_job_id <> a.last_failure_job_id END AS "analysisStale"
    FROM alerting_main_ci_job_alerts a
    LEFT JOIN alerting_main_ci_job_analysis an ON an.alert_id = a.alert_id
    WHERE (${status} = 'all' OR a.status = ${status})
      AND (a.status = 'open' OR a.resolved_at >= now() - interval '30 days')
    ORDER BY a.last_failed_at DESC, a.alert_id DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `;
  return { alerts: rows.slice(0, limit), offset, nextOffset: rows.length > limit ? offset + limit : null,
    scope: "vllm main-CI failure episodes; resolved episodes retained here for 30 days",
    observedAt: null, freshness: "polling delay unknown; lastFailedAt is the failure time, not a successful poll heartbeat" };
}

export function queueFreshness(polledAt: Date | string, now = Date.now()) {
  const ageSeconds = Math.max(0, Math.floor((now - new Date(polledAt).getTime()) / 1000));
  return { ageSeconds, stale: ageSeconds > 600 };
}

export async function agentQueues(params: URLSearchParams) {
  const queue = params.get("queue") || null;
  if (queue && queue.length > 255) throw new AgentApiError("queue is too long");
  const db = getDb();
  const rows = await db`
    SELECT DISTINCT ON (queue) queue, polled_at AS "observedAt",
      agents_idle AS "agentsIdle", agents_busy AS "agentsBusy", agents_total AS "agentsTotal",
      jobs_scheduled AS "jobsScheduled", jobs_running AS "jobsRunning", jobs_waiting AS "jobsWaiting",
      p50_wait_secs AS "p50WaitSeconds", p90_wait_secs AS "p90WaitSeconds",
      p95_wait_secs AS "p95WaitSeconds", (to_jsonb(queue_snapshots)->>'p99_wait_secs')::real AS "p99WaitSeconds"
    FROM queue_snapshots
    WHERE polled_at >= now() - interval '2 hours' AND (${queue}::text IS NULL OR queue = ${queue})
    ORDER BY queue, polled_at DESC
  `;
  return { queues: rows.map(row => ({ ...row, ...queueFreshness(row.observedAt) })),
    available: rows.length > 0, pollingIntervalSeconds: 300,
    missingData: "Queues with no snapshot in the last two hours are omitted; an empty result does not mean zero demand" };
}
