import {
  guardTriageRequest,
  readJsonBody,
  triageDbError,
  triageError,
  triageJson,
} from "@/lib/triage-http";
import { undoTriageAction } from "@/lib/triage-data";
import { parseUndoRequest } from "@/lib/triage-actions";

export const dynamic = "force-dynamic";

/**
 * POST {actionId}: undo your own dashboard action from the last minute (the
 * 5-second "Undo" toast). Same session and same-origin checks as
 * POST /api/triage/actions; rules in `checkUndo` / `planUndo`.
 */
export async function POST(request: Request) {
  const guard = guardTriageRequest(request, { mutating: true });
  if (!("login" in guard)) return guard;
  const parsed = parseUndoRequest(await readJsonBody(request));
  if (!parsed.ok) return triageError(parsed.error, 400);
  try {
    const result = await undoTriageAction(guard.login, parsed.actionId);
    if (!result.ok) return triageError(result.error, result.status);
    return triageJson({ ok: true, itemKeys: result.value.itemKeys });
  } catch (error) {
    return triageDbError(error, "undo");
  }
}
