import { NextRequest, NextResponse } from "next/server";
import { cachedJson } from "@/lib/api-response";

const BUILDKITE_API_VERSION = "2026-08-01";
const PAGE_SIZE = 30;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 300 };

const PERIODS = new Set([
  "1hour",
  "4hours",
  "1day",
  "7days",
  "14days",
  "28days",
]);
const STATES = new Set(["enabled", "muted", "skipped"]);
const SORTS = new Set(["reliability", "duration_avg"]);
const ORDERS = new Set(["asc", "desc"]);

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasNextPage(linkHeader: string | null): boolean {
  return linkHeader?.split(",").some((link) => /rel="next"/.test(link)) ?? false;
}

export async function GET(request: NextRequest) {
  const token = process.env.BUILDKITE_API_TOKEN;
  if (!token) {
    return NextResponse.json(
      {
        error:
          "Tests need a Buildkite API token with the read_suites scope. Set BUILDKITE_API_TOKEN on the dashboard deployment.",
        code: "BUILDKITE_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  const organization = process.env.BUILDKITE_ORGANIZATION || "vllm";
  const suite = process.env.BUILDKITE_TEST_SUITE || "ci-1";
  const params = request.nextUrl.searchParams;
  const period = PERIODS.has(params.get("period") ?? "")
    ? params.get("period")!
    : "1day";
  const state = STATES.has(params.get("state") ?? "")
    ? params.get("state")!
    : null;
  const sortBy = SORTS.has(params.get("sortBy") ?? "")
    ? params.get("sortBy")!
    : "reliability";
  const order = ORDERS.has(params.get("order") ?? "")
    ? params.get("order")!
    : sortBy === "reliability"
      ? "asc"
      : "desc";
  const page = positiveInteger(params.get("page"), 1);

  const upstreamUrl = new URL(
    `https://api.buildkite.com/v2/analytics/organizations/${encodeURIComponent(organization)}/suites/${encodeURIComponent(suite)}/tests`,
  );
  upstreamUrl.searchParams.set("period", period);
  upstreamUrl.searchParams.set("sort_by", sortBy);
  upstreamUrl.searchParams.set("order", order);
  upstreamUrl.searchParams.set("page", String(page));
  upstreamUrl.searchParams.set("per_page", String(PAGE_SIZE));
  if (state) upstreamUrl.searchParams.set("state", state);
  if (params.get("flaky") === "true") {
    upstreamUrl.searchParams.set("labels", "flaky");
  }

  try {
    const response = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Buildkite-Version": BUILDKITE_API_VERSION,
      },
      next: { revalidate: 60 },
    });

    if (!response.ok) {
      const permissionHint =
        response.status === 401
          ? "The configured Buildkite API token is no longer valid."
          : response.status === 403 || response.status === 404
            ? "The token needs read_suites access to the configured Test Engine suite."
            : "Buildkite Test Engine did not return test data.";
      console.error(
        `Buildkite Test Engine request failed: ${response.status} ${await response.text()}`,
      );
      return NextResponse.json(
        { error: permissionHint, code: "BUILDKITE_REQUEST_FAILED" },
        { status: response.status >= 500 ? 502 : response.status },
      );
    }

    const tests = await response.json();
    return cachedJson(
      {
        tests,
        pagination: {
          page,
          pageSize: PAGE_SIZE,
          hasNext: hasNextPage(response.headers.get("link")),
        },
        suite: {
          name: "CI",
          slug: suite,
          organization,
        },
      },
      CDN_CACHE,
    );
  } catch (error) {
    console.error("Failed to fetch Buildkite tests:", error);
    return NextResponse.json(
      {
        error: "Buildkite Test Engine could not be reached.",
        code: "BUILDKITE_UNAVAILABLE",
      },
      { status: 502 },
    );
  }
}
