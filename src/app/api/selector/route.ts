import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";
import type {
  DecisionCountRow,
  DecisionsInUse,
  DecisionTimingRow,
  FullRunRecord,
  RunComponentRecord,
  SelectorAlertEpisode,
  SelectorHealthResponse,
} from "@/lib/selector-health";

export const dynamic = "force-dynamic";

// The page shows two weeks of full runs and PR decisions; the worker keeps
// 30 days. PR decisions "in use" are read over the same six hours the
// pr_stale condition checks.
const WINDOW_DAYS = 14;
const IN_USE_HOURS = 6;
const MAX_EPISODES = 200;

interface RunRow {
  build_number: number;
  kind: FullRunRecord["kind"];
  created_at: Date;
  commit_sha: string;
  build_state: string;
  settled: boolean;
  components: Array<{
    component: RunComponentRecord["component"];
    status: RunComponentRecord["status"];
    job_state: string | null;
    soft_failed: boolean;
    expected_jobs: number | null;
    delivered_jobs: number | null;
    row_count: number | null;
    verdict: string | null;
    published: boolean;
    published_commit: string | null;
    source: string;
  }> | null;
}

interface EpisodeRow {
  alert_id: number | string;
  condition: SelectorAlertEpisode["condition"];
  subject_key: string;
  status: SelectorAlertEpisode["status"];
  opened_at: Date;
  resolved_at: Date | null;
  details: Record<string, unknown>;
}

function toRun(row: RunRow): FullRunRecord {
  return {
    buildNumber: row.build_number,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
    commitSha: row.commit_sha,
    buildState: row.build_state,
    settled: row.settled,
    components: (row.components ?? []).map((item) => ({
      component: item.component,
      status: item.status,
      jobState: item.job_state,
      softFailed: item.soft_failed,
      expectedJobs: item.expected_jobs,
      deliveredJobs: item.delivered_jobs,
      rows: item.row_count,
      verdict: item.verdict,
      published: item.published,
      publishedCommit: item.published_commit,
      source: item.source,
    })),
  };
}

/**
 * CI selector recording health, read-only from the records the alerting
 * worker's selector-health slice writes (migration 0036).
 */
export async function GET() {
  try {
    const db = getDb();
    const window = `${WINDOW_DAYS} days`;
    const [runs, counts, timings, inUse, episodes] = await Promise.all([
      db<RunRow[]>`
        SELECT r.build_number, r.kind, r.created_at, r.commit_sha,
               r.build_state, r.settled,
               (SELECT json_agg(c ORDER BY c.component)
                FROM alerting_selector_run_components c
                WHERE c.build_number = r.build_number) AS components
        FROM alerting_selector_full_runs r
        WHERE r.created_at >= now() - ${window}::interval
        ORDER BY r.created_at DESC, r.build_number DESC
      `,
      db<Array<{ day: Date; outcome: DecisionCountRow["outcome"]; reason: string | null; builds: number }>>`
        SELECT date_trunc('day', created_at) AS day, outcome, reason,
               count(*)::int AS builds
        FROM alerting_selector_decisions
        WHERE created_at >= now() - ${window}::interval AND branch <> 'main'
        GROUP BY 1, 2, 3
      `,
      db<Array<{ day: Date; p50: number | null; p95: number | null; commits: string[] | null }>>`
        SELECT date_trunc('day', created_at) AS day,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds) AS p95,
               array_agg(DISTINCT ci_infra_commit)
                 FILTER (WHERE ci_infra_commit IS NOT NULL) AS commits
        FROM alerting_selector_decisions
        WHERE created_at >= now() - ${window}::interval AND branch <> 'main'
        GROUP BY 1
      `,
      db<Array<{ decisions: number; fnrec: number | null; kernrec: number | null; latest: Date | null }>>`
        SELECT count(*)::int AS decisions,
               percentile_disc(0.5) WITHIN GROUP (ORDER BY fnrec_build) AS fnrec,
               percentile_disc(0.5) WITHIN GROUP (ORDER BY kernrec_build) AS kernrec,
               max(created_at) AS latest
        FROM alerting_selector_decisions
        WHERE created_at >= now() - ${`${IN_USE_HOURS} hours`}::interval
          AND branch <> 'main'
          AND (fnrec_build IS NOT NULL OR kernrec_build IS NOT NULL)
      `,
      db<EpisodeRow[]>`
        SELECT alert_id, condition, subject_key, status, opened_at,
               resolved_at, details
        FROM alerting_selector_alerts
        WHERE status = 'open' OR resolved_at >= now() - ${window}::interval
        ORDER BY (status = 'open') DESC, COALESCE(resolved_at, opened_at) DESC
        LIMIT ${MAX_EPISODES}
      `,
    ]);

    const used = inUse[0];
    const result: SelectorHealthResponse = {
      schemaStatus: "ready",
      windowDays: WINDOW_DAYS,
      runs: runs.map(toRun),
      decisionCounts: counts.map((row) => ({
        day: row.day.toISOString().slice(0, 10),
        outcome: row.outcome,
        reason: row.reason,
        builds: row.builds,
      })),
      decisionTimings: timings.map((row): DecisionTimingRow => ({
        day: row.day.toISOString().slice(0, 10),
        p50Seconds: row.p50 === null ? null : Number(row.p50),
        p95Seconds: row.p95 === null ? null : Number(row.p95),
        ciInfraCommits: row.commits ?? [],
      })),
      inUse:
        used && used.decisions > 0
          ? ({
              windowHours: IN_USE_HOURS,
              decisions: used.decisions,
              fnrecBuild: used.fnrec === null ? null : Number(used.fnrec),
              kernrecBuild: used.kernrec === null ? null : Number(used.kernrec),
              latestAt: used.latest?.toISOString() ?? null,
            } satisfies DecisionsInUse)
          : null,
      episodes: episodes.map((row) => ({
        alertId: String(row.alert_id),
        condition: row.condition,
        subjectKey: row.subject_key,
        status: row.status,
        openedAt: row.opened_at.toISOString(),
        resolvedAt: row.resolved_at?.toISOString() ?? null,
        details: row.details,
      })),
      generatedAt: new Date().toISOString(),
    };
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
    });
  } catch (error) {
    // Preview deployments can run before migration 0036 is applied to the
    // shared database: say so instead of showing a broken page.
    if (hasPostgresErrorCode(error, "42P01")) {
      return NextResponse.json(
        { schemaStatus: "pending" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("Failed to load CI selector health:", error);
    return NextResponse.json(
      { error: "CI selector health could not be loaded." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
