import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const maxDuration = 55;

// Raw-snapshot retention, decoupled from the Buildkite queue-poll cron so a
// queue-poll failure can never stop cleanup. Raw rows (including the
// per-agent Buildkite samples) are kept for 30 days; the 5-minute rollups
// (gpu_history_5m, host_history_5m) are kept forever as a deliberate choice —
// they are the long-range history source.
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

    return NextResponse.json({
      ok: true,
      gpuSnapshotsDeleted: gpuDeleted.count,
      hostSnapshotsDeleted: hostDeleted.count,
      agentSnapshotsDeleted: agentDeleted.count,
    });
  } catch (error) {
    console.error("Retention failed:", error);
    return NextResponse.json(
      { error: "Failed to run retention" },
      { status: 500 },
    );
  }
}
