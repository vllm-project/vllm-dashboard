import { guardTriageRequest, triageJson } from "@/lib/triage-http";

export const dynamic = "force-dynamic";

/** The signed-in maintainer's login, for client components. */
export async function GET(request: Request) {
  const guard = guardTriageRequest(request);
  if (!("login" in guard)) return guard;
  return triageJson({ login: guard.login });
}
