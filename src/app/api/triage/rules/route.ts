import {
  guardTriageRequest,
  readJsonBody,
  triageDbError,
  triageError,
  triageJson,
} from "@/lib/triage-http";
import { getMaintainer, saveOwnMaintainer } from "@/lib/triage-data";
import { EMPTY_RULES, validateMaintainerSettings } from "@/lib/triage-rules";

export const dynamic = "force-dynamic";

/** The signed-in maintainer's own settings; defaults when no row exists yet. */
export async function GET(request: Request) {
  const guard = guardTriageRequest(request);
  if (!("login" in guard)) return guard;
  try {
    const maintainer = await getMaintainer(guard.login);
    return triageJson({
      exists: maintainer !== null,
      maintainer: maintainer ?? {
        githubLogin: guard.login,
        slackUserId: null,
        active: true,
        rules: EMPTY_RULES,
        minScore: 40,
        capacityPerWeek: 10,
        away: [],
        notifyMode: "digest",
        updatedBy: null,
        updatedAt: null,
      },
    });
  } catch (error) {
    return triageDbError(error, "rules query");
  }
}

/** Creates or replaces the signed-in maintainer's own settings. */
export async function PUT(request: Request) {
  const guard = guardTriageRequest(request, { mutating: true });
  if (!("login" in guard)) return guard;
  const parsed = validateMaintainerSettings(await readJsonBody(request));
  if (!parsed.ok) return triageError(parsed.error, 400);
  try {
    return triageJson({ exists: true, maintainer: await saveOwnMaintainer(guard.login, parsed.value) });
  } catch (error) {
    return triageDbError(error, "rules update");
  }
}
