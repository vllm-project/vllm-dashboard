import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  toMainCiJobAlert,
  type MainCiJobAlertRow,
} from "@/lib/alerts-main-ci";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";
import { verifyMainCiFixOwnership } from "@/lib/main-ci-fix-ownership";
import {
  reconcileMainCiSolutions,
  summarizeMainCiSolutionReconciliation,
} from "@/lib/main-ci-solution-reconciliation";

export const dynamic = "force-dynamic";

const MAX_ALERTS = 500;
const MAX_UPDATES_PER_ALERT = 50;

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
             an.failure_signature AS analysis_failure_signature,
             an.classification AS analysis_classification,
             an.confidence AS analysis_confidence,
             an.summary AS analysis_summary,
             an.evidence_urls AS analysis_evidence_urls,
             an.recommended_action AS analysis_recommended_action,
             an.suspected_fix_prs AS analysis_suspected_fix_prs,
             an.model_version AS analysis_model_version,
             an.analyzed_at AS analysis_analyzed_at,
             COALESCE((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'updateId', u.update_id::text,
                   'failureJobId', u.failure_job_id,
                   'failureSignature', u.failure_signature,
                   'kind', u.kind,
                   'message', u.message,
                   'fixPrs', u.fix_prs,
                   'solution', CASE
                     WHEN u.solution_kind IS NULL THEN NULL
                     ELSE jsonb_build_object(
                       'kind', u.solution_kind,
                       'owner', u.solution_owner,
                       'action', u.solution_action
                     )
                   END,
                   'author', u.author,
                   'createdAt', u.created_at
                 ) ORDER BY u.created_at DESC, u.update_id DESC
               )
               FROM (
                 SELECT candidate.update_id, candidate.failure_job_id,
                        candidate.failure_signature, candidate.kind,
                        candidate.message, candidate.fix_prs,
                        candidate.solution_kind, candidate.solution_owner,
                        candidate.solution_action, candidate.author,
                        candidate.created_at
                 FROM alerting_main_ci_job_updates AS candidate
                 JOIN alerting_main_ci_job_alerts AS source_alert
                   ON source_alert.alert_id = candidate.alert_id
                 WHERE candidate.alert_id = a.alert_id
                    OR (
                      an.analyzed_failure_job_id = a.last_failure_job_id
                      AND an.failure_signature IS NOT NULL
                      AND source_alert.job_key = a.job_key
                      AND candidate.failure_signature = an.failure_signature
                      AND jsonb_array_length(candidate.fix_prs) > 0
                    )
                 ORDER BY (candidate.alert_id = a.alert_id) DESC,
                          candidate.created_at DESC, candidate.update_id DESC
                 LIMIT ${MAX_UPDATES_PER_ALERT}
               ) AS u
             ), '[]'::jsonb) AS agent_updates
      FROM alerting_main_ci_job_alerts AS a
      LEFT JOIN alerting_main_ci_job_analysis AS an
        ON an.alert_id = a.alert_id
      WHERE a.status = 'open' OR a.resolved_at >= now() - interval '30 days'
      ORDER BY (a.status = 'open') DESC,
               COALESCE(a.resolved_at, a.last_failed_at) DESC
      LIMIT ${MAX_ALERTS}
    `;
    const alerts = reconcileMainCiSolutions(
      await verifyMainCiFixOwnership(rows.map(toMainCiJobAlert)),
    );
    return NextResponse.json(
      {
        alerts,
        solutionReconciliation:
          summarizeMainCiSolutionReconciliation(alerts),
        schemaStatus: "ready",
        resolutionEnabled: Boolean(process.env.ALERT_OPERATOR_TOKEN),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Preview deployments are created before migrations 0014/0016/0022/0023/0024 are
    // intentionally applied to the shared database. Treat that ordered rollout
    // state as a neutral, explicit response instead of a broken dashboard.
    if (
      hasPostgresErrorCode(error, "42P01") ||
      hasPostgresErrorCode(error, "42703")
    ) {
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
