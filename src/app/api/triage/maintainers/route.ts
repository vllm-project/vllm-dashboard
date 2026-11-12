import { guardTriageRequest, triageDbError, triageJson } from "@/lib/triage-http";
import { listActiveMaintainers } from "@/lib/triage-data";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = guardTriageRequest(request);
  if (!("login" in guard)) return guard;
  try {
    return triageJson({ maintainers: await listActiveMaintainers() });
  } catch (error) {
    return triageDbError(error, "maintainer query");
  }
}
