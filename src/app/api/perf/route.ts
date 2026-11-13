import { NextRequest, NextResponse } from "next/server";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { resolvePerfDataStartDate } from "@/lib/perf-data";
import { perfEvalStore, resolvePerfEvalSource } from "@/lib/perf-eval-store";

// Perf data refreshes at most nightly, so a longer cache keeps repeat loads
// instant without serving stale numbers.
const TTL = 300_000;
const CDN_CACHE = { maxAge: 300, staleWhileRevalidate: 3_600 };

function intParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const source = resolvePerfEvalSource(sp);
    const model = sp.get("model");
    const device = sp.get("device");
    const tp = sp.get("tp");
    const conc = sp.get("conc");
    const startDate = resolvePerfDataStartDate(sp.get("start"));

    const cacheKey = `perf:${source}:${startDate}:${model}:${device}:${tp}:${conc}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    const rows = await perfEvalStore(source).perfRows({
      startDate,
      model,
      device,
      tp: intParam(tp),
      conc: intParam(conc),
    });

    const result = { rows };
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch perf data:", error);
    return NextResponse.json({ error: "Failed to fetch performance data" }, { status: 500 });
  }
}
