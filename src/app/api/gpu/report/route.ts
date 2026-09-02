import { NextRequest, NextResponse } from "next/server";
import {
  GpuReportValidationError,
  gpuReportAuthResult,
  gpuReportMaxBytes,
  parseGpuReportJson,
} from "@/lib/gpu-report";
import { storeGpuReport } from "@/lib/gpu-report-storage";

export const runtime = "nodejs";

async function readBodyWithLimit(request: NextRequest, limit: number) {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request: NextRequest) {
  const auth = gpuReportAuthResult(
    process.env.GPU_REPORT_SECRET,
    request.headers.get("authorization"),
  );
  if (auth === "not-configured") {
    return NextResponse.json(
      { error: "GPU report ingestion is not configured" },
      { status: 503 },
    );
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType?.trim().toLowerCase() !== "application/json") {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    return NextResponse.json(
      { error: "Unsupported Content-Encoding" },
      { status: 415 },
    );
  }

  const limit = gpuReportMaxBytes(process.env.GPU_REPORT_MAX_BYTES);
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      return NextResponse.json(
        { error: "Invalid Content-Length" },
        { status: 400 },
      );
    }
    if (declaredLength > limit) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
  }

  let report;
  try {
    const payload = await readBodyWithLimit(request, limit);
    if (payload === null) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    report = parseGpuReportJson(payload);
  } catch (error) {
    if (error instanceof GpuReportValidationError) {
      return NextResponse.json(
        { error: "Invalid GPU report", detail: error.message },
        { status: 400 },
      );
    }
    console.error("Failed to read GPU report:", error);
    return NextResponse.json(
      { error: "Invalid GPU report" },
      { status: 400 },
    );
  }

  try {
    const { reportedAt } = await storeGpuReport(report);
    return NextResponse.json({
      ok: true,
      hostname: report.hostname,
      gpus: report.gpus.length,
      host: report.host !== null,
      reporter_status: report.reporter_status,
      reported_at: reportedAt.toISOString(),
    });
  } catch (error) {
    console.error("GPU report storage failed:", error);
    return NextResponse.json(
      { error: "GPU report storage is temporarily unavailable" },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
}
