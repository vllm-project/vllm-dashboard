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
      SELECT alert_id, job_key, job_name, status, opened_at,
             first_failure_job_id, first_failure_state,
             first_failure_build_id, first_failure_build_number,
             first_failure_build_url, first_failure_job_url,
             first_failure_commit_sha,
             last_failed_at, last_failure_job_id, last_failure_state,
             last_failure_build_id, last_failure_build_number,
             last_failure_build_url, last_failure_job_url,
             last_failure_commit_sha, failure_count,
             resolved_at, resolution_job_id, resolution_build_id,
             resolution_build_number, resolution_build_url,
             resolution_job_url, resolution_commit_sha
      FROM alerting_main_ci_job_alerts
      WHERE status = 'open' OR resolved_at >= now() - interval '30 days'
      ORDER BY (status = 'open') DESC,
               COALESCE(resolved_at, last_failed_at) DESC
      LIMIT ${MAX_ALERTS}
    `;
    return NextResponse.json(
      { alerts: rows.map(toMainCiJobAlert), schemaStatus: "ready" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Preview deployments are created before migration 0014 is intentionally
    // applied to the shared database. Treat that ordered rollout state as a
    // neutral, explicit response instead of presenting a broken dashboard.
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
