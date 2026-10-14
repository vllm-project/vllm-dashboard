import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";

export const maxDuration = 55;

// Raw-snapshot retention, decoupled from the Buildkite queue-poll cron so a
// queue-poll failure can never stop cleanup. Raw rows (including the
// per-agent Buildkite samples) are kept for 30 days; the 5-minute rollups
// (gpu_history_5m, host_history_5m) are kept forever as a deliberate choice —
// they are the long-range history source.
// One-second job GPU samples are kept for 7 days; command/test spans remain.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const db = getDb();

    const jobGpuDeleted = await db`
      DELETE FROM otel_spans
      WHERE span_name = 'ci.gpu.samples'
        AND end_time < NOW() - INTERVAL '7 days'
    `;

    const gpuDeleted = await db`
      DELETE FROM gpu_snapshots
      WHERE reported_at < NOW() - INTERVAL '30 days'
    `;
    const hostDeleted = await db`
      DELETE FROM host_snapshots
      WHERE reported_at < NOW() - INTERVAL '30 days'
    `;
    const agentDeleted = await db`
      DELETE FROM buildkite_agent_snapshots
      WHERE polled_at < NOW() - INTERVAL '30 days'
    `;
    let evalSnapshotsDeleted: { count: number } = { count: 0 };
    try {
      evalSnapshotsDeleted = await db`
        DELETE FROM alerting_eval_regression_snapshots
        WHERE checked_at < NOW() - INTERVAL '30 days'
      `;
    } catch (error) {
      if (!hasPostgresErrorCode(error, "42P01")) throw error;
      // Table not migrated yet — skip silently.
    }

    return NextResponse.json({
      ok: true,
      jobGpuSampleBatchesDeleted: jobGpuDeleted.count,
      gpuSnapshotsDeleted: gpuDeleted.count,
      hostSnapshotsDeleted: hostDeleted.count,
      agentSnapshotsDeleted: agentDeleted.count,
      evalSnapshotsDeleted: evalSnapshotsDeleted.count,
    });
  } catch (error) {
    console.error("Retention failed:", error);
    return NextResponse.json(
      { error: "Failed to run retention" },
      { status: 500 },
    );
  }
}
