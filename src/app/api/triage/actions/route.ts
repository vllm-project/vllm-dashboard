import {
  guardTriageRequest,
  readJsonBody,
  triageDbError,
  triageError,
  triageJson,
} from "@/lib/triage-http";
import { applyTriageAction } from "@/lib/triage-data";
import { parseActionRequest } from "@/lib/triage-actions";

export const dynamic = "force-dynamic";

/**
 * POST {itemKey, action, assignmentId?, target?, note?}. Semantics and
 * permissions: src/lib/triage-actions.ts and triage/docs/data-model.md.
 */
export async function POST(request: Request) {
  const guard = guardTriageRequest(request, { mutating: true });
  if (!("login" in guard)) return guard;
  const parsed = parseActionRequest(await readJsonBody(request));
  if (!parsed.ok) return triageError(parsed.error, 400);
  try {
    const result = await applyTriageAction(guard.login, parsed.value);
    if (!result.ok) return triageError(result.error, result.status);
    return triageJson(result);
  } catch (error) {
    return triageDbError(error, "action");
  }
}
