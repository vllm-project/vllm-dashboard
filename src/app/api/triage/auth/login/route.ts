import { NextResponse } from "next/server";
import {
  legacyCookiesToClear,
  OAUTH_STATE_TTL_SECONDS,
  encodeOAuthStateCookie,
  newOAuthState,
  newPkceVerifier,
  oauthStateCookieName,
  pkceChallenge,
  safeNextPath,
  sessionCookieOptions,
  sessionSecret,
  triageEnabled,
} from "@/lib/triage-auth";
import { authorizeUrl, callbackUrl, canonicalOrigin, isCanonicalRequest, oauthConfig } from "@/lib/triage-github-oauth";
import { triageError } from "@/lib/triage-http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!triageEnabled()) return triageError("Not found", 404);
  const config = oauthConfig();
  if (!config || !sessionSecret()) {
    return triageError("GitHub sign-in is not configured on this dashboard.", 503);
  }
  const next = safeNextPath(new URL(request.url).searchParams.get("next"));
  if (!isCanonicalRequest(request.url)) {
    // Start over on the canonical origin (a fixed value, not the Host header),
    // so the state cookie and session land where the callback runs.
    const target = new URL("/api/triage/auth/login", canonicalOrigin());
    target.searchParams.set("next", next);
    return NextResponse.redirect(target, { status: 302, headers: { "Cache-Control": "no-store" } });
  }
  const state = newOAuthState();
  const verifier = newPkceVerifier();
  const response = NextResponse.redirect(
    authorizeUrl(config.clientId, callbackUrl(), state, pkceChallenge(verifier)),
    { status: 302, headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(
    oauthStateCookieName(),
    encodeOAuthStateCookie(state, next, verifier),
    sessionCookieOptions(process.env, OAUTH_STATE_TTL_SECONDS),
  );
  for (const legacy of legacyCookiesToClear()) response.cookies.set(legacy, "", { path: "/", maxAge: 0 });
  return response;
}
