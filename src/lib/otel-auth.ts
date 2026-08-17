import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const BUILDKITE_ISSUER = "https://agent.buildkite.com";
const BUILDKITE_JWKS = createRemoteJWKSet(
  new URL(`${BUILDKITE_ISSUER}/.well-known/jwks`),
  {
    timeoutDuration: 1_500,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  },
);
const BUILDKITE_AUDIENCE = "https://ci.vllm.ai/api/otel";
const BUILDKITE_ORGANIZATION = "vllm";
const BUILDKITE_PIPELINE = "ci";
const BUILDKITE_TREATMENT_BRANCH = "khluu/otel";
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isOtlpConfigured(): boolean {
  return true;
}

function isStaticTokenAuthorized(token: string): boolean {
  const expected = process.env.OTEL_INGEST_TOKEN;
  if (!expected) return false;

  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(token);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

async function isBuildkiteTokenAuthorized(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, BUILDKITE_JWKS, {
      issuer: BUILDKITE_ISSUER,
      audience: BUILDKITE_AUDIENCE,
      algorithms: ["RS256"],
      maxTokenAge: "6m",
      clockTolerance: 5,
    });
    const trustedBranch = payload.build_branch === "main";
    const trustedTreatment =
      payload.build_source === "api" &&
      payload.build_branch === BUILDKITE_TREATMENT_BRANCH;
    return (
      payload.organization_slug === BUILDKITE_ORGANIZATION &&
      payload.pipeline_slug === BUILDKITE_PIPELINE &&
      typeof payload.job_id === "string" &&
      JOB_ID.test(payload.job_id) &&
      (trustedBranch || trustedTreatment)
    );
  } catch {
    return false;
  }
}

export async function isOtlpAuthorized(headers: Headers): Promise<boolean> {
  const authorization = headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;

  const token = authorization.slice("Bearer ".length);
  if (isStaticTokenAuthorized(token)) return true;
  return isBuildkiteTokenAuthorized(token);
}
