import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { runRegressionCheck, type RegressionResult } from "@/lib/eval-regression";
import { parseEvalKey } from "@/lib/compare";
import {
  planEpisodes,
  evalAlertKey,
  shouldNotify,
  type OpenEpisode,
} from "@/lib/eval-episodes";
import { EMPTY_SUMMARY } from "@/lib/eval-alert-types";
import { postMessage, updateMessage, addReaction } from "@/lib/slack";
import {
  fmtMetricDelta,
  fmtMetricValue,
  fmtPacificTime,
  fmtSigma,
  getPacificDateKey,
  getPacificTzAbbr,
} from "@/lib/alerts-shared";

export const maxDuration = 55;

function slackChannel(): string | null {
  return (
    process.env.SLACK_EVAL_ALERT_CHANNEL ??
    process.env.SLACK_CI_INFRA_ALERT_CHANNEL ??
    process.env.SLACK_CHANNEL_ID ??
    null
  );
}

function buildSlackText(result: RegressionResult, time: string, tz: string): string {
  if (result.status === "pass") {
    return [
      `:white_check_mark: *Eval Regression Check — All Passed*`,
      `${result.candidateLabel} vs baseline ${result.baselineLabel}`,
      `${result.summary.total} metrics checked · 0 regressions`,
      "",
      `_Updated ${time} ${tz}_`,
      `<${result.compareUrl}|View comparison>`,
    ].join("\n");
  }

  const lines = [
    `:rotating_light: *Eval Regression Detected*`,
    `${result.candidateLabel} vs baseline ${result.baselineLabel}`,
    `${result.summary.regressed} regression${result.summary.regressed !== 1 ? "s" : ""} of ${result.summary.total} metrics`,
    "",
  ];
  if (result.summary.missingCandidate > 0) {
    lines.push(
      `_${result.summary.missingCandidate} baseline metrics not covered by this nightly_`,
      "",
    );
  }
  for (const reg of result.regressions.slice(0, 15)) {
    const fields = parseEvalKey(reg);
    if (!fields) continue;
    const unit = reg.unit;
    lines.push(
      `:red_circle: *${fields.task}* — ${fields.metric}: ${fmtMetricValue(reg.baselineValue, unit)} → ${fmtMetricValue(reg.candidateValue, unit)} (${fmtMetricDelta(reg.delta, unit)}, ${fmtSigma(reg.significance)})`,
    );
  }
  if (result.regressions.length > 15) {
    lines.push(`… and ${result.regressions.length - 15} more`);
  }
  lines.push("", `_Updated ${time} ${tz}_`);
  lines.push(`<${result.compareUrl}|View comparison>`);
  return lines.join("\n");
}

