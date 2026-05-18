import { NextResponse } from "next/server";
import { resolveEvalImage } from "@/lib/eval-images";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";

interface RawRow {
  m: string;
}

interface LmEvalCore {
  config?: { model_args?: { model?: string } };
  configs?: Record<string, Record<string, unknown>>;
  results?: Record<string, Record<string, unknown>>;
  date?: number;
}

interface LmEvalMessage extends LmEvalCore {
  data?: LmEvalCore;
  workload?: string;
  source_file?: string;
  buildkite_commit?: string;
  [key: string]: unknown;
}

function parseDateParam(s: string | null): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

const TTL = 300_000;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const startEpoch = parseDateParam(searchParams.get("start"));
    let endEpoch = parseDateParam(searchParams.get("end"));
    // If end is a bare YYYY-MM-DD it parses to midnight UTC; bump to end-of-day so the day is inclusive.
    const endRaw = searchParams.get("end");
    if (endEpoch !== null && endRaw && /^\d{4}-\d{2}-\d{2}$/.test(endRaw)) {
      endEpoch += 24 * 3600 - 1;
    }

    const cacheKey = `eval:filters:${searchParams.get("start")}:${searchParams.get("end")}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    const conditions = [
      "(message:results IS NOT NULL OR message:data:results IS NOT NULL)",
    ];
    if (startEpoch !== null) {
      conditions.push(
        `COALESCE(message:date::DOUBLE, message:data:date::DOUBLE) >= ${startEpoch}`
      );
    }
    if (endEpoch !== null) {
      conditions.push(
        `COALESCE(message:date::DOUBLE, message:data:date::DOUBLE) <= ${endEpoch}`
      );
    }

    const rawRows = await queryDatabricks<RawRow>(`
      SELECT CAST(message AS STRING) AS m
      FROM vllm_data_warehouse.default.vllm_eval_data_ingest
      WHERE ${conditions.join(" AND ")}
    `);

    const models = new Set<string>();
    const tasks = new Set<string>();
    const filters = new Set<string>();
    const metrics = new Set<string>();
    const images = new Set<string>();
    const imageLookups: Promise<void>[] = [];

    for (const r of rawRows) {
      let raw: LmEvalMessage;
      try {
        raw = JSON.parse(r.m);
      } catch {
        continue;
      }
      const core: LmEvalCore = raw.data ?? raw;
      if (!core?.results) continue;
      const modelName = core.config?.model_args?.model;
      if (modelName) models.add(modelName);
      for (const taskName of Object.keys(core.results)) {
        tasks.add(taskName);
        imageLookups.push(
          resolveEvalImage(raw, core, taskName).then((image) => {
            if (image) images.add(image);
          })
        );
        for (const key of Object.keys(core.results[taskName])) {
          if (key === "alias") continue;
          const match = key.match(/^(.+?)(?:_stderr)?,(.+)$/);
          if (match) {
            metrics.add(match[1]);
            filters.add(match[2]);
          }
        }
      }
    }

    await Promise.all(imageLookups);

    const result = {
      models: [...models].sort(),
      tasks: [...tasks].sort(),
      images: [...images].sort(),
      filters: [...filters].sort(),
      metrics: [...metrics].sort(),
    };
    setCache(cacheKey, result, TTL);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch eval filters:", error);
    return NextResponse.json(
      { error: "Failed to fetch eval filters" },
      { status: 500 }
    );
  }
}
