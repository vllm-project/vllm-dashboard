import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { loadEvalRows, type EvalRow } from "@/lib/eval-data";
import {
  buildSummary,
  compareEvalRows,
  comparePerfRows,
  loadPerfRowsByImages,
  sortDeltas,
  type PerfRun,
} from "@/lib/compare";
import { renderNightlySummary } from "@/lib/nightly-template";
import { postMessage } from "@/lib/slack";

export const maxDuration = 55;

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

function groupPerfByImage(rows: PerfRun[]): Map<string, PerfRun[]> {
  const out = new Map<string, PerfRun[]>();
  for (const r of rows) {
    const arr = out.get(r.image) ?? [];
    arr.push(r);
    out.set(r.image, arr);
  }
  return out;
}

function groupEvalByImage(rows: EvalRow[]): Map<string, EvalRow[]> {
  const out = new Map<string, EvalRow[]>();
  for (const r of rows) {
    if (!r.image) continue;
    const arr = out.get(r.image) ?? [];
    arr.push(r);
    out.set(r.image, arr);
  }
  return out;
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
    return NextResponse.json(
      { error: "SLACK_BOT_TOKEN not configured" },
      { status: 500 },
    );
  }

  try {
    const channel = process.env.SLACK_CI_NOTIFICATIONS_CHANNEL;
    if (!channel) {
      return NextResponse.json(
        { error: "SLACK_CI_NOTIFICATIONS_CHANNEL must be set" },
        { status: 500 },
      );
    }
    const perfThreshold = 0.02;
    const evalSigma = 2;

    const nightlies = await loadNightlyCommits(2);
    if (nightlies.length < 2) {
      return NextResponse.json({ ok: true, skipped: true, reason: "Need at least 2 nightlies to compare" });
    }

    const current = nightlies[0];
    const prev = nightlies[1];

    const [perfRows, evalRows] = await Promise.all([
      loadPerfRowsByImages([current.image, prev.image]),
      loadEvalRows({ images: [current.image, prev.image] }),
    ]);

    const perfByImage = groupPerfByImage(perfRows);
    const evalByImage = groupEvalByImage(evalRows);

    const candidatePerf = perfByImage.get(current.image) ?? [];
    const baselinePerf = perfByImage.get(prev.image) ?? [];
    const candidateEval = evalByImage.get(current.image) ?? [];
    const baselineEval = evalByImage.get(prev.image) ?? [];

    const perfResult = comparePerfRows(
      [...baselinePerf, ...candidatePerf],
      prev.image,
      current.image,
      perfThreshold,
    );
    const evalResult = compareEvalRows(
      [...baselineEval, ...candidateEval],
      prev.image,
      current.image,
      evalSigma,
    );

    const summary = buildSummary(perfResult, evalResult);
    const perfDeltas = perfResult.deltas.sort(sortDeltas);
    const evalDeltas = evalResult.deltas.sort(sortDeltas);

    const tsEpoch = parseFloat(current.latest_ts);
    const date = Number.isFinite(tsEpoch) && tsEpoch > 0
      ? new Date(tsEpoch * 1000).toISOString()
      : new Date().toISOString();

    const text = renderNightlySummary(
      current.commit,
      prev.commit,
      date,
      summary,
      perfDeltas,
      evalDeltas,
      perfResult.missingCandidate,
      evalResult.missingCandidate,
    );

    const result = await postMessage(text, undefined, channel);
    if (!result.ok) {
      return NextResponse.json({ error: `Slack post failed: ${result.error}` }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      commit: current.commit.slice(0, 7),
      prevCommit: prev.commit.slice(0, 7),
      matched: summary.matched,
      regressions: summary.regressions,
      improvements: summary.improvements,
      noisy: summary.noisy,
      messageTs: result.ts,
    });
  } catch (error) {
    console.error("Nightly summary cron failed:", error);
    return NextResponse.json(
      { error: "Failed to send nightly summary" },
      { status: 500 },
    );
  }
}