/** Bump the cron heartbeat so the banner knows the cron is alive. */
async function touchHeartbeat(db: ReturnType<typeof getDb>) {
  await db`
    INSERT INTO alerting_eval_last_notified (id, last_checked_at, updated_at)
    VALUES (1, now(), now())
    ON CONFLICT (id) DO UPDATE
      SET last_checked_at = now(), updated_at = now()
  `;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await runRegressionCheck();
    const db = getDb();

    // Always bump heartbeat so the banner can test cron liveness
    // independently of whether a new snapshot was written.
    await touchHeartbeat(db);

    if (!result) {
      await db`
        INSERT INTO alerting_eval_regression_snapshots
          (status, summary, checked_at)
        VALUES (
          'error',
          ${JSON.stringify({ ...EMPTY_SUMMARY, error: "Could not resolve baseline or candidate image" })}::jsonb,
          now()
        )
      `;
      return NextResponse.json({
        ok: true,
        status: "error",
        reason: "Could not resolve baseline or candidate image",
      });
    }

    // Short-circuit when (baseline, candidate) matches the last snapshot.
    // The heartbeat was already bumped above, so the banner stays green.
    const lastSnapshot = await db`
      SELECT baseline_image, candidate_image
      FROM alerting_eval_regression_snapshots
      WHERE status != 'error'
      ORDER BY checked_at DESC
      LIMIT 1
    `;
    if (
      lastSnapshot.length > 0 &&
      lastSnapshot[0].baseline_image === result.baselineImage &&
      lastSnapshot[0].candidate_image === result.candidateImage
    ) {
      return NextResponse.json({
        ok: true,
        status: "unchanged",
        reason: "Same (baseline, candidate) as last check — skipped",
        baseline: result.baselineImage,
        candidate: result.candidateImage,
      });
    }

    // Persist snapshot.
    await db`
      INSERT INTO alerting_eval_regression_snapshots
        (baseline_image, candidate_image, status, summary, compare_url, checked_at)
      VALUES (
        ${result.baselineImage},
        ${result.candidateImage},
        ${result.status},
        ${JSON.stringify(result.summary)}::jsonb,
        ${result.compareUrl},
        ${result.checkedAt}
      )
    `;

    // No evidence (skipped) → do not open, resolve, or notify.
    if (result.status === "skipped") {
      return NextResponse.json({
        ok: true,
        status: "skipped",
        reason: "No candidate eval data; no alerts changed",
        baseline: result.baselineImage,
        candidate: result.candidateImage,
      });
    }

    // Plan episode changes via the pure function.
    // postgres.js' TransactionSql type omits call signatures even though the
    // runtime transaction object is the same callable tagged-template API.
    await db.begin(async (transaction) => {
      const tx = transaction as unknown as typeof db;

      const openAlerts: OpenEpisode[] = (await tx`
        SELECT alert_id, model, task, n_shot, metric, filter
        FROM alerting_eval_regression_alerts
        WHERE status = 'open'
      `).map((a) => ({
        alert_id: a.alert_id as number,
        model: a.model as string,
        task: a.task as string,
        n_shot: a.n_shot as number,
        metric: a.metric as string,
        filter: a.filter as string,
      }));

      const plan = planEpisodes(openAlerts, result.allDeltas, result.regressions);

      if (plan.toUpsert.length > 0) {
        const rows = plan.toUpsert.map((reg) => {
          const f = parseEvalKey(reg)!;
          return {
            model: f.model,
            task: f.task,
            n_shot: f.nShot,
            metric: f.metric,
            filter: f.filter,
            higher_is_better: reg.higherIsBetter,
            unit: reg.unit,
            status: "open",
            baseline_image: result.baselineImage,
            baseline_value: reg.baselineValue,
            candidate_image: result.candidateImage,
            candidate_value: reg.candidateValue,
            delta: reg.delta,
            delta_pct: reg.deltaPct,
            significance: reg.significance,
          };
        });
        await tx`
          INSERT INTO alerting_eval_regression_alerts ${tx(
            rows,
            "model", "task", "n_shot", "metric", "filter",
            "higher_is_better", "unit", "status",
            "baseline_image", "baseline_value",
            "candidate_image", "candidate_value",
            "delta", "delta_pct", "significance",
          )}
          ON CONFLICT (model, task, n_shot, metric, filter) WHERE status = 'open'
          DO UPDATE SET
            candidate_image = EXCLUDED.candidate_image,
            candidate_value = EXCLUDED.candidate_value,
            delta = EXCLUDED.delta,
            delta_pct = EXCLUDED.delta_pct,
            significance = EXCLUDED.significance,
            updated_at = now()
        `;
      }

      if (plan.toResolve.length > 0) {
        await tx`
          UPDATE alerting_eval_regression_alerts
          SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE alert_id = ANY(${plan.toResolve})
        `;
      }
    });

    // Build the current regression key set for notification comparison.
    const currentRegressionKeys = new Set<string>();
    for (const r of result.regressions) {
      const parsed = parseEvalKey(r);
      if (parsed) currentRegressionKeys.add(evalAlertKey(parsed));
    }

    // Slack notification — compare against last notified state, not day-row.
    const channel = slackChannel();
    if (!channel || !process.env.SLACK_BOT_TOKEN) {
      console.warn(
        "Eval regression: Slack not configured (missing SLACK_EVAL_ALERT_CHANNEL/SLACK_BOT_TOKEN) — notifications disabled",
      );
    } else {
      const time = fmtPacificTime();
      const tz = getPacificTzAbbr();
      const dateKey = getPacificDateKey();

      const lastNotifiedRows = await db`
        SELECT status, regression_keys FROM alerting_eval_last_notified
        WHERE id = 1
      `;
      const lastNotifiedStatus: string | null =
        lastNotifiedRows.length > 0 ? (lastNotifiedRows[0].status as string) : null;
      const lastNotifiedKeys: string[] | null =
        lastNotifiedRows.length > 0 ? (lastNotifiedRows[0].regression_keys as string[]) : null;

      const notify = shouldNotify(
        result.status,
        currentRegressionKeys,
        lastNotifiedStatus,
        lastNotifiedKeys,
      );

      if (notify) {
        const text = buildSlackText(result, time, tz);
        const keysArray = [...currentRegressionKeys];
        let delivered = false;

        // Get today's day-row for edit-in-place.
        const summaryRows = await db`
          SELECT message_ts FROM alerting_eval_alert_summary
          WHERE id = ${dateKey}
        `;
        let messageTs: string | null =
          summaryRows.length > 0 ? (summaryRows[0].message_ts as string) : null;

        if (messageTs) {
          // Edit existing day message.
          const updateResult = await updateMessage(messageTs, text, channel);
          if (updateResult.ok) {
            delivered = true;
            const threadText =
              result.status === "pass"
                ? `:white_check_mark: All eval checks passed`
                : `:rotating_light: ${result.summary.regressed} eval regression${result.summary.regressed !== 1 ? "s" : ""} — updated ${time} ${tz}`;
            const threadResult = await postMessage(threadText, messageTs, channel);
            if (!threadResult.ok) {
              console.error("Slack thread reply failed:", threadResult.error);
            }
          } else {
            console.error("Slack updateMessage failed:", updateResult.error);
          }
        } else {
          // New day message.
          const posted = await postMessage(text, undefined, channel);
          if (posted.ok && posted.ts) {
            messageTs = posted.ts;
            delivered = true;
          } else {
            console.error("Slack postMessage failed:", posted.error);
          }
        }

        // Only persist notification state when Slack actually delivered.
        // A failed post leaves last_notified unchanged so the next run
        // retries the notification instead of silently swallowing it.
        if (delivered && messageTs) {
          await db`
            INSERT INTO alerting_eval_alert_summary
              (id, message_ts, status, regression_keys, created_at, updated_at)
            VALUES (${dateKey}, ${messageTs}, ${result.status}, ${JSON.stringify(keysArray)}::jsonb, now(), now())
            ON CONFLICT (id) DO UPDATE
              SET message_ts = EXCLUDED.message_ts,
                  status = EXCLUDED.status,
                  regression_keys = EXCLUDED.regression_keys,
                  updated_at = now()
          `;

          if (result.status === "pass") {
            const reaction = await addReaction("white_check_mark", messageTs, channel);
            if (!reaction.ok) {
              console.error("Slack addReaction failed:", reaction.error);
            }
          }

          await db`
            INSERT INTO alerting_eval_last_notified (id, status, regression_keys, updated_at)
            VALUES (1, ${result.status}, ${JSON.stringify(keysArray)}::jsonb, now())
            ON CONFLICT (id) DO UPDATE
              SET status = EXCLUDED.status,
                  regression_keys = EXCLUDED.regression_keys,
                  updated_at = now()
          `;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      status: result.status,
      baseline: result.baselineImage,
      candidate: result.candidateImage,
      summary: result.summary,
      compareUrl: result.compareUrl,
    });
  } catch (error) {
    console.error("Eval regression check failed:", error);
    try {
      const db = getDb();
      await touchHeartbeat(db);
      await db`
        INSERT INTO alerting_eval_regression_snapshots
          (status, summary, checked_at)
        VALUES (
          'error',
          ${JSON.stringify({ ...EMPTY_SUMMARY, error: String(error) })}::jsonb,
          now()
        )
      `;
    } catch (snapshotError) {
      console.error("Failed to record error snapshot:", snapshotError);
    }
    return NextResponse.json(
      { error: "Eval regression check failed" },
      { status: 500 },
    );
  }
}
