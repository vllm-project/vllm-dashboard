import { NextResponse } from "next/server";
import { queryGpuHostAgents } from "@/lib/gpu-data";

export async function GET() {
  try {
    const hosts = await queryGpuHostAgents();
    return NextResponse.json(
      { hosts, checked_at: new Date().toISOString() },
      {
        headers: {
          "Cache-Control": "public, max-age=0, must-revalidate",
          "Vercel-CDN-Cache-Control": "public, s-maxage=15, must-revalidate",
        },
      },
    );
  } catch (error) {
    console.error("GPU host agents query failed:", error);
    return NextResponse.json(
      { error: "Failed to query GPU host agents" },
      { status: 500 },
    );
  }
}
