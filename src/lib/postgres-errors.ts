/** Small guards for PostgreSQL errors crossing library boundaries. */

export function hasPostgresErrorCode(
  error: unknown,
  expectedCode: string,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === expectedCode
  );
}
