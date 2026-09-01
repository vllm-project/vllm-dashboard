import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import type { FastFailureEvent } from "@/lib/alerts-fast-ci";
import type { NotificationStatus } from "@/lib/alerts-shared";

export const dynamic = "force-dynamic";

// Fast Failure Events are an operational feed, not an archive: a week of
// history is what an incident responder reads, and the cap keeps a burst of
// startup failures from returning an unbounded response. A daily systemd
// timer on the alerting worker prunes rows that age past the window.
const WINDOW_DAYS = 7;
const MAX_EVENTS = 500;

interface FastFailureEventRow {
  buildkite_job_id: string;
  job_name: string;
  job_url: string;
  state: string;
  soft_failed: boolean;
  duration_seconds: number;
  finished_at: Date;
  build_url: string;
  message: string;
  commit_sha: string;
  branch: string;
  author: string;
  pr_number: string | null;
  pipeline: string;
  notification_statuses: NotificationStatus[];
}

function toEvent(row: FastFailureEventRow): FastFailureEvent {
  return {
    buildkiteJobId: row.buildkite_job_id,
    jobName: row.job_name,
    jobUrl: row.job_url,
    state: row.state,
    softFailed: row.soft_failed,
    durationSeconds: row.duration_seconds,
    finishedAt: row.finished_at.toISOString(),
    buildUrl: row.build_url,
    message: row.message,
    commitSha: row.commit_sha,
    branch: row.branch,
    author: row.author,
    prNumber: row.pr_number,
    pipeline: row.pipeline,
    notificationStatuses: row.notification_statuses,
  };
}

/**
 * Recent Fast CI failure events.
 * @description Fast Failure Events from the last 7 days, newest first, max 500.
 * @tag Alerts
 * @openapi
 */
export async function GET() {
  try {
    const db = getDb();

    // Postgres alone answers this view: the events, and how far each one's
    // Slack deliveries got. No Buildkite, Databricks, or analyzer state.
    const rows = await db<FastFailureEventRow[]>`
      SELECT e.buildkite_job_id, e.job_name, e.job_url, e.state, e.soft_failed,
             e.duration_seconds, e.finished_at, e.build_url, e.message,
             e.commit_sha, e.branch, e.author, e.pr_number, e.pipeline,
             COALESCE(
               ARRAY_AGG(o.status ORDER BY o.created_at)
                 FILTER (WHERE o.status IS NOT NULL),
               ARRAY[]::text[]
             ) AS notification_statuses
      FROM alerting_fast_failure_events e
      LEFT JOIN alerting_fast_failure_notifications n
        ON n.buildkite_job_id = e.buildkite_job_id
      LEFT JOIN alerting_notification_outbox o
        ON o.delivery_id = n.delivery_id
      WHERE e.finished_at >= NOW() - ${`${WINDOW_DAYS} days`}::interval
      GROUP BY e.buildkite_job_id
      ORDER BY e.finished_at DESC
      LIMIT ${MAX_EVENTS}
    `;

    return NextResponse.json(
      { events: rows.map(toEvent), windowDays: WINDOW_DAYS },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Failed to load Fast CI alerts:", error);
    return NextResponse.json(
      { error: "Fast CI alerts could not be loaded." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
