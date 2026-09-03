import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { postMessage, updateMessage, addReaction } from "@/lib/slack";
import { effectiveWaiting } from "@/lib/queue-plugins";

export const maxDuration = 55;

const WAIT_THRESHOLD_MINUTES = 30;

interface QueueAlertEntry {
  status: "active" | "resolved";
  firstAlerted: string;
  lastP90Secs: number;
  lastJobs: number;
  resolvedAt: string | null;
}

function fmtDuration(secs: number): string {
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function fmtTime(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Los_Angeles",
  });
}

function getPacificDateKey(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

function getPacificTzAbbr(): string {
  const abbr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "short",
  })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName");
  return abbr?.value ?? "PT";
}

function buildCombinedMessage(
  queues: Record<string, QueueAlertEntry>,
  time: string,
): string {
  const entries = Object.entries(queues);
  const active = entries.filter(([, q]) => q.status === "active");
  const resolved = entries.filter(([, q]) => q.status === "resolved");

  let header: string;
  if (active.length === 0 && resolved.length > 0) {
    header = `:white_check_mark: *All Queue Alerts Resolved*`;
  } else {
    const parts: string[] = [];
    if (active.length > 0) parts.push(`${active.length} active`);
    if (resolved.length > 0) parts.push(`${resolved.length} resolved`);
    header = `:rotating_light: *Queue Wait Time Alert* — ${parts.join(", ")}`;
  }

  const lines: string[] = [header, ""];

  // Active queues sorted by P90 descending (worst first)
  active
    .sort(([, a], [, b]) => b.lastP90Secs - a.lastP90Secs)
    .forEach(([queue, info]) => {
      const p90 = fmtDuration(info.lastP90Secs);
      const jobs = info.lastJobs;
      lines.push(
        `:red_circle: \`${queue}\` — P90: *${p90}*, ${jobs} job${jobs !== 1 ? "s" : ""} waiting _(since ${info.firstAlerted})_`,
      );
    });

  // Resolved queues
  if (resolved.length > 0) {
    if (active.length > 0) lines.push("");
    resolved.forEach(([queue, info]) => {
      const lastP90 = fmtDuration(info.lastP90Secs);
      lines.push(
        `:white_check_mark: ~\`${queue}\` — was P90: ${lastP90}~ _resolved ${info.resolvedAt}_`,
      );
    });
  }

  lines.push("", `_Updated ${time} ${getPacificTzAbbr()}_`);

  return lines.join("\n");
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_CHANNEL_ID) {
    return NextResponse.json(
      { error: "SLACK_BOT_TOKEN and SLACK_CHANNEL_ID not configured" },
      { status: 500 },
    );
  }

  try {
    const db = getDb();

    // Get latest P90 wait time per queue (only queues with waiting jobs)
    const rows = await db`
      SELECT w.queue, w.p90_wait_secs, w.p50_wait_secs, w.p95_wait_secs,
             a.jobs_scheduled, a.jobs_waiting, a.agents_total
      FROM (
        SELECT DISTINCT ON (queue)
          queue, p90_wait_secs, p50_wait_secs, p95_wait_secs
        FROM queue_snapshots
        WHERE p90_wait_secs IS NOT NULL
          AND polled_at >= NOW() - INTERVAL '15 minutes'
        ORDER BY queue, polled_at DESC
      ) w
      INNER JOIN (
        SELECT DISTINCT ON (queue)
          queue, jobs_scheduled, jobs_waiting, agents_total
        FROM queue_snapshots
        ORDER BY queue, polled_at DESC
      ) a ON w.queue = a.queue
      WHERE a.jobs_scheduled + a.jobs_waiting > 0
    `;

    const overThreshold = rows.filter(
      (r) => r.p90_wait_secs > WAIT_THRESHOLD_MINUTES * 60,
    );
    const overQueues = new Set(overThreshold.map((r) => r.queue as string));

    // Compute today's Pacific date key (handles PST/PDT automatically)
    const dateKey = getPacificDateKey();

    // Get today's combined summary message
    const summaryRows = await db`
      SELECT message_ts, queues
      FROM alert_summary
      WHERE id = ${dateKey}
    `;

    let messageTs: string | null =
      summaryRows.length > 0 ? (summaryRows[0].message_ts as string) : null;
    const queueStates: Record<string, QueueAlertEntry> =
      summaryRows.length > 0
        ? (summaryRows[0].queues as Record<string, QueueAlertEntry>)
        : {};

    const time = fmtTime();
    let changed = false;

    // Update/add queues over threshold
    for (const q of overThreshold) {
      const queue = q.queue as string;
      const existing = queueStates[queue];
      const waiting = effectiveWaiting(queue, q.jobs_scheduled as number, (q.jobs_waiting as number) ?? 0);

      queueStates[queue] = {
        status: "active",
        firstAlerted: existing?.firstAlerted ?? time,
        lastP90Secs: q.p90_wait_secs as number,
        lastJobs: waiting,
        resolvedAt: null,
      };
      changed = true;
    }

    // Resolve queues that dropped below threshold
    for (const [queue, info] of Object.entries(queueStates)) {
      if (info.status === "active" && !overQueues.has(queue)) {
        queueStates[queue] = { ...info, status: "resolved", resolvedAt: time };
        changed = true;
      }
    }

    const alerted = overThreshold.length;
    const resolved = Object.values(queueStates).filter(
      (q) => q.status === "resolved",
    ).length;

    // Post or update the combined Slack message
    if (changed && Object.keys(queueStates).length > 0) {
      const text = buildCombinedMessage(queueStates, time);

      if (messageTs) {
        await updateMessage(messageTs, text);
        // Post a thread reply so the channel gets a notification
        const active = Object.values(queueStates).filter(
          (q) => q.status === "active",
        );
        const resolvedCount = Object.values(queueStates).filter(
          (q) => q.status === "resolved",
        ).length;
        const allResolved = active.length === 0 && resolvedCount > 0;
        const threadText = allResolved
          ? `:white_check_mark: All queues resolved`
          : `:rotating_light: ${active.length} queue${active.length !== 1 ? "s" : ""} still alerting — updated ${time} ${getPacificTzAbbr()}`;
        await postMessage(threadText, messageTs);
      } else {
        const result = await postMessage(text);
        if (result.ok && result.ts) {
          messageTs = result.ts;
        }
      }

      if (messageTs) {
        await db`
          INSERT INTO alert_summary (id, message_ts, queues, created_at, updated_at)
          VALUES (${dateKey}, ${messageTs}, ${JSON.stringify(queueStates)}::jsonb, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE
            SET message_ts = EXCLUDED.message_ts,
                queues = EXCLUDED.queues,
                updated_at = NOW()
        `;

        // Add checkmark reaction when all queues resolve
        const allResolved = Object.values(queueStates).every(
          (q) => q.status === "resolved",
        );
        if (allResolved) {
          await addReaction("white_check_mark", messageTs);
        }
      }
    }

    return NextResponse.json({
      ok: true,
      alerted,
      resolved,
      queues: Object.keys(queueStates).length,
    });
  } catch (error) {
    console.error("Queue alert failed:", error);
    return NextResponse.json(
      { error: "Failed to check queue times" },
      { status: 500 },
    );
  }
}
