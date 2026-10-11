import { type ActionResult, type Db, fail } from "@/lib/operator-actions";

// Max lengths mirror the CHECK constraints in migration 0030.
export const MAX_BY = 80;
export const MAX_REASON = 500;
export const MAX_CAUSE = 500;
export const MAX_MATCH = 200;

/**
 * Closes the host's open quarantine record. A host with only closed records
 * is a 409 (already returned), a host with no record at all is a 404. The
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
    WHERE host = ${host} AND state <> 'closed'
    RETURNING record_id
  `;
  if (closed.length > 0) {
    return { status: 200, body: { ok: true, recordId: Number(closed[0].record_id) } };
  }
  const known = await db`
    SELECT 1 FROM alerting_quarantine_records WHERE host = ${host} LIMIT 1
  `;
  return known.length > 0
    ? fail(409, "Host has no open quarantine; it is already returned.")
    : fail(404, "No quarantine record exists for this host.");
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
