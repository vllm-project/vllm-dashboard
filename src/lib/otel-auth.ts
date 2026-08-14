import { timingSafeEqual } from "node:crypto";

export function isOtlpConfigured(): boolean {
  return Boolean(process.env.OTEL_INGEST_TOKEN);
}

export function isOtlpAuthorized(headers: Headers): boolean {
  const expected = process.env.OTEL_INGEST_TOKEN;
  const authorization = headers.get("authorization");
  if (!expected || !authorization?.startsWith("Bearer ")) return false;

  const received = authorization.slice("Bearer ".length);
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}
