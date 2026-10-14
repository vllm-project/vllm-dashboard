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

// Max lengths mirror the CHECK constraints in migration 0030 (by, cause,
// match); the quarantine resolve reason is held to the same 500.
export const MAX_BY = 80;
export const MAX_REASON = 500;
export const MAX_CAUSE = 500;
export const MAX_MATCH = 200;

/**
 * Resolves a host's open quarantine episode (alert type 'quarantine' in
 * alerting_infra_alerts) by moving its stage to 'resolving'. The episode stays
 * open: the actuator undoes its cordon and taint or lock file, and the worker
 * marks it resolved once the host is back. A dry-run ('would') episode has
 * nothing to undo, so it is a 409, as is one already resolving or resolved;
 * a host never quarantined is a 404.
 */
export async function resolveQuarantine(
  db: Db,
  host: string,
  by: string,
  reason: string,
): Promise<ActionResult> {
  const resolved = await db<{ alert_id: string }[]>`
    UPDATE alerting_infra_alerts
    SET details = details || jsonb_build_object(
          'stage', 'resolving',
          'resolved_by', ${by}::text,
          'resolve_reason', ${reason}::text,
          'resolve_requested_at', now()
        ),
        updated_at = now()
    WHERE alert_type = 'quarantine'
      AND subject_key = ${host}
      AND status = 'open'
      AND details->>'stage' IN ('held', 'quarantining', 'quarantined')
    RETURNING alert_id
  `;
  if (resolved.length > 0) {
    return { status: 200, body: { ok: true, alertId: Number(resolved[0].alert_id) } };
  }
  const latest = await db<{ stage: string | null }[]>`
    SELECT details->>'stage' AS stage
    FROM alerting_infra_alerts
    WHERE alert_type = 'quarantine' AND subject_key = ${host}
    ORDER BY opened_at DESC
    LIMIT 1
  `;
  if (latest.length === 0) return fail(404, "This host has never been quarantined.");
  const { stage } = latest[0];
  if (stage === "would") {
    return fail(409, "This is a dry-run quarantine; nothing was applied to resolve.");
  }
  if (stage === "resolving") {
    return fail(409, "This quarantine is already being resolved.");
  }
  return fail(409, "This host has no open quarantine; it is already resolved.");
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
