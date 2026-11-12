import { NextResponse } from "next/server";
import {
  isSameOrigin,
  loginFromSessionCookie,
  readCookie,
  SESSION_COOKIE,
  triageEnabled,
} from "@/lib/triage-auth";
import { hasPostgresErrorCode } from "@/lib/postgres-errors";

const NO_STORE = { "Cache-Control": "private, no-store" };

export function triageJson<T>(data: T, status = 200) {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

export function triageError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * Gate every triage API: 404 when the feature is off, 401 without a session,
 * 403 for a cross-origin mutating request. Returns the login or the response.
 */
export function guardTriageRequest(
  request: Request,
  { mutating = false }: { mutating?: boolean } = {},
): { login: string } | NextResponse {
  if (!triageEnabled()) return triageError("Not found", 404);
  const login = loginFromSessionCookie(
    readCookie(request.headers.get("cookie"), SESSION_COOKIE),
  );
  if (!login) return triageError("Sign in with GitHub to use triage.", 401);
  if (mutating && !isSameOrigin(request)) {
    return triageError("Cross-origin request refused.", 403);
  }
  return { login };
}

export function triageDbError(error: unknown, what: string) {
  if (hasPostgresErrorCode(error, "42P01")) {
    return triageError("Triage schema is not deployed yet.", 503);
  }
  console.error(`Triage: ${what} failed:`, error);
  return triageError(`Triage ${what} failed.`, 500);
}

export async function readJsonBody(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
