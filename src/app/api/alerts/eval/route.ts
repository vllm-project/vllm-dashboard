import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";
import type { EvalRegressionAlert, EvalRegressionSnapshot } from "@/lib/eval-alert-types";

export const dynamic = "force-dynamic";

const MAX_ALERTS = 200;
const MAX_SNAPSHOTS = 20;

export async function GET() {
  try {
    const db = getDb();

    const [alerts, snapshots, heartbeat] = await Promise.all([
      db<EvalRegressionAlert[]>`
        SELECT alert_id, model, task, n_shot, metric, filter,
               higher_is_better, unit, status,
               baseline_image, baseline_value,
               candidate_image, candidate_value,
               delta, delta_pct, significance,
               opened_at, resolved_at
        FROM alerting_eval_regression_alerts
        WHERE status = 'open'
           OR resolved_at >= now() - interval '30 days'
        ORDER BY (status = 'open') DESC,
                 COALESCE(resolved_at, opened_at) DESC
        LIMIT ${MAX_ALERTS}
      `,
      db<EvalRegressionSnapshot[]>`
        SELECT snapshot_id, baseline_image, candidate_image,
               status, summary, compare_url, checked_at
        FROM alerting_eval_regression_snapshots
        ORDER BY checked_at DESC
        LIMIT ${MAX_SNAPSHOTS}
      `,
      db`
        SELECT last_checked_at FROM alerting_eval_last_notified
        WHERE id = 1
      `,
    ]);

    const lastCheckedAt: string | null =
      heartbeat.length > 0 ? (heartbeat[0].last_checked_at as string) : null;

    return NextResponse.json(
      { alerts, snapshots, lastCheckedAt, schemaStatus: "ready" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (hasPostgresErrorCode(error, "42P01")) {
      return NextResponse.json(
        { alerts: [], snapshots: [], schemaStatus: "pending" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("Failed to load eval regression alerts:", error);
    return NextResponse.json(
      { error: "Eval regression alerts could not be loaded." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
