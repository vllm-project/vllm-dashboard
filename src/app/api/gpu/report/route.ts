import { NextRequest, NextResponse } from "next/server";
import { getDb, initSchema } from "@/lib/db";

let schemaInitialized = false;

interface GpuReport {
  hostname: string;
  gpus: Array<{
    index: number;
    name?: string;
    gpu_util: number;
    mem_used_mb: number;
    mem_total_mb: number;
    temperature_c?: number;
    power_draw_w?: number;
    power_limit_w?: number;
  }>;
}

export async function POST(request: NextRequest) {
  const secret = process.env.GPU_REPORT_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const body: GpuReport = await request.json();

    if (!body.hostname || !Array.isArray(body.gpus) || body.gpus.length === 0) {
      return NextResponse.json(
        { error: "Invalid payload: need hostname and gpus array" },
        { status: 400 },
      );
    }

    const db = getDb();

    if (!schemaInitialized) {
      await initSchema();
      schemaInitialized = true;
    }

    const now = new Date();

    for (const gpu of body.gpus) {
      await db`
        INSERT INTO gpu_snapshots (
          reported_at, hostname, gpu_index, gpu_name,
          gpu_util, mem_used_mb, mem_total_mb,
          temperature_c, power_draw_w, power_limit_w
        ) VALUES (
          ${now}, ${body.hostname}, ${gpu.index}, ${gpu.name ?? null},
          ${gpu.gpu_util}, ${gpu.mem_used_mb}, ${gpu.mem_total_mb},
          ${gpu.temperature_c ?? null}, ${gpu.power_draw_w ?? null}, ${gpu.power_limit_w ?? null}
        )
      `;
    }

    return NextResponse.json({
      ok: true,
      hostname: body.hostname,
      gpus: body.gpus.length,
      reported_at: now.toISOString(),
    });
  } catch (error) {
    console.error("GPU report failed:", error);
    return NextResponse.json(
      { error: "Failed to store GPU report" },
      { status: 500 },
    );
  }
}
