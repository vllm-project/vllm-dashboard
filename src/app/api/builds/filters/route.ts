import { NextRequest, NextResponse } from "next/server";
import { queryClickHouse } from "@/lib/clickhouse";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { attrText } from "@/lib/otel-clickhouse";

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
      // ci.otel_spans holds the spans the Postgres otel_spans table did. The
      // names are sorted as Postgres's en_US collation sorted them.
      const [pipelines, branches] = await Promise.all([
        queryClickHouse<{ name: string }>(`
          SELECT DISTINCT ${attrText("buildkite.pipeline.name", "resource_attributes")} AS name
          FROM ci.otel_spans
          WHERE span_name = 'buildkite.build'
            AND start_time > now64(6) - INTERVAL 30 DAY
            AND name IS NOT NULL
        `),
        // build_branch is the materialized buildkite.build.branch attribute.
        queryClickHouse<{ branch: string }>(`
          SELECT DISTINCT build_branch AS branch
          FROM ci.otel_spans
          WHERE span_name = 'buildkite.build'
            AND start_time > now64(6) - INTERVAL 30 DAY
            AND build_branch != ''
        `),
      ]);
      const collator = new Intl.Collator("en-US");
      result = {
        pipelines: pipelines.map((p) => p.name).sort(collator.compare),
        branches: branches.map((b) => b.branch).sort(collator.compare),
      };
    } else {
      const [pipelines, branches] = await Promise.all([
        queryClickHouse(`
          SELECT DISTINCT p.name AS name
          FROM buildkite.pipeline AS p FINAL
          WHERE NOT p._fivetran_deleted
          ORDER BY p.name ASC NULLS FIRST
        `),
        queryClickHouse(`
          SELECT DISTINCT b.branch AS branch
          FROM buildkite.build AS b FINAL
          WHERE NOT b._fivetran_deleted
            AND b.created_at >= today() - 30
          ORDER BY b.branch ASC NULLS FIRST
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
