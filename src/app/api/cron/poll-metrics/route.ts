import { NextRequest, NextResponse } from "next/server";
import { getDb, initSchema } from "@/lib/db";
import { fetchAgentMetrics } from "@/lib/buildkite-metrics";
import { queryDatabricks } from "@/lib/databricks";

export const maxDuration = 55;

let schemaInitialized = false;

interface WaitTimeRow {
  queue: string;
  p50_wait_secs: string;
  p90_wait_secs: string;
  p95_wait_secs: string;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const token = process.env.BUILDKITE_AGENT_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "BUILDKITE_AGENT_TOKEN not configured" },
      { status: 500 },
    );
  }

  try {
    const db = getDb();

    if (!schemaInitialized) {
      await initSchema();
      schemaInitialized = true;
    }

    // Fetch agent/job counts and wait time percentiles in parallel
    const [metrics, waitTimeRows] = await Promise.all([
      fetchAgentMetrics(token),
      queryDatabricks<WaitTimeRow>(`
        SELECT
          queue,
          ROUND(PERCENTILE(wait_seconds, 0.5)) AS p50_wait_secs,
          ROUND(PERCENTILE(wait_seconds, 0.9)) AS p90_wait_secs,
          ROUND(PERCENTILE(wait_seconds, 0.95)) AS p95_wait_secs
        FROM (
          SELECT
            SUBSTRING(r.rule, 7) AS queue,
            TIMESTAMPDIFF(SECOND, j.runnable_at, current_timestamp()) AS wait_seconds
          FROM vllm_data_warehouse.buildkite.build_job AS j
          INNER JOIN vllm_data_warehouse.buildkite.build_job_agent_query_rule AS r
            ON j.id = r.build_job_id
          WHERE j._fivetran_deleted = false
            AND j.type = 'script'
            AND j.runnable_at IS NOT NULL
            AND j.started_at IS NULL
            AND j.state = 'scheduled'
            AND r.rule LIKE 'queue=%'
            AND j.runnable_at >= current_timestamp() - INTERVAL 24 HOUR
        ) sub
        GROUP BY queue
      `).catch((err) => {
        console.error("Databricks wait time query failed (non-fatal):", err);
        return [] as WaitTimeRow[];
      }),
    ]);

    const now = new Date();

    // Build wait time lookup by queue
    const waitTimeMap = new Map<string, WaitTimeRow>();
    for (const row of waitTimeRows) {
      waitTimeMap.set(row.queue, row);
    }

    const agentQueues = metrics.agents.queues ?? {};
    const jobQueues = metrics.jobs.queues ?? {};
    const allQueues = new Set([
      ...Object.keys(agentQueues),
      ...Object.keys(jobQueues),
      ...waitTimeMap.keys(),
    ]);

    let stored = 0;
    for (const queue of allQueues) {
      const agents = agentQueues[queue] ?? { idle: 0, busy: 0, total: 0 };
      const jobs = jobQueues[queue] ?? {
        scheduled: 0,
        running: 0,
        waiting: 0,
        total: 0,
      };
      const waiting = jobs.waiting;
      // Use Databricks wait times if Agent Metrics API shows jobs scheduled or waiting
      const wt = jobs.scheduled + waiting > 0 ? waitTimeMap.get(queue) : undefined;

      await db`
        INSERT INTO queue_snapshots (
          polled_at, queue,
          agents_idle, agents_busy, agents_total,
          jobs_scheduled, jobs_running, jobs_waiting, jobs_total,
          p50_wait_secs, p90_wait_secs, p95_wait_secs
        ) VALUES (
          ${now}, ${queue},
          ${agents.idle}, ${agents.busy}, ${agents.total},
          ${jobs.scheduled}, ${jobs.running}, ${waiting}, ${jobs.total},
          ${wt ? parseFloat(wt.p50_wait_secs) : null},
          ${wt ? parseFloat(wt.p90_wait_secs) : null},
          ${wt ? parseFloat(wt.p95_wait_secs) : null}
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
      waitTimeQueues: waitTimeRows.length,
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
