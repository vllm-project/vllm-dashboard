import { guardTriageRequest, triageDbError, triageJson } from "@/lib/triage-http";
import { listQueue } from "@/lib/triage-data";
import { parseQueueFilters } from "@/lib/triage-query";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = guardTriageRequest(request);
  if (!("login" in guard)) return guard;
  try {
    const filters = parseQueueFilters(new URL(request.url).searchParams);
    return triageJson(await listQueue(filters));
  } catch (error) {
    return triageDbError(error, "queue query");
  }
}
