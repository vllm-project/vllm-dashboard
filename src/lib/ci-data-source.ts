import type { NextRequest } from "next/server";

export type CiDataSource = "otel" | "databricks";

/**
 * Decide whether a CI dashboard route reads from the Postgres `otel_spans`
 * table (near-real-time) or the Fivetran→Databricks warehouse (default).
 *
 * Precedence: explicit `?source=` query param wins, then the `CI_DATA_SOURCE`
 * env var, else `databricks` so the default behavior is unchanged.
 */
export function resolveCiDataSource(
  request: NextRequest,
): CiDataSource {
  const param = request.nextUrl.searchParams.get("source");
  if (param === "otel" || param === "databricks") return param;
  const env = process.env.CI_DATA_SOURCE;
  if (env === "otel" || env === "databricks") return env;
  return "databricks";
}
