import {
  guardTriageRequest,
  readJsonBody,
  triageDbError,
  triageError,
  triageJson,
} from "@/lib/triage-http";
import { previewRules } from "@/lib/triage-data";
import { validateMaintainerSettings } from "@/lib/triage-rules";

export const dynamic = "force-dynamic";

/** POST a draft (rules, minScore, …) and see which recent items it matches; nothing is saved. */
export async function POST(request: Request) {
  const guard = guardTriageRequest(request, { mutating: true });
  if (!("login" in guard)) return guard;
  const parsed = validateMaintainerSettings(await readJsonBody(request));
  if (!parsed.ok) return triageError(parsed.error, 400);
  try {
    return triageJson(await previewRules(parsed.value.rules, parsed.value.minScore));
  } catch (error) {
    return triageDbError(error, "rules preview");
  }
}
