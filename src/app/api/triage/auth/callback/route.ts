import { NextResponse } from "next/server";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  decodeOAuthStateCookie,
  newSession,
  readCookie,
  sessionCookieOptions,
  sessionSecret,
  signSession,
  statesMatch,
  triageEnabled,
} from "@/lib/triage-auth";
import {
  callbackUrl,
  exchangeCode,
  fetchLogin,
  isTriageMaintainer,
  oauthConfig,
} from "@/lib/triage-github-oauth";
import { triageError } from "@/lib/triage-http";

export const dynamic = "force-dynamic";

function redirectWithError(request: Request, error: string) {
  const url = new URL("/triage", request.url);
  url.searchParams.set("auth_error", error);
  const response = NextResponse.redirect(url, { status: 303, headers: { "Cache-Control": "no-store" } });
  response.cookies.set(OAUTH_STATE_COOKIE, "", sessionCookieOptions(process.env, 0));
  return response;
}

export async function GET(request: Request) {
  if (!triageEnabled()) return triageError("Not found", 404);
  const config = oauthConfig();
  const secret = sessionSecret();
  if (!config || !secret) return triageError("GitHub sign-in is not configured on this dashboard.", 503);

  const params = new URL(request.url).searchParams;
  const stored = decodeOAuthStateCookie(readCookie(request.headers.get("cookie"), OAUTH_STATE_COOKIE));
  if (!stored || !statesMatch(stored.state, params.get("state"))) {
    return redirectWithError(request, "state");
  }
  const code = params.get("code");
  if (!code) return redirectWithError(request, "denied");

  try {
    const token = await exchangeCode(code, callbackUrl(request.url), config);
    if (!token) return redirectWithError(request, "exchange");
    const login = await fetchLogin(token);
    if (!login) return redirectWithError(request, "exchange");
    if (!(await isTriageMaintainer(login, token))) {
      return redirectWithError(request, "not_maintainer");
    }
    const response = NextResponse.redirect(new URL(stored.next, request.url), {
      status: 303,
      headers: { "Cache-Control": "no-store" },
    });
    response.cookies.set(SESSION_COOKIE, signSession(newSession(login), secret), sessionCookieOptions());
    response.cookies.set(OAUTH_STATE_COOKIE, "", sessionCookieOptions(process.env, 0));
    return response;
  } catch (error) {
    console.error("Triage GitHub sign-in failed:", error);
    return redirectWithError(request, "exchange");
  }
}
