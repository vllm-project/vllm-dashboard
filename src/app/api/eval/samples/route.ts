import { NextRequest, NextResponse } from "next/server";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { perfEvalStore, resolvePerfEvalSource } from "@/lib/perf-eval-store";

export interface EvalSample {
  doc_id: number;
  task: string;
  filter: string;
  exact_match: number;
  question: string;
  prompt: string;
  target: string;
  response: string;
  filtered_response: string;
  metrics: string[];
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const buildId = sp.get("build_id");
    const taskParam = sp.get("task");
    const workloadParam = sp.get("workload");
    const correct = sp.get("correct"); // "true" | "false" | null (all)
    const limitParam = parseInt(sp.get("limit") ?? "200", 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 5000) : 200;

    if (!buildId) {
      return NextResponse.json({ error: "Missing build_id" }, { status: 400 });
    }

    const source = resolvePerfEvalSource(sp);
    const cacheKey = `eval:samples:${source}:${buildId}:${taskParam}:${workloadParam}:${correct}:${limit}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return cachedJson(cached, {
        maxAge: 300,
        staleWhileRevalidate: 3_600,
      });
    }

    // Fetch one extra row to detect truncation without a separate COUNT.
    // Counts always reflect the FULL set so the drawer's filter pills show totals.
    const { rows: flatRows, counts } = await perfEvalStore(source).evalSamples({
      buildId,
      task: taskParam,
      workload: workloadParam,
      correct: correct === "true" || correct === "false" ? correct : null,
      limit: limit + 1,
    });

    const truncated = flatRows.length > limit;
    const sliced = truncated ? flatRows.slice(0, limit) : flatRows;

    const samples: EvalSample[] = sliced.map((r) => ({
      doc_id: r.doc_id == null ? -1 : Number(r.doc_id),
      task: r.task ?? "",
      filter: r.filter ?? "",
      exact_match: r.exact_match == null ? 0 : Number(r.exact_match),
      question: r.question ?? "",
      prompt: r.prompt ?? "",
      target: r.target ?? "",
      response: r.response ?? "",
      filtered_response: r.filtered_response ?? "",
      metrics: [],
    }));

    const correctCount = Number(counts.correct ?? 0);
    const incorrectCount = Number(counts.incorrect ?? 0);

    const result = {
      samples,
      total: correctCount + incorrectCount,
      correct: correctCount,
      incorrect: incorrectCount,
      truncated,
    };
    setCache(cacheKey, result, 60_000);

    return cachedJson(result, {
      maxAge: 300,
      staleWhileRevalidate: 3_600,
    });
  } catch (error) {
    console.error("Failed to fetch eval samples:", error);
    return NextResponse.json(
      { error: "Failed to fetch evaluation samples" },
      { status: 500 }
    );
  }
}
