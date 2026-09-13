import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  parseMainCiAlertUpdate,
  sameMainCiAlertUpdate,
} from "@/lib/main-ci-alert-updates";
import { bearerTokenMatches } from "@/lib/operator-auth";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";
import type { MainCiAlertUpdateKind } from "@/lib/alerts-main-ci";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 32 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

interface UpdateRow {
  update_id: string | number;
  alert_id: string | number;
  failure_job_id: string;
  kind: MainCiAlertUpdateKind;
  message: string;
  fix_prs: unknown;
  author: string;
  created_at: Date;
}

function responseUpdate(row: UpdateRow) {
  return {
    updateId: String(row.update_id),
    alertId: String(row.alert_id),
    failureJobId: row.failure_job_id,
    kind: row.kind,
    message: row.message,
    fixPrs: row.fix_prs,
    author: row.author,
    createdAt: row.created_at.toISOString(),
  };
}

async function readBodyWithLimit(request: Request) {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
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

/**
 * Appends one authenticated responder update to an exact Main CI failure
 * revision. The automated analysis remains worker-owned and untouched.
 */
export async function POST(request: Request) {
  const agentToken = process.env.ALERT_AGENT_TOKEN;
  if (!agentToken) {
    return NextResponse.json(
      { error: "Agent alert updates are not configured on this dashboard." },
      { status: 503, headers: NO_STORE },
    );
  }
  if (!bearerTokenMatches(request.headers.get("authorization"), agentToken)) {
    return NextResponse.json(
      { error: "Posting an alert update requires the configured agent token." },
      { status: 401, headers: NO_STORE },
    );
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType?.trim().toLowerCase() !== "application/json") {
    return NextResponse.json(
      { error: "Content-Type must be application/json." },
      { status: 415, headers: NO_STORE },
    );
  }
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    return NextResponse.json(
      { error: "Unsupported Content-Encoding." },
      { status: 415, headers: NO_STORE },
    );
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      return NextResponse.json(
        { error: "Invalid Content-Length." },
        { status: 400, headers: NO_STORE },
      );
    }
    if (declaredLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "Request body exceeds 32 KiB." },
        { status: 413, headers: NO_STORE },
      );
    }
  }

  let body: unknown;
  try {
    const rawBody = await readBodyWithLimit(request);
    if (rawBody === null) {
      return NextResponse.json(
        { error: "Request body exceeds 32 KiB." },
        { status: 413, headers: NO_STORE },
      );
    }
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON." },
      { status: 400, headers: NO_STORE },
    );
  }

  const parsed = parseMainCiAlertUpdate(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error },
      { status: 400, headers: NO_STORE },
    );
  }
  const input = parsed.value;

  try {
    const db = getDb();
    const fixPrsJson: Record<string, string | number | null>[] =
      input.fixPrs.map((pr) => ({
        number: pr.number,
        url: pr.url,
        title: pr.title,
      }));
    const inserted = await db<UpdateRow[]>`
      INSERT INTO alerting_main_ci_job_updates (
        alert_id, failure_job_id, kind, message, fix_prs, author,
        idempotency_key
      )
      SELECT a.alert_id, ${input.failureJobId}, ${input.kind}, ${input.message},
             ${db.json(fixPrsJson)}, ${input.author}, ${input.idempotencyKey}
      FROM alerting_main_ci_job_alerts AS a
      WHERE a.alert_id = ${input.alertId}
        AND a.last_failure_job_id = ${input.failureJobId}
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING update_id, alert_id, failure_job_id, kind, message, fix_prs,
                author, created_at
    `;
    if (inserted.length > 0) {
      return NextResponse.json(
        { ok: true, duplicate: false, update: responseUpdate(inserted[0]) },
        { status: 201, headers: NO_STORE },
      );
    }

    // A retry of the same logical request is successful even when the alert
    // has advanced since the first insert. Reusing the key for different
    // content is a conflict, never an implicit overwrite.
    const existing = await db<UpdateRow[]>`
      SELECT update_id, alert_id, failure_job_id, kind, message, fix_prs,
             author, created_at
      FROM alerting_main_ci_job_updates
      WHERE idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;
    if (existing.length > 0) {
      if (!sameMainCiAlertUpdate(existing[0], input)) {
        return NextResponse.json(
          {
            code: "idempotency_conflict",
            error: "idempotencyKey was already used for different content.",
          },
          { status: 409, headers: NO_STORE },
        );
      }
      return NextResponse.json(
        { ok: true, duplicate: true, update: responseUpdate(existing[0]) },
        { headers: NO_STORE },
      );
    }

    const alerts = await db<{ last_failure_job_id: string }[]>`
      SELECT last_failure_job_id
      FROM alerting_main_ci_job_alerts
      WHERE alert_id = ${input.alertId}
      LIMIT 1
    `;
    if (alerts.length === 0) {
      return NextResponse.json(
        { code: "alert_not_found", error: "Alert does not exist." },
        { status: 404, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      {
        code: "stale_failure_revision",
        error: "failureJobId is not the alert's latest failure revision.",
        currentFailureJobId: alerts[0].last_failure_job_id,
      },
      { status: 409, headers: NO_STORE },
    );
  } catch (error) {
    if (hasPostgresErrorCode(error, "42P01")) {
      return NextResponse.json(
        { error: "Main CI alert updates schema is not deployed yet." },
        { status: 503, headers: NO_STORE },
      );
    }
    console.error("Failed to append Main CI alert update:", error);
    return NextResponse.json(
      { error: "Main CI alert update could not be saved." },
      { status: 500, headers: NO_STORE },
    );
  }
}
