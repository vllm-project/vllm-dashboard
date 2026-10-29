import type { NextRequest } from "next/server";

export type CiDataSource = "otel" | "databricks";

/**
 * Decide whether a CI dashboard route reads from the Postgres `otel_spans`
 * table (near-real-time) or the Fivetran→Databricks warehouse (default).
 *
 * Precedence: explicit `?source=` query param wins (outside production
 * only: there it would let anyone pick the costlier path per request), then
 * the `CI_DATA_SOURCE` env var, else `databricks`.
 */
export function resolveCiDataSource(
  request: NextRequest,
): CiDataSource {
  const param = request.nextUrl.searchParams.get("source");
  if (
    process.env.VERCEL_ENV !== "production" &&
    (param === "otel" || param === "databricks")
  ) {
    return param;
  }
  const env = process.env.CI_DATA_SOURCE;
  if (env === "otel" || env === "databricks") return env;
  return "databricks";
}
