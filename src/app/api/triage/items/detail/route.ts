import { guardTriageRequest, triageDbError, triageError, triageJson } from "@/lib/triage-http";
import { getItemDetail } from "@/lib/triage-data";
import { isItemKey } from "@/lib/triage-actions";

export const dynamic = "force-dynamic";

/** GET /api/triage/items/detail?key=vllm-project/vllm%2312345 */
export async function GET(request: Request) {
  const guard = guardTriageRequest(request);
  if (!("login" in guard)) return guard;
  const key = new URL(request.url).searchParams.get("key");
  if (!isItemKey(key)) return triageError("key must look like owner/repo#123.", 400);
  try {
    const detail = await getItemDetail(key);
    return detail ? triageJson(detail) : triageError("No such triage item.", 404);
  } catch (error) {
    return triageDbError(error, "item query");
  }
}
