import { NextRequest, NextResponse } from "next/server";
import { loadEvalRows, loadEvalTaskCount } from "@/lib/eval-data";
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

    const model = sp.get("model");
    const task = sp.get("task");
    const [rows, taskCount] = await Promise.all([
      loadEvalRows({ model, task, image: sp.get("image") }),
      loadEvalTaskCount({ model, task }),
    ]);

    const result = { rows, taskCount };
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
