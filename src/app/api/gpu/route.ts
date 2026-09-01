import { NextRequest, NextResponse } from "next/server";
import {
  parseGpuHours,
  queryGpuHistory,
  queryGpuLatest,
} from "@/lib/gpu-data";
export type GpuQuery = {
  hours?: number; // Clamped to 1-720, non-numeric falls back to 24 (default 24)
  hostname?: string;
};

/**
 * Get GPU metrics (legacy combined endpoint)
 * @description History plus latest per-GPU readings in one response; kept for backward compatibility, superseded by `/api/gpu/history` and `/api/gpu/latest`.
 * @params GpuQuery
 * @tag GPU
 * @openapi
 */
export async function GET(request: NextRequest) {
  const hours = parseGpuHours(request.nextUrl.searchParams.get("hours"));
  const hostname = request.nextUrl.searchParams.get("hostname") ?? "";

  try {
    const [history, latest] = await Promise.all([
      queryGpuHistory(hours, hostname),
      queryGpuLatest(),
    ]);
    const maxAge = hours >= 168 ? 300 : 60;
    const staleAge = hours >= 168 ? 1800 : 300;

    return NextResponse.json(
      { ...history, latest },
      {
        headers: {
          "Cache-Control": "public, max-age=0, must-revalidate",
          "Vercel-CDN-Cache-Control": `public, s-maxage=${maxAge}, stale-while-revalidate=${staleAge}`,
        },
      },
    );
  } catch (error) {
    console.error("GPU metrics query failed:", error);
    return NextResponse.json(
      { error: "Failed to query GPU metrics" },
      { status: 500 },
    );
  }
}
