import { NextResponse } from "next/server";
import { queryGpuLatest } from "@/lib/gpu-data";

export async function GET() {
  try {
    const latest = await queryGpuLatest();
    return NextResponse.json(
      { latest },
      {
        headers: {
          "Cache-Control": "public, max-age=0, must-revalidate",
          "Vercel-CDN-Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
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
