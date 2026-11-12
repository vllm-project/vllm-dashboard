import { NextResponse } from "next/server";
import { guardTriageRequest, triageDbError, triageJson } from "@/lib/triage-http";
import { getMaintainer } from "@/lib/triage-data";
import { EMPTY_RULES, RULES_DIR_URL } from "@/lib/triage-rules";

export const dynamic = "force-dynamic";

/** The signed-in maintainer's current settings (synced from the repo file); defaults when no row exists. */
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

/**
 * Rules are owned by triage/config/maintainers/<login>.yaml and changed by PR; the
 * worker syncs main's copy into triage_maintainers. The dashboard never
 * writes them.
 */
export async function PUT(request: Request) {
  const guard = guardTriageRequest(request);
  if (!("login" in guard)) return guard;
  return NextResponse.json(
    {
      error:
        "Rules are read-only here. Edit triage/config/maintainers/<your-login>.yaml by pull request; changes take effect about 5 minutes after it merges.",
      file: RULES_DIR_URL,
    },
    { status: 405, headers: { Allow: "GET", "Cache-Control": "private, no-store" } },
  );
}
