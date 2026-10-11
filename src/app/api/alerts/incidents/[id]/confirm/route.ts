import {
  MAX_BY,
  MAX_CAUSE,
  MAX_MATCH,
  confirmIncident,
  fail,
  operatorPost,
  textField,
} from "@/lib/quarantine-actions";

export const dynamic = "force-dynamic";

/**
 * Confirms a suspected shared-cause incident. `match` is the error text or
 * failure kind the later re-run targets. Requires the ALERT_OPERATOR_TOKEN
 * bearer credential.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  return operatorPost(request, "Confirming an incident", async (body, db) => {
    const id = /^\d{1,15}$/.test(rawId) ? Number(rawId) : 0;
    const by = textField(body, "by", MAX_BY);
    const cause = textField(body, "cause", MAX_CAUSE);
    const match = textField(body, "match", MAX_MATCH);
    if (id <= 0) return fail(400, "id must be a positive integer.");
    if (!by) return fail(400, `by must be 1 to ${MAX_BY} characters.`);
    if (!cause) return fail(400, `cause must be 1 to ${MAX_CAUSE} characters.`);
    if (!match) return fail(400, `match must be 1 to ${MAX_MATCH} characters.`);
    return confirmIncident(db(), id, by, cause, match);
  });
}
