import {
  MAX_BY,
  MAX_REASON,
  fail,
  operatorPost,
  resolveQuarantine,
  textField,
} from "@/lib/quarantine-actions";

export const dynamic = "force-dynamic";

const HOST = /^[a-z0-9][a-z0-9._-]{0,252}$/;

/**
 * Resolves a quarantined host once a person has fixed it: moves its open
 * quarantine episode to 'resolve_requested', and once a fresh reading shows
 * the fault gone the actuator returns the host. `force: true` skips the
 * reading. In the pilot this is the only way a host comes back. Requires the
 * ALERT_OPERATOR_TOKEN bearer credential.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ host: string }> },
) {
  const { host: rawHost } = await context.params;
  return operatorPost(request, "Resolving a quarantine", async (body, db) => {
    const host = rawHost.trim().toLowerCase();
    const by = textField(body, "by", MAX_BY);
    const reason = textField(body, "reason", MAX_REASON);
    if (!HOST.test(host)) return fail(400, "host is not a valid hostname.");
    if (!by) return fail(400, `by must be 1 to ${MAX_BY} characters.`);
    if (!reason) return fail(400, `reason must be 1 to ${MAX_REASON} characters.`);
    const force = body.force === undefined ? false : body.force;
    if (typeof force !== "boolean") return fail(400, "force must be true or false.");
    return resolveQuarantine(db(), host, by, reason, force);
  });
}
