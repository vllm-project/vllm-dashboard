import { NextRequest, NextResponse } from "next/server";
import { loadEvalRows } from "@/lib/eval-data";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";

const TTL = 60_000;
const CDN_CACHE = { maxAge: 300, staleWhileRevalidate: 3_600 };

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const cacheKey = `eval:${sp.get("model")}:${sp.get("task")}:${sp.get("image")}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    const rows = await loadEvalRows({
      model: sp.get("model"),
      task: sp.get("task"),
      image: sp.get("image"),
    });

    const result = { rows };
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch eval data:", error);
    return NextResponse.json(
      { error: "Failed to fetch evaluation data" },
      { status: 500 }
    );
  }
}
