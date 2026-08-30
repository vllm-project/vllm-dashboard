import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  toFullCiComparisons,
  type FullCiComparisonRow,
  type FullCiConditionRow,
} from "@/lib/alerts-full-ci";

export const dynamic = "force-dynamic";

// Full CI runs twice a day, so a few weeks of comparisons is a short list. The
// cap bounds the response rather than trimming a feed anyone reads to the end.
const MAX_COMPARISONS = 30;

export async function GET() {
  try {
    const db = getDb();

    // Postgres alone answers this view: the comparison, the two runs it
    // compared, and how far its Slack delivery got. The analyzer's report,
    // failure cache, and S3 memory checkpoints are deliberately not selected.
    const comparisons = await db<FullCiComparisonRow[]>`
      SELECT a.current_build_id, a.previous_build_id, a.analyzed_at,
             cur.build_number  AS current_build_number,
             cur.scheduled_at  AS current_scheduled_at,
             cur.commit_sha    AS current_commit_sha,
             cur.message       AS current_message,
             cur.state         AS current_state,
             cur.commit_pr_number AS current_commit_pr_number,
             cur.commit_pr_url    AS current_commit_pr_url,
             cur.commit_pr_title  AS current_commit_pr_title,
             prev.build_number AS previous_build_number,
             prev.scheduled_at AS previous_scheduled_at,
             prev.commit_sha   AS previous_commit_sha,
             prev.message      AS previous_message,
             prev.state        AS previous_state,
             prev.commit_pr_number AS previous_commit_pr_number,
             prev.commit_pr_url    AS previous_commit_pr_url,
             prev.commit_pr_title  AS previous_commit_pr_title,
             -- The analyzer writes one outbox row per comparison under this
             -- deterministic delivery_id, which is the outbox primary key.
             (SELECT o.status
              FROM alerting_notification_outbox o
              WHERE o.delivery_id = 'full-ci:' || a.current_build_id
             ) AS notification_status
      FROM alerting_full_ci_analyses a
      JOIN alerting_full_ci_runs cur
        ON cur.buildkite_build_id = a.current_build_id
      JOIN alerting_full_ci_runs prev
        ON prev.buildkite_build_id = a.previous_build_id
      ORDER BY cur.scheduled_at DESC
      LIMIT ${MAX_COMPARISONS}
    `;

    const buildIds = comparisons.map((row) => row.current_build_id);

    // Each condition carries the classified job's outcome in both compared
    // runs, so the classification can be read against what actually happened.
    const conditions = buildIds.length
      ? await db<FullCiConditionRow[]>`
          SELECT fc.current_build_id, fc.job_name, fc.lifecycle, fc.cause,
                 fc.summary,
                 fc.culprit_pr_number, fc.culprit_pr_url, fc.culprit_pr_title,
                 fc.fixing_pr_number, fc.fixing_pr_url, fc.fixing_pr_title,
                 prev_out.state       AS previous_state,
                 prev_out.soft_failed AS previous_soft_failed,
                 cur_out.state        AS current_state,
                 cur_out.soft_failed  AS current_soft_failed
          FROM alerting_full_ci_failure_conditions fc
          JOIN alerting_full_ci_analyses a
            ON a.current_build_id = fc.current_build_id
          LEFT JOIN alerting_full_ci_job_outcomes cur_out
            ON cur_out.buildkite_build_id = fc.current_build_id
           AND cur_out.job_name = fc.job_name
          LEFT JOIN alerting_full_ci_job_outcomes prev_out
            ON prev_out.buildkite_build_id = a.previous_build_id
           AND prev_out.job_name = fc.job_name
          WHERE fc.current_build_id = ANY(${buildIds})
          ORDER BY fc.job_name
        `
      : [];

    return NextResponse.json(
      { comparisons: toFullCiComparisons(comparisons, conditions) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Failed to load Full CI alerts:", error);
    return NextResponse.json(
      { error: "Full CI alerts could not be loaded." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
