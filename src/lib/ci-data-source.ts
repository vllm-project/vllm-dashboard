import type { NextRequest } from "next/server";

export type CiDataSource = "otel" | "clickhouse";

/**
 * Decide whether a CI dashboard route reads from the `otel_spans` table
 * (near-real-time) or the Fivetran Buildkite tables in ClickHouse (default).
 *
 * Precedence: explicit `?source=` query param wins, then the `CI_DATA_SOURCE`
 * env var, else `clickhouse`. `databricks` is accepted as a legacy alias for
 * the Fivetran tables, which moved from Databricks to ClickHouse.
 */
export function resolveCiDataSource(
  request: NextRequest,
): CiDataSource {
  return parseSource(request.nextUrl.searchParams.get("source"))
    ?? parseSource(process.env.CI_DATA_SOURCE)
    ?? "clickhouse";
}

function parseSource(value: string | null | undefined): CiDataSource | undefined {
  if (value === "otel") return "otel";
  if (value === "clickhouse" || value === "databricks") return "clickhouse";
  return undefined;
}
