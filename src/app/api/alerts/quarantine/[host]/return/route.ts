import { fail, operatorPost, textField } from "@/lib/operator-actions";
import { MAX_BY, MAX_REASON, returnQuarantine } from "@/lib/quarantine-actions";

export const dynamic = "force-dynamic";

const HOST = /^[a-z0-9][a-z0-9._-]{0,252}$/;

/**
 * Returns a quarantined host: closes its open record with close_how =
 * 'returned'. Hard quarantines lift only this way. Requires the
 * ALERT_OPERATOR_TOKEN bearer credential.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ host: string }> },
) {
  const { host: rawHost } = await context.params;
  return operatorPost(request, "Returning a host", async (body, db) => {
    const host = rawHost.trim().toLowerCase();
    const by = textField(body, "by", MAX_BY);
    const reason = textField(body, "reason", MAX_REASON);
    if (!HOST.test(host)) return fail(400, "host is not a valid hostname.");
    if (!by) return fail(400, `by must be 1 to ${MAX_BY} characters.`);
    if (!reason) return fail(400, `reason must be 1 to ${MAX_REASON} characters.`);
    return returnQuarantine(db(), host, by, reason);
  });
}
