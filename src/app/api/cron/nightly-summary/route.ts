import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { loadEvalRows } from "@/lib/eval-data";
import {
  computeEvalHistory,
  computePerfHistory,
  loadNightlyPerfHistory,
} from "@/lib/compare";
import { renderNightlyCanvas, renderChannelSummary } from "@/lib/nightly-template";
import { createCanvas, shareCanvasToChannel, postMessage } from "@/lib/slack";

export const maxDuration = 55;

// --- History window knobs -------------------------------------------------
const AVG_WINDOW_DAYS = 7;
const PEAK_WINDOW_DAYS = 30;
const PERF_LOAD_DAYS = 35; // >= peak window
const Z_THRESHOLD = 2;
const MIN_PCT_FLAG = 0.01;
const PERF_METRICS = ["tput_per_gpu"];
const NIGHTLY_WINDOW = 40; // nightly images to pull eval history from

const HISTORY_OPTS = {
  avgWindowDays: AVG_WINDOW_DAYS,
  peakWindowDays: PEAK_WINDOW_DAYS,
  zThreshold: Z_THRESHOLD,
  minPctFlag: MIN_PCT_FLAG,
};

interface NightlyRow {
  commit: string;
  image: string;
  latest_ts: string;
}

async function loadNightlyCommits(limit: number): Promise<NightlyRow[]> {
  return queryDatabricks<NightlyRow>(`
    WITH nights AS (
      SELECT
        NULLIF(
          COALESCE(
            NULLIF(message:vllm_commit::STRING, ''),
            regexp_extract(LOWER(message:image::STRING), 'nightly-([0-9a-f]+)', 1)
          ),
          ''
        ) AS commit,
        message:image::STRING AS image,
        COALESCE(message:date::DOUBLE, message:data:date::DOUBLE) AS ts
      FROM vllm_data_warehouse.default.vllm_eval_data_ingest
      WHERE message:nightly::BOOLEAN = TRUE
        AND message:image::STRING IS NOT NULL

      UNION ALL

      SELECT
        NULLIF(regexp_extract(LOWER(message:image::STRING), 'nightly-([0-9a-f]+)', 1), '') AS commit,
        message:image::STRING AS image,
        unix_timestamp(message:date::STRING) AS ts
      FROM vllm_data_warehouse.default.vllm_perf_data_ingest
      WHERE message:nightly::BOOLEAN = TRUE
        AND message:image::STRING IS NOT NULL
    )
    SELECT
      commit,
      MAX(image) AS image,
      CAST(MAX(ts) AS STRING) AS latest_ts
    FROM nights
    WHERE commit IS NOT NULL
    GROUP BY commit
    ORDER BY MAX(ts) DESC
    LIMIT ${limit}
  `);
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  if (!process.env.SLACK_BOT_TOKEN) {
    return NextResponse.json({ error: "SLACK_BOT_TOKEN not configured" }, { status: 500 });
  }
  const channel = process.env.SLACK_CI_NOTIFICATIONS_CHANNEL;
  if (!channel) {
    return NextResponse.json(
      { error: "SLACK_CI_NOTIFICATIONS_CHANNEL must be set" },
      { status: 500 },
    );
  }

  try {
    const nightlies = await loadNightlyCommits(NIGHTLY_WINDOW);
    if (nightlies.length === 0) {
      return NextResponse.json({ ok: true, skipped: true, reason: "No nightlies found" });
    }
    const current = nightlies[0];
    const prev = nightlies[1] ?? null;
    const windowImages = nightlies.map((n) => n.image);

    // Perf history (peak / 7d avg ±σ / current) from the trailing date window.
    const perfRows = await loadNightlyPerfHistory(PERF_LOAD_DAYS);
    const perfHistory = computePerfHistory(perfRows, { ...HISTORY_OPTS, metrics: PERF_METRICS });
    const latestPerfDate = perfRows.reduce<string | null>((max, r) => {
      const d = r.date ? r.date.slice(0, 10) : null;
      return d && (!max || d > max) ? d : max;
    }, null);

    // Eval history from the window's nightly images.
    const evalRows = await loadEvalRows({ images: windowImages });
    const evalHistory = computeEvalHistory(evalRows, HISTORY_OPTS);

    if (perfHistory.length === 0 && evalHistory.length === 0) {
      return NextResponse.json({ ok: true, skipped: true, reason: "No perf or eval history" });
    }

    const canvasInput = {
      commit: current.commit,
      prevCommit: prev?.commit ?? "n/a",
      latestDate: latestPerfDate,
      perfHistory,
      evalHistory,
      window: HISTORY_OPTS,
    };

    // Preferred path: publish a canvas and post a short message linking to it.
    const { title, content } = renderNightlyCanvas(canvasInput);
    const canvas = await createCanvas(title, content);

    if (canvas.ok && canvas.canvasId && canvas.url) {
      await shareCanvasToChannel(canvas.canvasId, channel);
      const message = renderChannelSummary(canvasInput, canvas.url);
      const posted = await postMessage(message, undefined, channel);
      if (!posted.ok) {
        return NextResponse.json({ error: `Slack post failed: ${posted.error}` }, { status: 500 });
      }
      return NextResponse.json({
        ok: true,
        mode: "canvas",
        canvasId: canvas.canvasId,
        canvasUrl: canvas.url,
        perfConfigs: perfHistory.length,
        perfRegressions: perfHistory.filter((r) => r.status === "regression").length,
        evalMetrics: evalHistory.length,
        evalRegressions: evalHistory.filter((r) => r.status === "regression").length,
        messageTs: posted.ts,
      });
    }

    // Fallback: canvas creation failed (e.g. transient Slack error or the bot
    // lost the canvases:write scope). Post the same summary message without a
    // canvas link so the nightly notification still goes out — never the legacy
    // text-table format.
    const message = renderChannelSummary(canvasInput, "");
    const posted = await postMessage(message, undefined, channel);
    if (!posted.ok) {
      return NextResponse.json({ error: `Slack post failed: ${posted.error}` }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      mode: "message-fallback",
      canvasError: canvas.error ?? "no canvas url",
      perfConfigs: perfHistory.length,
      evalMetrics: evalHistory.length,
      messageTs: posted.ts,
    });
  } catch (error) {
    console.error("Nightly summary cron failed:", error);
    return NextResponse.json({ error: "Failed to send nightly summary" }, { status: 500 });
  }
}
