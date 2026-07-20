import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

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
    const now = new Date();
    const bucket = new Date(Math.floor(now.getTime() / 300_000) * 300_000);
    const snapshots = body.gpus.map((gpu) => ({
      reported_at: now,
      hostname: body.hostname,
      gpu_index: gpu.index,
      gpu_name: gpu.name ?? null,
      gpu_util: gpu.gpu_util,
      mem_used_mb: gpu.mem_used_mb,
      mem_total_mb: gpu.mem_total_mb,
      temperature_c: gpu.temperature_c ?? null,
      power_draw_w: gpu.power_draw_w ?? null,
      power_limit_w: gpu.power_limit_w ?? null,
    }));

    const rollupsByName = new Map<string, { memPctSum: number; count: number }>();
    for (const gpu of body.gpus) {
      const name = gpu.name ?? "Unknown";
      const current = rollupsByName.get(name) ?? { memPctSum: 0, count: 0 };
      current.memPctSum += gpu.mem_total_mb > 0
        ? (gpu.mem_used_mb / gpu.mem_total_mb) * 100
        : 0;
      current.count += 1;
      rollupsByName.set(name, current);
    }
    const rollups = [...rollupsByName.entries()].map(([gpuName, values]) => ({
      time_bucket: bucket,
      hostname: body.hostname,
      gpu_name: gpuName,
      mem_pct_sum: values.memPctSum,
      sample_count: values.count,
    }));

    await db.begin(async (transaction) => {
      // postgres.js' TransactionSql type omits call signatures even though the
      // runtime transaction object is the same callable tagged-template API.
      const tx = transaction as unknown as typeof db;
      await tx`
        INSERT INTO gpu_snapshots ${tx(
          snapshots,
          "reported_at",
          "hostname",
          "gpu_index",
          "gpu_name",
          "gpu_util",
          "mem_used_mb",
          "mem_total_mb",
          "temperature_c",
          "power_draw_w",
          "power_limit_w",
        )}
      `;
      await tx`
        INSERT INTO gpu_history_5m ${tx(
          rollups,
          "time_bucket",
          "hostname",
          "gpu_name",
          "mem_pct_sum",
          "sample_count",
        )}
        ON CONFLICT (time_bucket, hostname, gpu_name) DO UPDATE SET
          mem_pct_sum = gpu_history_5m.mem_pct_sum + EXCLUDED.mem_pct_sum,
          sample_count = gpu_history_5m.sample_count + EXCLUDED.sample_count
      `;
    });

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
