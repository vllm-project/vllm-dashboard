import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { collectForceMergeRecords } from "@/lib/force-merge-stats";

export const maxDuration = 55;

// Rolling window re-fetched daily and upserted by PR number, so the stored
// history accumulates beyond the window instead of rolling off with it.
const FETCH_WINDOW_DAYS = 182;
const UPSERT_BATCH_SIZE = 500;

interface ForceMergeRow {
  pr_number: number;
  title: string;
  url: string;
  author: string | null;
  merged_by: string | null;
  merged_at: string;
  force_merged: boolean;
  fetched_at: Date;
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "GITHUB_TOKEN or GH_TOKEN not configured" },
      { status: 500 },
    );
  }

  try {
    const records = await collectForceMergeRecords({
      token,
      days: FETCH_WINDOW_DAYS,
    });
    const db = getDb();
    const fetchedAt = new Date();

    const rows: ForceMergeRow[] = records.map((record) => ({
      pr_number: record.prNumber,
      title: record.title,
      url: record.url,
      author: record.author,
      merged_by: record.mergedBy,
      merged_at: record.mergedAt,
      force_merged: record.forceMerged,
      fetched_at: fetchedAt,
    }));

    let stored = 0;
    for (let offset = 0; offset < rows.length; offset += UPSERT_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + UPSERT_BATCH_SIZE);
      await db`
        INSERT INTO force_merge_records ${db(
          batch,
          "pr_number",
          "title",
          "url",
          "author",
          "merged_by",
          "merged_at",
          "force_merged",
          "fetched_at",
        )}
        ON CONFLICT (pr_number) DO UPDATE SET
          title = EXCLUDED.title,
          url = EXCLUDED.url,
          author = EXCLUDED.author,
          merged_by = EXCLUDED.merged_by,
          merged_at = EXCLUDED.merged_at,
          force_merged = EXCLUDED.force_merged,
          fetched_at = EXCLUDED.fetched_at
      `;
      stored += batch.length;
    }

    const forced = rows.filter((row) => row.force_merged).length;
    return NextResponse.json({
      fetched: rows.length,
      forced,
      stored,
      windowDays: FETCH_WINDOW_DAYS,
      fetchedAt: fetchedAt.toISOString(),
    });
  } catch (error) {
    console.error("force-merge-stats fetch failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "fetch failed" },
      { status: 500 },
    );
  }
}
