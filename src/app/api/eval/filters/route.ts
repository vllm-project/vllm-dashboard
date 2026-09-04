import { NextResponse } from "next/server";
import { resolveEvalImage } from "@/lib/eval-images";
import { queryDatabricks } from "@/lib/databricks";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";

interface RawRow {
  m: string;
  d: number | null;
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
const CDN_CACHE = { maxAge: 600, staleWhileRevalidate: 86_400 };

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
    if (cached) return cachedJson(cached, CDN_CACHE);

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
      SELECT CAST(message AS STRING) AS m,
        COALESCE(message:date::DOUBLE, message:data:date::DOUBLE) AS d
      FROM vllm_data_warehouse.default.vllm_eval_data_ingest
      WHERE ${conditions.join(" AND ")}
    `);

    const models = new Set<string>();
    const tasks = new Set<string>();
    const filters = new Set<string>();
    const metrics = new Set<string>();
    const images = new Set<string>();
    const imageEpochs = new Map<string, number>();
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
        const epoch = Number(r.d);
        imageLookups.push(
          resolveEvalImage(raw, core, taskName).then((image) => {
            if (!image) return;
            images.add(image);
            if (Number.isFinite(epoch) && epoch > (imageEpochs.get(image) ?? 0)) {
              imageEpochs.set(image, epoch);
            }
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

    const imageDates: Record<string, string> = {};
    for (const [image, epoch] of imageEpochs) {
      imageDates[image] = new Date(epoch * 1000).toISOString();
    }

    const result = {
      models: [...models].sort(),
      tasks: [...tasks].sort(),
      images: [...images].sort(),
      imageDates,
      filters: [...filters].sort(),
      metrics: [...metrics].sort(),
    };
    setCache(cacheKey, result, TTL);

    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch eval filters:", error);
    return NextResponse.json(
      { error: "Failed to fetch eval filters" },
      { status: 500 }
    );
  }
}
