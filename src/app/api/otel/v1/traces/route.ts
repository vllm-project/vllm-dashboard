import { gunzipSync } from "node:zlib";
import { NextRequest, NextResponse } from "next/server";
import {
  authorizeOtlpRequest,
  isOtlpConfigured,
  spansMatchPrincipal,
} from "@/lib/otel-auth";
import { decodeOtlpTraceRequest } from "@/lib/otel-proto";
import { storeOtlpSpans } from "@/lib/otel-storage";

export const runtime = "nodejs";

const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;

function maxRequestBytes(): number {
  const configured = Number(process.env.OTEL_MAX_REQUEST_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_REQUEST_BYTES;
}

function protobufResponse() {
  return new NextResponse(new Uint8Array(), {
    status: 200,
    headers: { "Content-Type": "application/x-protobuf" },
  });
}

export async function POST(request: NextRequest) {
  if (!isOtlpConfigured()) {
    return NextResponse.json(
      { error: "OTLP ingestion is not configured" },
      { status: 503 },
    );
  }
  const principal = await authorizeOtlpRequest(request.headers);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/x-protobuf") {
    return NextResponse.json(
      { error: "Content-Type must be application/x-protobuf" },
      { status: 415 },
    );
  }

  const limit = maxRequestBytes();
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let spans;
  try {
    let payload = Buffer.from(await request.arrayBuffer());
    if (payload.byteLength > limit) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    const contentEncoding = request.headers.get("content-encoding");
    if (contentEncoding === "gzip") {
      payload = gunzipSync(payload, { maxOutputLength: limit });
    } else if (contentEncoding && contentEncoding !== "identity") {
      return NextResponse.json(
        { error: "Unsupported Content-Encoding" },
        { status: 415 },
      );
    }

    spans = decodeOtlpTraceRequest(payload);
    if (!spansMatchPrincipal(spans, principal)) {
      return NextResponse.json(
        { error: "Span identity does not match OIDC claims" },
        { status: 403 },
      );
    }
  } catch (error) {
    console.error("Invalid OTLP trace request:", error);
    return NextResponse.json(
      { error: "Invalid OTLP trace request" },
      { status: 400 },
    );
  }

  try {
    await storeOtlpSpans(spans);
    return protobufResponse();
  } catch (error) {
    // OTLP exporters retry 503 responses. A database or server failure is not
    // a bad payload and must not be reported as a permanent 4xx rejection.
    console.error("OTLP trace storage failed:", error);
    return NextResponse.json(
      { error: "OTLP storage is temporarily unavailable" },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
}
