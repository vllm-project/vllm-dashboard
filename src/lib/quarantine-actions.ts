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
export function operatorPost(
  request: Request,
  label: string,
  run: (body: Record<string, unknown>, db: () => Db) => Promise<ActionResult>,
): Promise<NextResponse> {
  return securedCall(request, label, "ALERT_OPERATOR_TOKEN", "operator token", run);
}

/**
 * The same shell for the quarantine actuators on the control planes and
 * bare-metal hosts, which authenticate with the GPU reporters' existing
 * GPU_REPORT_SECRET, as /api/gpu/report does. A GET has no body; `run`
 * receives an empty object.
 */
export function actuatorCall(
  request: Request,
  label: string,
  run: (body: Record<string, unknown>, db: () => Db) => Promise<ActionResult>,
): Promise<NextResponse> {
  return securedCall(request, label, "GPU_REPORT_SECRET", "reporter secret", run);
}

async function securedCall(
  request: Request,
  label: string,
  secretEnv: string,
  secretName: string,
  run: (body: Record<string, unknown>, db: () => Db) => Promise<ActionResult>,
): Promise<NextResponse> {
  const respond = ({ status, body }: ActionResult) =>
    NextResponse.json(body, { status, headers: noStore });

  const secret = process.env[secretEnv];
  if (!secret) {
    return respond(fail(503, `${label} is not configured on this dashboard.`));
  }
  if (!bearerTokenMatches(request.headers.get("authorization"), secret)) {
    return respond(fail(401, `${label} requires the configured ${secretName}.`));
  }

  let body: unknown = {};
  if (request.method !== "GET") {
    try {
      body = await request.json();
    } catch {
      return respond(fail(400, "Request body must be JSON."));
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return respond(fail(400, "Request body must be a JSON object."));
    }
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
 * alerting_infra_alerts) by moving its stage to 'resolve_requested'. The
 * episode stays open: the worker waits for a fresh reading taken after the
 * request and sends it back to quarantined if a trigger still fires, else
 * moves it to 'resolving'. `force` skips that wait and goes straight to
 * 'resolving', as does a held episode: its host never went out, and its
 * trigger is usually still firing, so the wait would take it out past the
 * limit that held it. A resolve already waiting can only be forced, for when
 * the reading never comes (a dead reporter). The actuator then runs its return check, undoes its cordon and
 * taint or lock file, and the worker marks it resolved once the host is back. It
 * clears the last actuator report and return-check failure, so a check that
 * failed before doesn't send this resolve straight back to quarantined. A dry-run ('would') episode has
 * nothing to undo, so it is a 409, as is one already resolving or resolved;
 * a host never quarantined is a 404.
 */
export async function resolveQuarantine(
  db: Db,
  host: string,
  by: string,
  reason: string,
  force = false,
): Promise<ActionResult> {
  const resolved = await db<{ alert_id: string }[]>`
    UPDATE alerting_infra_alerts
    SET details = details || jsonb_build_object(
          'stage', CASE
            WHEN ${force}::boolean OR details->>'stage' = 'held' THEN 'resolving'
            ELSE 'resolve_requested'
          END,
          'resolve_forced', ${force}::boolean,
          'resolved_by', ${by}::text,
          'resolve_reason', ${reason}::text,
          'resolve_requested_at', now(),
          'resolving_at', NULL::text,
          'actuator_state', NULL::text,
          'verify_note', NULL::text,
          'verify_check', NULL::text
        ),
        updated_at = now()
    WHERE alert_type = 'quarantine'
      AND subject_key = ${host}
      AND status = 'open'
      AND (
        details->>'stage' IN ('held', 'quarantining', 'quarantined')
        OR (${force}::boolean AND details->>'stage' = 'resolve_requested')
      )
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
  if (stage === "resolve_requested") {
    return fail(
      409,
      "This resolve is already waiting for a clean reading; skip the check to return it now.",
    );
  }
  if (stage === "resolving") {
    return fail(409, "This quarantine is already being resolved.");
  }
  return fail(409, "This host has no open quarantine; it is already resolved.");
}

/** Episode stages an actuator acts on; it only logs 'would'. */
const ACTUATED_STAGES = [
  "would",
  "quarantining",
  "quarantined",
  "resolve_requested",
  "resolving",
];

/**
 * The hosts one cluster's actuator should have out (quarantining,
 * quarantined) or bring back (resolving), plus dry-run ones it only logs.
 */
export async function desiredQuarantines(
  db: Db,
  cluster: string,
): Promise<ActionResult> {
  const rows = await db<
    {
      host: string;
      alert_id: string;
      stage: string;
      reason: string | null;
      actuator_state: string | null;
    }[]
  >`
    SELECT subject_key AS host, alert_id, details->>'stage' AS stage,
           details->>'reason' AS reason,
           details->>'actuator_state' AS actuator_state
    FROM alerting_infra_alerts
    WHERE alert_type = 'quarantine'
      AND status = 'open'
      AND details->>'cluster' = ${cluster}
      AND details->>'stage' IN ${db(ACTUATED_STAGES)}
    ORDER BY subject_key
  `;
  return {
    status: 200,
    body: {
      nodes: rows.map((row) => ({
        host: row.host,
        alertId: Number(row.alert_id),
        stage: row.stage,
        reason: row.reason,
        // Its own last report: after 'verify_failed' it starts no new
        // return check until a person resolves again.
        actuatorState: row.actuator_state,
      })),
    },
  };
}

export const ACTUATOR_STATES = [
  "out",
  "drained",
  "verifying",
  "verify_failed",
  "returned",
] as const;
export type ActuatorState = (typeof ACTUATOR_STATES)[number];

/**
 * Records what the actuator did to a host on its open quarantine episode. It
 * never changes the stage: the worker reads the report on its next scan. A
 * report for an episode other than the host's open one (a stale alertId) is
 * a 409; a host with no open quarantine is a 404.
 */
export async function recordActuatorState(
  db: Db,
  host: string,
  alertId: number,
  state: ActuatorState,
  observed: Record<string, unknown> | null,
): Promise<ActionResult> {
  const updated = await db`
    UPDATE alerting_infra_alerts
    SET details = details || jsonb_build_object(
          'actuator_state', ${state}::text,
          'actuator_state_at', now(),
          'actuator_observed', ${observed === null ? null : db.json(observed as never)}::jsonb
        ),
        updated_at = now()
    WHERE alert_type = 'quarantine'
      AND subject_key = ${host}
      AND status = 'open'
      AND alert_id = ${alertId}
    RETURNING alert_id
  `;
  if (updated.length > 0) return { status: 200, body: { ok: true } };
  const open = await db`
    SELECT alert_id FROM alerting_infra_alerts
    WHERE alert_type = 'quarantine' AND subject_key = ${host} AND status = 'open'
  `;
  if (open.length === 0) return fail(404, "This host has no open quarantine.");
  return fail(409, "alertId is not this host's open quarantine.");
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
