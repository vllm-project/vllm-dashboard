import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getOrLoadCached } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";

const CACHE_KEY = "force-merges:summary";
const TTL = 10 * 60_000;
const CDN_CACHE = { maxAge: 600, staleWhileRevalidate: 3_600 };

// Window lengths for the headline force-merge rate cards.
const RATE_WINDOW_DAYS = [7, 30, 90, 182];
// Top-author ranking looks back the same six-month window the ingest
// backfills, so the leaderboard is comparable from the first full backfill on.
const AUTHOR_WINDOW_DAYS = 182;
const TOP_AUTHOR_COUNT = 15;
const RECENT_COUNT = 30;

interface WeeklyRow {
  week: string;
  total: number;
  forced: number;
}

function rate(forced: number, total: number): number {
  return total > 0 ? Math.round((1000 * forced) / total) / 10 : 0;
}

async function loadForceMergeSummary() {
  const db = getDb();

  const [weeklyRaw, windowsRaw, authorsRaw, recentRaw, summaryRaw] =
    await Promise.all([
      db<WeeklyRow[]>`
        SELECT (date_trunc('week', (merged_at AT TIME ZONE 'UTC')::date))::date::text AS week,
               count(*)::int AS total,
               count(*) FILTER (WHERE force_merged)::int AS forced
        FROM force_merge_records
        GROUP BY 1
        ORDER BY 1
      `,
      db<{ days: number; total: number; forced: number }[]>`
        SELECT w.days,
               count(r.*) FILTER (WHERE r.merged_at >= w.cutoff)::int AS total,
               count(r.*) FILTER (WHERE r.merged_at >= w.cutoff AND r.force_merged)::int AS forced
        FROM force_merge_records r
        CROSS JOIN (
          SELECT days, now() - (days || ' days')::interval AS cutoff
          FROM unnest(${RATE_WINDOW_DAYS}::int[]) AS days
        ) w
        GROUP BY w.days
        ORDER BY w.days
      `,
      db<{ author: string; forced: number }[]>`
        SELECT author, count(*)::int AS forced
        FROM force_merge_records
        WHERE force_merged AND author IS NOT NULL
          AND merged_at >= now() - (${AUTHOR_WINDOW_DAYS} * interval '1 day')
        GROUP BY author
        ORDER BY forced DESC, author
        LIMIT ${TOP_AUTHOR_COUNT}
      `,
      db<{ pr_number: number; title: string; url: string; author: string | null; merged_by: string | null; ci_state: string | null; merged_at: Date }[]>`
        SELECT pr_number, title, url, author, merged_by, ci_state, merged_at
        FROM force_merge_records
        WHERE force_merged
        ORDER BY merged_at DESC
        LIMIT ${RECENT_COUNT}
      `,
      db<{ records: number; forced: number; first_merged_at: Date | null; refreshed_at: Date | null }[]>`
        SELECT count(*)::int AS records,
               count(*) FILTER (WHERE force_merged)::int AS forced,
               min(merged_at) AS first_merged_at,
               max(fetched_at) AS refreshed_at
        FROM force_merge_records
      `,
    ]);

  // Drop the leading partial week (the fetch window starts mid-week) so the
  // first bucket is not artificially small, mirroring the source dashboard.
  const weeklyRows = weeklyRaw.length > 1 ? weeklyRaw.slice(1) : weeklyRaw;

  const windows = windowsRaw.map((row) => ({
    days: row.days,
    total: row.total,
    forced: row.forced,
    rate: rate(row.forced, row.total),
  }));

  const summary = summaryRaw[0] ?? {
    records: 0,
    forced: 0,
    first_merged_at: null,
    refreshed_at: null,
  };

  return {
    windows,
    weekly: weeklyRows.map((row) => ({
      week: row.week,
      total: row.total,
      forced: row.forced,
      rate: rate(row.forced, row.total),
    })),
    topAuthors: authorsRaw,
    recent: recentRaw.map((row) => ({
      prNumber: row.pr_number,
      title: row.title,
      url: row.url,
      author: row.author,
      mergedBy: row.merged_by,
      ciState: row.ci_state,
      mergedAt: row.merged_at.toISOString(),
    })),
    summary: {
      records: summary.records,
      forced: summary.forced,
      authorWindowDays: AUTHOR_WINDOW_DAYS,
      firstMergedAt: summary.first_merged_at?.toISOString() ?? null,
      refreshedAt: summary.refreshed_at?.toISOString() ?? null,
    },
  };
}

export async function GET() {
  try {
    const { data } = await getOrLoadCached(CACHE_KEY, TTL, loadForceMergeSummary);
    return cachedJson(data, CDN_CACHE);
  } catch (error) {
    console.error("Failed to load force-merge summary:", error);
    return NextResponse.json(
      { error: "Failed to load force-merge summary" },
      { status: 500 },
    );
  }
}
