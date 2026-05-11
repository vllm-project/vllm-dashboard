import { NextRequest, NextResponse } from "next/server";
import { loadEvalRows } from "@/lib/eval-data";
import {
  buildSummary,
  compareEvalRows,
  comparePerfRows,
  loadPerfRows,
  parseThreshold,
  sortDeltas,
} from "@/lib/compare";

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const baseline = sp.get("baseline");
    const candidate = sp.get("candidate");
    if (!baseline || !candidate) {
      return NextResponse.json(
        { error: "Missing baseline or candidate image" },
        { status: 400 }
      );
    }

    const model = sp.get("model");
    const device = sp.get("device");
    const task = sp.get("task");
    const perfThreshold = parseThreshold(sp.get("perf_threshold"), 0.02);
    const evalSigma = parseThreshold(sp.get("eval_sigma"), 2);

    const [perfRows, evalRows] = await Promise.all([
      loadPerfRows({ baseline, candidate, model, device }),
      loadEvalRows({ model, task, images: [baseline, candidate] }),
    ]);

    const perf = comparePerfRows(perfRows, baseline, candidate, perfThreshold);
    const evalData = compareEvalRows(evalRows, baseline, candidate, evalSigma);
    const allDeltas = [...perf.deltas, ...evalData.deltas].sort(sortDeltas);
    const worstRegressions = allDeltas
      .filter((delta) => delta.status === "regression")
      .slice(0, 25);

    return NextResponse.json({
      baseline,
      candidate,
      thresholds: {
        perf: perfThreshold,
        evalSigma,
      },
      summary: buildSummary(perf, evalData),
      worstRegressions,
      perf: {
        deltas: perf.deltas.sort(sortDeltas),
        missingBaseline: perf.missingBaseline,
        missingCandidate: perf.missingCandidate,
      },
      eval: {
        deltas: evalData.deltas.sort(sortDeltas),
        missingBaseline: evalData.missingBaseline,
        missingCandidate: evalData.missingCandidate,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to compare images:", error);
    return NextResponse.json(
      { error: "Failed to compare images" },
      { status: 500 }
    );
  }
}
