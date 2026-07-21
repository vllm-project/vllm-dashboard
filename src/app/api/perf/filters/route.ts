import { NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";
import {
  perfDataStartCondition,
  resolvePerfDataStartDate,
} from "@/lib/perf-data";

const TTL = 300_000;

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(s);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const startDate = resolvePerfDataStartDate(searchParams.get("start"));
    const end = searchParams.get("end");

    const cacheKey = `perf:filters:${startDate}:${end}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    const conditions = [
      "message:model IS NOT NULL",
      perfDataStartCondition(startDate),
    ];
    if (end && isIsoDate(end)) {
      conditions.push(`message:date::STRING <= '${end.slice(0, 10)}'`);
    }

    const where = conditions.join(" AND ");

    // Per-model datapoint counts, so the UI can sort models by how much data
    // they have (and show the count). Other dims come from a DISTINCT scan.
    const [modelRows, dimRows] = await Promise.all([
      queryDatabricks<{ model: string; n: number }>(`
        SELECT message:model::STRING AS model, COUNT(*) AS n
        FROM vllm_data_warehouse.default.vllm_perf_data_ingest
        WHERE ${where}
        GROUP BY message:model::STRING
      `),
      queryDatabricks<{
        device: string;
        tp: string;
        conc: string;
        precision: string;
        image: string;
      }>(`
        SELECT DISTINCT
          message:device::STRING AS device,
          message:tp::STRING AS tp,
          message:conc::STRING AS conc,
          message:precision::STRING AS precision,
          message:image::STRING AS image
        FROM vllm_data_warehouse.default.vllm_perf_data_ingest
        WHERE ${where}
      `),
    ]);

    const modelCounts: Record<string, number> = {};
    for (const r of modelRows) {
      if (r.model) modelCounts[r.model] = Number(r.n) || 0;
    }
    // Most data first; alphabetical as a tiebreak.
    const models = Object.keys(modelCounts).sort(
      (a, b) => modelCounts[b] - modelCounts[a] || a.localeCompare(b)
    );
    const devices = [...new Set(dimRows.map((r) => r.device).filter(Boolean))].sort();
    const tps = [...new Set(dimRows.map((r) => r.tp).filter(Boolean))].sort((a, b) => +a - +b);
    const concs = [...new Set(dimRows.map((r) => r.conc).filter(Boolean))].sort((a, b) => +a - +b);
    const precisions = [...new Set(dimRows.map((r) => r.precision).filter(Boolean))].sort();
    const images = [...new Set(dimRows.map((r) => r.image).filter(Boolean))].sort();

    const result = { models, modelCounts, devices, tps, concs, precisions, images };
    setCache(cacheKey, result, TTL);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch perf filters:", error);
    return NextResponse.json({ error: "Failed to fetch filters" }, { status: 500 });
  }
}
