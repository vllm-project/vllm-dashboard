import { guardTriageRequest, triageDbError, triageJson } from "@/lib/triage-http";
import { getMyPlate } from "@/lib/triage-data";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = guardTriageRequest(request);
  if (!("login" in guard)) return guard;
  try {
    return triageJson(await getMyPlate(guard.login));
  } catch (error) {
    return triageDbError(error, "my-plate query");
  }
}
