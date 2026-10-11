import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { bearerTokenMatches } from "@/lib/operator-auth";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";

/** What an operator action answers: an HTTP status and a JSON body. */
type ActionResult = { status: number; body: Record<string, unknown> };
export type Db = ReturnType<typeof getDb>;

const noStore = { "Cache-Control": "no-store" };

export const fail = (status: number, error: string): ActionResult => ({
  status,
  body: { error },
});

/**
 * Shell for the quarantine and incident POST endpoints, with the same auth as
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

// Max lengths mirror the CHECK constraints in migration 0030.
export const MAX_BY = 80;
export const MAX_REASON = 500;
export const MAX_CAUSE = 500;
export const MAX_MATCH = 200;

/**
 * Closes the host's open pilot record (would, live or held). A hand cordon or
 * pause ('manual' row) is not ours to lift: undoing it by hand closes its
 * record. A host with only closed records is a 409, one never seen a 404. The
 * worker and the control-plane timers lift the pause or taint from the record.
 */
export async function returnQuarantine(
  db: Db,
  host: string,
  by: string,
  reason: string,
): Promise<ActionResult> {
  const closed = await db<{ record_id: string }[]>`
    UPDATE alerting_quarantine_records
    SET state = 'closed',
        closed_at = now(),
        closed_by = ${by},
        close_how = 'returned',
        close_reason = ${reason},
        updated_at = now()
    WHERE host = ${host} AND state IN ('would', 'live', 'held')
    RETURNING record_id
  `;
  if (closed.length > 0) {
    return { status: 200, body: { ok: true, recordId: Number(closed[0].record_id) } };
  }
  const [{ manual }] = await db<{ manual: boolean | null }[]>`
    SELECT bool_or(state = 'manual') AS manual
    FROM alerting_quarantine_records
    WHERE host = ${host}
  `;
  if (manual === null) return fail(404, "No quarantine record exists for this host.");
  return manual
    ? fail(409, "Host is cordoned or paused by hand; undo that by hand to return it.")
    : fail(409, "Host has no open quarantine; it is already returned.");
}

/** Moves a suspected incident to confirmed, recording cause and match. */
export async function confirmIncident(
  db: Db,
  id: number,
  by: string,
  cause: string,
  match: string,
): Promise<ActionResult> {
  const rows = await db`
    UPDATE alerting_incidents
    SET state = 'confirmed',
        cause = ${cause},
        match = ${match},
        confirmed_by = ${by},
        confirmed_at = now(),
        updated_at = now()
    WHERE incident_id = ${id} AND state = 'suspected'
    RETURNING incident_id
  `;
  if (rows.length > 0) return { status: 200, body: { ok: true } };
  return incidentMiss(db, id, "confirm");
}

/**
 * Closes a confirmed incident, ending its window now. A suspected incident
 * cannot be closed by a person: it self-closes, or is confirmed first.
 */
export async function closeIncident(
  db: Db,
  id: number,
  by: string,
): Promise<ActionResult> {
  const rows = await db`
    UPDATE alerting_incidents
    SET state = 'closed',
        closed_by = ${by},
        closed_at = now(),
        window_end = now(),
        updated_at = now()
    WHERE incident_id = ${id} AND state = 'confirmed'
    RETURNING incident_id
  `;
  if (rows.length > 0) return { status: 200, body: { ok: true } };
  return incidentMiss(db, id, "close");
}

async function incidentMiss(
  db: Db,
  id: number,
  action: "confirm" | "close",
): Promise<ActionResult> {
  const rows = await db<{ state: string }[]>`
    SELECT state FROM alerting_incidents WHERE incident_id = ${id}
  `;
  if (rows.length === 0) return fail(404, "Incident does not exist.");
  const { state } = rows[0];
  const hint =
    state === "suspected"
      ? "Confirm it first; an unconfirmed suspicion closes itself."
      : "";
  return fail(409, `Cannot ${action} an incident that is ${state}. ${hint}`.trim());
}
