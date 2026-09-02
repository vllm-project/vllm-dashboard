import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { getDb } from "@/lib/db";

const TTL = 300_000;
const CDN_CACHE = { maxAge: 300, staleWhileRevalidate: 86_400 };

export async function GET(request: NextRequest) {
  try {
    const source = resolveCiDataSource(request);
    const cacheKey = `builds:filters:${source}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    let result: { pipelines: string[]; branches: string[] };
    if (source === "otel") {
      const db = getDb();
      const [pipelines, branches] = await Promise.all([
        db<{ name: string }[]>`
          SELECT DISTINCT resource_attributes->>'buildkite.pipeline.name' AS name
          FROM otel_spans
          WHERE span_name = 'buildkite.build'
            AND resource_attributes->>'buildkite.pipeline.name' IS NOT NULL
          ORDER BY name
        `,
        db<{ branch: string }[]>`
          SELECT DISTINCT span_attributes->>'buildkite.build.branch' AS branch
          FROM otel_spans
          WHERE span_name = 'buildkite.build'
            AND start_time > NOW() - INTERVAL '30 days'
            AND span_attributes->>'buildkite.build.branch' IS NOT NULL
          ORDER BY branch
        `,
      ]);
      result = {
        pipelines: pipelines.map((p) => p.name),
        branches: branches.map((b) => b.branch),
      };
    } else {
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
      result = {
        pipelines: pipelines.map((p) => (p as Record<string, unknown>).name as string),
        branches: branches.map((b) => (b as Record<string, unknown>).branch as string),
      };
    }
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch filters:", error);
    return NextResponse.json(
      { error: "Failed to fetch filter options" },
      { status: 500 }
    );
  }
}
