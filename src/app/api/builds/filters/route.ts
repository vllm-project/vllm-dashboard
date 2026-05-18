import { NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";

const TTL = 300_000;

export async function GET() {
  try {
    const cacheKey = "builds:filters";
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    const [pipelines, branches] = await Promise.all([
      queryDatabricks(`
        SELECT DISTINCT p.name
        FROM vllm_data_warehouse.buildkite.pipeline AS p
        WHERE p._fivetran_deleted = false
        ORDER BY p.name
      `),
      queryDatabricks(`
        SELECT DISTINCT b.branch
        FROM vllm_data_warehouse.buildkite.build AS b
        WHERE b._fivetran_deleted = false
          AND b.created_at >= CURRENT_DATE - INTERVAL 30 DAY
        ORDER BY b.branch
      `),
    ]);

    const result = {
      pipelines: pipelines.map((p) => (p as Record<string, unknown>).name as string),
      branches: branches.map((b) => (b as Record<string, unknown>).branch as string),
    };
    setCache(cacheKey, result, TTL);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch filters:", error);
    return NextResponse.json(
      { error: "Failed to fetch filter options" },
      { status: 500 }
    );
  }
}
