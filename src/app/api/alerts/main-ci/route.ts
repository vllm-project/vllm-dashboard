import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  toMainCiJobAlert,
  type MainCiJobAlertRow,
} from "@/lib/alerts-main-ci";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";

export const dynamic = "force-dynamic";

const MAX_ALERTS = 500;

export async function GET() {
  try {
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
      WHERE a.status = 'open' OR a.resolved_at >= now() - interval '30 days'
      ORDER BY (a.status = 'open') DESC,
               COALESCE(a.resolved_at, a.last_failed_at) DESC
      LIMIT ${MAX_ALERTS}
    `;
    return NextResponse.json(
      {
        alerts: rows.map(toMainCiJobAlert),
        schemaStatus: "ready",
        resolutionEnabled: Boolean(process.env.ALERT_OPERATOR_TOKEN),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Preview deployments are created before migrations 0014/0016 are
    // intentionally applied to the shared database. Treat that ordered rollout
    // state as a neutral, explicit response instead of a broken dashboard.
    if (hasPostgresErrorCode(error, "42P01")) {
      return NextResponse.json(
        { alerts: [], schemaStatus: "pending" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("Failed to load Main CI job alerts:", error);
    return NextResponse.json(
      { error: "Main CI job alerts could not be loaded." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
