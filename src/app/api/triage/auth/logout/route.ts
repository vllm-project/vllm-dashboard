import { NextResponse } from "next/server";
import {
  legacyCookiesToClear,
  sessionCookieName,
  isSameOrigin,
  sessionCookieOptions,
  triageEnabled,
} from "@/lib/triage-auth";
import { triageError } from "@/lib/triage-http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!triageEnabled()) return triageError("Not found", 404);
  if (!isSameOrigin(request)) return triageError("Cross-origin request refused.", 403);
  const response = NextResponse.redirect(new URL("/triage", request.url), {
    status: 303,
    headers: { "Cache-Control": "no-store" },
  });
  response.cookies.set(sessionCookieName(), "", sessionCookieOptions(process.env, 0));
  for (const legacy of legacyCookiesToClear()) response.cookies.set(legacy, "", { path: "/", maxAge: 0 });
  return response;
}
