import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";

const TTL = 60_000;

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const model = sp.get("model");
    const device = sp.get("device");
    const tp = sp.get("tp");
    const conc = sp.get("conc");

    const cacheKey = `perf:${model}:${device}:${tp}:${conc}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    const conditions = ["message:model IS NOT NULL"];
    if (model) conditions.push(`message:model::STRING = '${model.replace(/'/g, "''")}'`);
    if (device) conditions.push(`message:device::STRING = '${device.replace(/'/g, "''")}'`);
    if (tp) conditions.push(`message:tp::INT = ${parseInt(tp, 10)}`);
    if (conc) conditions.push(`message:conc::INT = ${parseInt(conc, 10)}`);

    const where = conditions.join(" AND ");

    const rows = await queryDatabricks(`
      SELECT
        message:date::STRING AS date,
        message:model::STRING AS model,
        message:device::STRING AS device,
        message:tp::INT AS tp,
        message:conc::INT AS conc,
        message:isl::INT AS isl,
        message:osl::INT AS osl,
        message:precision::STRING AS precision,
        message:image::STRING AS image,
        message:tput_per_gpu::DOUBLE AS tput_per_gpu,
        message:input_tput_per_gpu::DOUBLE AS input_tput_per_gpu,
        message:output_tput_per_gpu::DOUBLE AS output_tput_per_gpu,
        message:mean_ttft::DOUBLE AS mean_ttft,
        message:mean_tpot::DOUBLE AS mean_tpot,
        message:mean_itl::DOUBLE AS mean_itl,
        message:mean_e2el::DOUBLE AS mean_e2el,
        message:p99_ttft::DOUBLE AS p99_ttft,
        message:p99_tpot::DOUBLE AS p99_tpot,
        message:p99_itl::DOUBLE AS p99_itl,
        message:p99_e2el::DOUBLE AS p99_e2el,
        message:median_ttft::DOUBLE AS median_ttft,
        message:median_tpot::DOUBLE AS median_tpot,
        message:median_itl::DOUBLE AS median_itl,
        message:median_e2el::DOUBLE AS median_e2el
      FROM vllm_data_warehouse.default.vllm_perf_data_ingest
      WHERE ${where}
      ORDER BY message:date::STRING ASC, message:conc::INT ASC
    `);

    const result = { rows };
    setCache(cacheKey, result, TTL);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch perf data:", error);
    return NextResponse.json({ error: "Failed to fetch performance data" }, { status: 500 });
  }
}
