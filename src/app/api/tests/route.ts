import { NextRequest, NextResponse } from "next/server";
import { cachedJson } from "@/lib/api-response";
import { matchesTestQuery, type ParametrizedTestRecord } from "@/lib/test-groups";

const BUILDKITE_API_VERSION = "2026-08-01";
const PAGE_SIZE = 30;
// The Buildkite Tests API has no text-search parameter, so a query makes us
// page through the suite server-side (bounded) and filter here.
const SEARCH_PER_PAGE = 100; // upstream maximum
const SEARCH_PAGE_LIMIT = 10; // up to 1,000 tests searched per query
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
const LABELS = new Set(["flaky"]);
const SORTS = new Set(["reliability", "duration_avg"]);
const ORDERS = new Set(["asc", "desc"]);

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasNextPage(linkHeader: string | null): boolean {
  return linkHeader?.split(",").some((link) => /rel="next"/.test(link)) ?? false;
}

function fetchTestsPage(
  upstreamUrl: URL,
  token: string,
  page: number,
  perPage: number,
): Promise<Response> {
  const url = new URL(upstreamUrl);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));
  return fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Buildkite-Version": BUILDKITE_API_VERSION,
    },
    next: { revalidate: 60 },
  });
}

function upstreamErrorResponse(response: Response, body: string) {
  console.error(
    `Buildkite Test Engine request failed: ${response.status} ${body}`,
  );
  const permissionHint =
    response.status === 401
      ? "The configured Buildkite API token is no longer valid."
      : response.status === 403 || response.status === 404
        ? "The token needs read_suites access to the configured Test Engine suite."
        : "Buildkite Test Engine did not return test data.";
  return NextResponse.json(
    { error: permissionHint, code: "BUILDKITE_REQUEST_FAILED" },
    { status: response.status >= 500 ? 502 : response.status },
  );
}

type SearchResult =
  | { ok: true; tests: ParametrizedTestRecord[]; truncated: boolean }
  | { ok: false; response: NextResponse };

async function searchTests(
  upstreamUrl: URL,
  token: string,
  query: string,
): Promise<SearchResult> {
  const matched: ParametrizedTestRecord[] = [];
  for (let page = 1; page <= SEARCH_PAGE_LIMIT; page++) {
    const response = await fetchTestsPage(
      upstreamUrl,
      token,
      page,
      SEARCH_PER_PAGE,
    );
    if (!response.ok) {
      return { ok: false, response: upstreamErrorResponse(response, await response.text()) };
    }
    const tests = (await response.json()) as ParametrizedTestRecord[];
    for (const test of tests) {
      if (matchesTestQuery(test, query)) matched.push(test);
    }
    if (!hasNextPage(response.headers.get("link"))) {
      return { ok: true, tests: matched, truncated: false };
    }
  }
  return { ok: true, tests: matched, truncated: true };
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
  const label = LABELS.has(params.get("label") ?? "")
    ? params.get("label")!
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
  const query = (params.get("q") ?? "").trim().slice(0, 200);

  const upstreamUrl = new URL(
    `https://api.buildkite.com/v2/analytics/organizations/${encodeURIComponent(organization)}/suites/${encodeURIComponent(suite)}/tests`,
  );
  upstreamUrl.searchParams.set("period", period);
  upstreamUrl.searchParams.set("sort_by", sortBy);
  upstreamUrl.searchParams.set("order", order);
  if (state) upstreamUrl.searchParams.set("state", state);
  if (label) upstreamUrl.searchParams.set("label", label);

  const suiteInfo = {
    name: "CI",
    slug: suite,
    organization,
  };

  try {
    if (query) {
      const result = await searchTests(upstreamUrl, token, query);
      if (!result.ok) return result.response;
      const start = (page - 1) * PAGE_SIZE;
      const tests = result.tests.slice(start, start + PAGE_SIZE);
      return cachedJson(
        {
          tests,
          pagination: {
            page,
            pageSize: PAGE_SIZE,
            hasNext: start + PAGE_SIZE < result.tests.length,
            totalMatches: result.tests.length,
            truncated: result.truncated,
          },
          suite: suiteInfo,
        },
        CDN_CACHE,
      );
    }

    const response = await fetchTestsPage(upstreamUrl, token, page, PAGE_SIZE);

    if (!response.ok) {
      return upstreamErrorResponse(response, await response.text());
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
        suite: suiteInfo,
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
