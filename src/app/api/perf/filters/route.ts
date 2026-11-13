import { NextResponse } from "next/server";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { resolvePerfDataStartDate } from "@/lib/perf-data";
import { perfEvalStore, resolvePerfEvalSource } from "@/lib/perf-eval-store";

const TTL = 300_000;
const CDN_CACHE = { maxAge: 600, staleWhileRevalidate: 86_400 };

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const startDate = resolvePerfDataStartDate(searchParams.get("start"));
    const end = searchParams.get("end");
    const source = resolvePerfEvalSource(searchParams);

    const cacheKey = `perf:filters:${source}:${startDate}:${end}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    const { modelRows, dimRows, imageDateRows } = await perfEvalStore(source).perfFilterRows({
      startDate,
      end: end && isIsoDate(end) ? end.slice(0, 10) : null,
    });

    const modelCounts: Record<string, number> = {};
    for (const r of modelRows) {
      if (r.model) modelCounts[r.model] = Number(r.n) || 0;
    }
    // Most data first; alphabetical as a tiebreak.
    const models = Object.keys(modelCounts).sort(
      (a, b) => modelCounts[b] - modelCounts[a] || a.localeCompare(b)
    );
    const present = (values: (string | null)[]) =>
      [...new Set(values.filter((v): v is string => Boolean(v)))];
    const devices = present(dimRows.map((r) => r.device)).sort();
    const tps = present(dimRows.map((r) => r.tp)).sort((a, b) => +a - +b);
    const concs = present(dimRows.map((r) => r.conc)).sort((a, b) => +a - +b);
    const precisions = present(dimRows.map((r) => r.precision)).sort();
    const images = present(dimRows.map((r) => r.image)).sort();
    const imageDates: Record<string, string> = {};
    for (const r of imageDateRows) {
      if (r.image && r.last_date) imageDates[r.image] = r.last_date;
    }

    const result = { models, modelCounts, devices, tps, concs, precisions, images, imageDates };
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch perf filters:", error);
    return NextResponse.json({ error: "Failed to fetch filters" }, { status: 500 });
  }
}
