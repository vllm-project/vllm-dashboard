import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { bearerTokenMatches } from "@/lib/operator-auth";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";

/** What an operator action answers: an HTTP status and a JSON body. */
export type ActionResult = { status: number; body: Record<string, unknown> };
export type Db = ReturnType<typeof getDb>;

const noStore = { "Cache-Control": "no-store" };

export const fail = (status: number, error: string): ActionResult => ({
  status,
  body: { error },
});

/**
 * Shared shell for the operator-token POST endpoints, with the same auth as
 * the Main CI resolve route: 503 when ALERT_OPERATOR_TOKEN is not configured,
 * 401 when the bearer token is missing or wrong, checked before the body is
 * read. `run` validates the JSON object and writes the record; it receives
 * `getDb` unevaluated so that validation failures never touch the database.
 */
export async function operatorPost(
  request: Request,
  label: string,
  run: (body: Record<string, unknown>, db: () => Db) => Promise<ActionResult>,
): Promise<NextResponse> {
  const respond = ({ status, body }: ActionResult) =>
    NextResponse.json(body, { status, headers: noStore });

  const operatorToken = process.env.ALERT_OPERATOR_TOKEN;
  if (!operatorToken) {
    return respond(fail(503, `${label} is not configured on this dashboard.`));
  }
  if (!bearerTokenMatches(request.headers.get("authorization"), operatorToken)) {
    return respond(
      fail(401, `${label} requires the configured operator token.`),
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(fail(400, "Request body must be JSON."));
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return respond(fail(400, "Request body must be a JSON object."));
  }

  try {
    return respond(await run(body as Record<string, unknown>, getDb));
  } catch (error) {
    // A preview deployment can exist before the migration has been applied.
    if (hasPostgresErrorCode(error, "42P01")) {
      return respond(fail(503, "Quarantine schema is not deployed yet."));
    }
    console.error(`${label} failed:`, error);
    return respond(fail(500, `${label} failed.`));
  }
}

/** A trimmed string field of 1..max characters, or null when invalid. */
export function textField(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string | null {
  const value = body[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}
