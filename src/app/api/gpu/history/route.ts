import { NextRequest, NextResponse } from "next/server";
import { parseGpuHours, queryGpuHistory } from "@/lib/gpu-data";

export async function GET(request: NextRequest) {
  const hours = parseGpuHours(request.nextUrl.searchParams.get("hours"));
  const hostname = request.nextUrl.searchParams.get("hostname") ?? "";

  try {
    const history = await queryGpuHistory(hours, hostname);
    const maxAge = hours >= 168 ? 300 : 60;
    const staleAge = hours >= 168 ? 1800 : 300;

    return NextResponse.json(history, {
      headers: {
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Vercel-CDN-Cache-Control": `public, s-maxage=${maxAge}, stale-while-revalidate=${staleAge}`,
      },
    });
  } catch (error) {
    console.error("GPU history query failed:", error);
    return NextResponse.json(
      { error: "Failed to query GPU history" },
      { status: 500 },
    );
  }
}
