import { NextResponse } from "next/server";
import { GET as readMainCiAlerts } from "@/app/api/alerts/main-ci/route";
import type { MainCiJobAlert } from "@/lib/alerts-main-ci";
import type { MainCiSolutionReconciliationSummary } from "@/lib/main-ci-solution-reconciliation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Hourly guardrail for ownership drift. The normal alerts read path performs
 * the authoritative GitHub and failure-signature checks; this cron makes that
 * audit run even when nobody has the page open and emits a compact log record.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }

  const response = await readMainCiAlerts();
  const payload = (await response.json()) as {
    alerts?: MainCiJobAlert[];
    schemaStatus?: "ready" | "pending";
    solutionReconciliation?: MainCiSolutionReconciliationSummary;
    error?: string;
  };
  if (!response.ok) {
    return NextResponse.json(
      { error: payload.error ?? "Main CI alert reconciliation failed." },
      { status: response.status, headers: NO_STORE },
    );
  }
  if (
    payload.schemaStatus !== "ready" ||
    !payload.alerts ||
    !payload.solutionReconciliation
  ) {
    return NextResponse.json(
      { error: "Main CI solution schema is not deployed yet." },
      { status: 503, headers: NO_STORE },
    );
  }

  const issues = payload.alerts
    .filter(
      (alert) =>
        alert.status === "open" && alert.solutionCoverage.issues.length > 0,
    )
    .map((alert) => ({
      alertId: alert.alertId,
      jobKey: alert.jobKey,
      jobName: alert.jobName,
      failureJobId: alert.lastFailure.buildkiteJobId,
      issues: alert.solutionCoverage.issues,
    }));
  const result = {
    ok: true,
    ...payload.solutionReconciliation,
    issues,
  };
  if (issues.length > 0) {
    console.warn("Main CI solution reconciliation found ownership gaps", result);
  } else {
    console.info("Main CI solution reconciliation found no ownership gaps", result);
  }
  return NextResponse.json(result, { headers: NO_STORE });
}
