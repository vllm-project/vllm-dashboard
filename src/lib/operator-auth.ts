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
