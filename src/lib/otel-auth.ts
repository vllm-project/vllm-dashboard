import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { NormalizedOtlpSpan, OtlpAttributeValue } from "@/lib/otel-proto";

const BUILDKITE_ISSUER = "https://agent.buildkite.com";
const BUILDKITE_JWKS = createRemoteJWKSet(
  new URL("https://agent.buildkite.com/.well-known/jwks"),
);
const DEFAULT_OIDC_AUDIENCE = "https://ci.vllm.ai/api/otel";
const DEFAULT_ORGANIZATION = "vllm";
const DEFAULT_PIPELINE = "ci";
const DEFAULT_BRANCH = "main";
const DEFAULT_TREATMENT_BRANCH = "khluu/otel";

export type OtlpPrincipal =
  | { kind: "shared-token" }
  | {
      kind: "buildkite-oidc";
      organization: string;
      pipeline: string;
      buildNumber: number;
      jobId: string;
      branch: string;
    };

function sharedTokenMatches(received: string): boolean {
  const expected = process.env.OTEL_INGEST_TOKEN;
  if (!expected) return false;

  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function stringClaim(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Buildkite OIDC token is missing ${name}`);
  }
  return value;
}

function numberClaim(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Buildkite OIDC token has invalid ${name}`);
  }
  return parsed;
}

export function isOtlpConfigured(): boolean {
  return Boolean(process.env.OTEL_INGEST_TOKEN) ||
    process.env.OTEL_BUILDKITE_OIDC_DISABLED !== "true";
}

export async function authorizeOtlpRequest(
  headers: Headers,
): Promise<OtlpPrincipal | null> {
  const authorization = headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;

  const received = authorization.slice("Bearer ".length);
  if (sharedTokenMatches(received)) return { kind: "shared-token" };
  if (process.env.OTEL_BUILDKITE_OIDC_DISABLED === "true") return null;

  try {
    const { payload } = await jwtVerify(received, BUILDKITE_JWKS, {
      issuer: BUILDKITE_ISSUER,
      audience:
        process.env.OTEL_BUILDKITE_OIDC_AUDIENCE ?? DEFAULT_OIDC_AUDIENCE,
      clockTolerance: 10,
    });
    const organization = stringClaim(
      payload.organization_slug,
      "organization_slug",
    );
    const pipeline = stringClaim(payload.pipeline_slug, "pipeline_slug");
    const branch = stringClaim(payload.build_branch, "build_branch");
    const expectedBranch =
      process.env.OTEL_BUILDKITE_OIDC_BRANCH ?? DEFAULT_BRANCH;
    const treatmentBranch =
      process.env.OTEL_BUILDKITE_OIDC_TREATMENT_BRANCH ??
      DEFAULT_TREATMENT_BRANCH;
    const trustedBranch = branch === expectedBranch;
    const trustedTreatment =
      branch === treatmentBranch && payload.build_source === "api";
    if (
      organization !==
        (process.env.OTEL_BUILDKITE_OIDC_ORGANIZATION ?? DEFAULT_ORGANIZATION) ||
      pipeline !==
        (process.env.OTEL_BUILDKITE_OIDC_PIPELINE ?? DEFAULT_PIPELINE) ||
      (!trustedBranch && !trustedTreatment)
    ) {
      return null;
    }

    return {
      kind: "buildkite-oidc",
      organization,
      pipeline,
      branch,
      buildNumber: numberClaim(payload.build_number, "build_number"),
      jobId: stringClaim(payload.job_id, "job_id"),
    };
  } catch (error) {
    console.warn("Buildkite OIDC verification failed:", error);
    return null;
  }
}

function primitiveAttribute(
  attributes: Record<string, OtlpAttributeValue>,
  key: string,
): string | null {
  const value = attributes[key];
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return null;
}

export function spansMatchPrincipal(
  spans: NormalizedOtlpSpan[],
  principal: OtlpPrincipal,
): boolean {
  if (principal.kind === "shared-token") return true;
  if (spans.length === 0) return false;

  return spans.every((span) => {
    const attributes = {
      ...span.resourceAttributes,
      ...span.spanAttributes,
    };
    return (
      primitiveAttribute(attributes, "buildkite.organization.slug") ===
        principal.organization &&
      primitiveAttribute(attributes, "buildkite.pipeline.slug") ===
        principal.pipeline &&
      primitiveAttribute(attributes, "buildkite.build.number") ===
        String(principal.buildNumber) &&
      primitiveAttribute(attributes, "buildkite.job.id") === principal.jobId &&
      primitiveAttribute(attributes, "buildkite.build.branch") ===
        principal.branch
    );
  });
}
