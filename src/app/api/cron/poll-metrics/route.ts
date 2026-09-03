import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { fetchBuildkiteQueueSnapshots } from "@/lib/buildkite-queue-metrics";

export const maxDuration = 55;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const token = process.env.BUILDKITE_API_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "BUILDKITE_API_TOKEN not configured" },
      { status: 500 },
    );
  }

  try {
    const db = getDb();

    const now = new Date();
    const snapshots = await fetchBuildkiteQueueSnapshots(
      token,
      process.env.BUILDKITE_ORGANIZATION || "vllm",
      now,
    );

    let stored = 0;
    for (const snapshot of snapshots) {
      const busyAgents = Math.min(snapshot.connectedAgents, snapshot.runningJobs);
      const idleAgents = Math.max(0, snapshot.connectedAgents - busyAgents);
      const hasWaitSamples = snapshot.waitingJobs > 0 && snapshot.sampleSize > 0;

      await db`
        INSERT INTO queue_snapshots (
          polled_at, queue,
          agents_idle, agents_busy, agents_total,
          jobs_scheduled, jobs_running, jobs_waiting, jobs_total,
          p50_wait_secs, p90_wait_secs, p95_wait_secs, p99_wait_secs
        ) VALUES (
          ${now}, ${snapshot.queue},
          ${idleAgents}, ${busyAgents}, ${snapshot.connectedAgents},
          ${snapshot.waitingJobs}, ${snapshot.runningJobs}, 0,
          ${snapshot.waitingJobs + snapshot.runningJobs},
          ${hasWaitSamples ? snapshot.p50 : null},
          ${hasWaitSamples ? snapshot.p90 : null},
          ${hasWaitSamples ? snapshot.p95 : null},
          ${hasWaitSamples ? snapshot.p99 : null}
        )
      `;
      stored++;
    }

    // Cleanup old data (keep 30 days)
    await db`
      DELETE FROM queue_snapshots
      WHERE polled_at < NOW() - INTERVAL '30 days'
    `;
    await db`
      DELETE FROM gpu_snapshots
      WHERE reported_at < NOW() - INTERVAL '30 days'
    `;

    return NextResponse.json({
      ok: true,
      queues: stored,
      waitTimeQueues: snapshots.filter((snapshot) => snapshot.sampleSize > 0).length,
      polled_at: now.toISOString(),
    });
  } catch (error) {
    console.error("Poll metrics failed:", error);
    return NextResponse.json(
      { error: "Failed to poll metrics" },
      { status: 500 },
    );
  }
}
