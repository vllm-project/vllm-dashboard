import {
  MAX_BY,
  closeIncident,
  fail,
  operatorPost,
  textField,
} from "@/lib/quarantine-actions";

export const dynamic = "force-dynamic";

/**
 * Closes a confirmed incident, ending its window; the worker then starts the
 * re-run. Requires the ALERT_OPERATOR_TOKEN bearer credential.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await context.params;
  return operatorPost(request, "Closing an incident", async (body, db) => {
    const id = /^\d{1,15}$/.test(rawId) ? Number(rawId) : 0;
    const by = textField(body, "by", MAX_BY);
    if (id <= 0) return fail(400, "id must be a positive integer.");
    if (!by) return fail(400, `by must be 1 to ${MAX_BY} characters.`);
    return closeIncident(db(), id, by);
  });
}
