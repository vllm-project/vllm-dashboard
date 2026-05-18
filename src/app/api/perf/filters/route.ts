import { NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";

const TTL = 300_000;

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");

    const cacheKey = `perf:filters:${start}:${end}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    const conditions = ["message:model IS NOT NULL"];
    if (start && isIsoDate(start)) {
      conditions.push(`message:date::STRING >= '${start.slice(0, 10)}'`);
    }
    if (end && isIsoDate(end)) {
      conditions.push(`message:date::STRING <= '${end.slice(0, 10)}'`);
    }

    const rows = await queryDatabricks<{
      model: string;
      device: string;
      tp: string;
      conc: string;
      precision: string;
      image: string;
    }>(`
      SELECT DISTINCT
        message:model::STRING AS model,
        message:device::STRING AS device,
        message:tp::STRING AS tp,
        message:conc::STRING AS conc,
        message:precision::STRING AS precision,
        message:image::STRING AS image
      FROM vllm_data_warehouse.default.vllm_perf_data_ingest
      WHERE ${conditions.join(" AND ")}
      ORDER BY model, device
    `);

    const models = [...new Set(rows.map((r) => r.model).filter(Boolean))].sort();
    const devices = [...new Set(rows.map((r) => r.device).filter(Boolean))].sort();
    const tps = [...new Set(rows.map((r) => r.tp).filter(Boolean))].sort((a, b) => +a - +b);
    const concs = [...new Set(rows.map((r) => r.conc).filter(Boolean))].sort((a, b) => +a - +b);
    const precisions = [...new Set(rows.map((r) => r.precision).filter(Boolean))].sort();
    const images = [...new Set(rows.map((r) => r.image).filter(Boolean))].sort();

    const result = { models, devices, tps, concs, precisions, images };
    setCache(cacheKey, result, TTL);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch perf filters:", error);
    return NextResponse.json({ error: "Failed to fetch filters" }, { status: 500 });
  }
}
