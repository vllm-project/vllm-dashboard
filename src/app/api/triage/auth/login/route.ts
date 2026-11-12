import { NextResponse } from "next/server";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  encodeOAuthStateCookie,
  newOAuthState,
  safeNextPath,
  sessionCookieOptions,
  sessionSecret,
  triageEnabled,
} from "@/lib/triage-auth";
import { authorizeUrl, callbackUrl, oauthConfig } from "@/lib/triage-github-oauth";
import { triageError } from "@/lib/triage-http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!triageEnabled()) return triageError("Not found", 404);
  const config = oauthConfig();
  if (!config || !sessionSecret()) {
    return triageError("GitHub sign-in is not configured on this dashboard.", 503);
  }
  const next = safeNextPath(new URL(request.url).searchParams.get("next"));
  const state = newOAuthState();
  const response = NextResponse.redirect(
    authorizeUrl(config.clientId, callbackUrl(request.url), state),
    { status: 302, headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(
    OAUTH_STATE_COOKIE,
    encodeOAuthStateCookie(state, next),
    sessionCookieOptions(process.env, OAUTH_STATE_TTL_SECONDS),
  );
  return response;
}
