import {
  ACTUATOR_STATES,
  type ActuatorState,
  actuatorCall,
  fail,
  recordActuatorState,
} from "@/lib/quarantine-actions";

export const dynamic = "force-dynamic";

const HOST = /^[a-z0-9][a-z0-9._-]{0,252}$/;
// What the actuator observed (cordoned, tainted, ciPods, reapplied, note) is
// stored as-is; the cap keeps a misbehaving actuator from bloating the row.
const MAX_OBSERVED_CHARS = 4096;

/**
 * An actuator's report on a host it acted on: 'out' (no new jobs can land),
 * 'drained' (no CI job still running) or 'returned' (back in service). It is
 * merged into the host's open quarantine episode; the worker moves the stage.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ host: string }> },
) {
  const { host: rawHost } = await context.params;
  return actuatorCall(request, "Recording a quarantine action", async (body, db) => {
    const host = rawHost.trim().toLowerCase();
    const { alertId, state, observed } = body;
    if (!HOST.test(host)) return fail(400, "host is not a valid hostname.");
    if (typeof alertId !== "number" || !Number.isSafeInteger(alertId) || alertId < 1) {
      return fail(400, "alertId must be a positive integer.");
    }
    if (!ACTUATOR_STATES.includes(state as ActuatorState)) {
      return fail(400, `state must be one of ${ACTUATOR_STATES.join(", ")}.`);
    }
    if (
      observed !== undefined &&
      (typeof observed !== "object" ||
        observed === null ||
        Array.isArray(observed) ||
        JSON.stringify(observed).length > MAX_OBSERVED_CHARS)
    ) {
      return fail(400, `observed must be a JSON object under ${MAX_OBSERVED_CHARS} characters.`);
    }
    return recordActuatorState(
      db(),
      host,
      alertId,
      state as ActuatorState,
      (observed as Record<string, unknown> | undefined) ?? null,
    );
  });
}
