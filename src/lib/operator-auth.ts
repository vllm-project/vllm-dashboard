import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of an `Authorization: Bearer <token>` header against the
 * operator token configured for a mutating endpoint. Returns false when no
 * token is configured; callers that need to distinguish "not configured" (503)
 * from "wrong token" (401) check `process.env` themselves first.
 */
export function bearerTokenMatches(
  authorization: string | null,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken || !authorization?.startsWith("Bearer ")) return false;
  const expected = Buffer.from(expectedToken);
  const received = Buffer.from(authorization.slice("Bearer ".length));
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

/**
 * Gate for the Vercel cron routes. Vercel sends `Authorization: Bearer
 * $CRON_SECRET` on each scheduled call once the project sets CRON_SECRET.
 * Returns the response to send when the request may not run the job: 503
 * while CRON_SECRET is unset, so an unconfigured deployment refuses every
 * caller instead of serving anyone, and 401 for a wrong or missing token.
 */
export function cronAuthError(
  authorization: string | null,
): { error: string; status: 401 | 503 } | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { error: "CRON_SECRET is not configured", status: 503 };
  if (!bearerTokenMatches(authorization, secret)) {
    return { error: "Unauthorized", status: 401 };
  }
  return null;
}
