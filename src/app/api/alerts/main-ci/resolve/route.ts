import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { bearerTokenMatches } from "@/lib/operator-auth";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";

export const dynamic = "force-dynamic";

/**
 * Manually resolves one open Main CI alert. The episode invariant on
 * alerting_main_ci_job_alerts requires resolution job fields on every resolved
 * row, so a manual close points them at the alert's own last failure and sets
 * resolution_kind = 'manual' to record that no passing job was observed.
 *
 * The dashboard is public, so this mutating endpoint requires the
 * ALERT_OPERATOR_TOKEN bearer credential: 503 when it is not configured, 401
 * when the supplied token is missing or wrong.
 */
export async function POST(request: Request) {
  const operatorToken = process.env.ALERT_OPERATOR_TOKEN;
  if (!operatorToken) {
    return NextResponse.json(
      { error: "Manual alert resolution is not configured on this dashboard." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!bearerTokenMatches(request.headers.get("authorization"), operatorToken)) {
    return NextResponse.json(
      { error: "Resolving an alert requires the configured operator token." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const alertId = Number((body as { alertId?: unknown })?.alertId);
  if (!Number.isInteger(alertId) || alertId <= 0) {
    return NextResponse.json(
      { error: "alertId must be a positive integer." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const db = getDb();
    const rows = await db<{ alert_id: number }[]>`
      UPDATE alerting_main_ci_job_alerts
      SET status = 'resolved',
          resolved_at = now(),
          resolution_job_id = last_failure_job_id,
          resolution_build_id = last_failure_build_id,
          resolution_build_number = last_failure_build_number,
          resolution_build_url = last_failure_build_url,
          resolution_job_url = last_failure_job_url,
          resolution_commit_sha = last_failure_commit_sha,
          resolution_kind = 'manual',
          updated_at = now()
      WHERE alert_id = ${alertId} AND status = 'open'
      RETURNING alert_id
    `;
    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Alert is not open or does not exist." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Same ordered-rollout posture as the GET route: a preview deployment can
    // exist before the alerting tables do.
    if (hasPostgresErrorCode(error, "42P01")) {
      return NextResponse.json(
        { error: "Main CI alerts schema is not deployed yet." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("Failed to resolve Main CI job alert:", error);
    return NextResponse.json(
      { error: "Main CI job alert could not be resolved." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
