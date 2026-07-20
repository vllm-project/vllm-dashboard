import { NextResponse } from "next/server";
import { queryGpuLatest } from "@/lib/gpu-data";

export async function GET() {
  try {
    const latest = await queryGpuLatest();
    return NextResponse.json(
      { latest, checked_at: new Date().toISOString() },
      {
        headers: {
          "Cache-Control": "public, max-age=0, must-revalidate",
          // Current GPU state is cheap to query and should never spend minutes
          // in stale-while-revalidate. A short shared cache still absorbs
          // bursts, then the next request waits for a confirmed fresh result.
          "Vercel-CDN-Cache-Control": "public, s-maxage=15, must-revalidate",
        },
      },
    );
  } catch (error) {
    console.error("Latest GPU query failed:", error);
    return NextResponse.json(
      { error: "Failed to query current GPU state" },
      { status: 500 },
    );
  }
}
