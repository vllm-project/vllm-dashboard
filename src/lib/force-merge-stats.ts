/**
 * Force-merge records for merged vllm-project/vllm pull requests, ported from
 * the standalone vllm-force-merge-stats fetcher.
 *
 * A "force-merge" is a PR merged while its `buildkite/ci/pr` commit status was
 * red (failure or error) on the PR's head commit. A PR merged while that build
 * was green, still running, or never triggered is not a force-merge. Who
 * clicked merge (a maintainer or `vllm-bot`) does not matter.
 *
 * The status must be read as of the merge: a build can finish, fail, or be
 * rerun after the PR merged. GraphQL only exposes the latest status per
 * context, so when that status postdates the merge the REST status history is
 * walked back to the merge instead.
 */

export const CI_STATUS_CONTEXT = "buildkite/ci/pr";
const RED_CI_STATES = new Set(["failure", "error"]);
const GITHUB_API_URL = "https://api.github.com";
const REPOSITORY_OWNER = "vllm-project";
const REPOSITORY_NAME = "vllm";
// Nested commit status lookups make large pages slow; GitHub aborts GraphQL
// queries after 10s.
const SEARCH_PAGE_SIZE = 50;
// A head commit carries a status per CI job as well as the build-level
// context, so a rerun after the merge can push the relevant entry several
// pages deep.
const STATUS_PAGE_SIZE = 100;
const MAX_STATUS_PAGES = 20;
const DAY_MS = 86_400_000;

const MERGED_PR_SEARCH_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: ${SEARCH_PAGE_SIZE}, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        url
        mergedAt
        author { login }
        mergedBy { login }
        commits(last: 1) {
          nodes {
            commit {
              oid
              status {
                context(name: "${CI_STATUS_CONTEXT}") { state createdAt }
              }
            }
          }
        }
      }
    }
  }
}`;

export interface ForceMergeRecord {
  prNumber: number;
  title: string;
  url: string;
  author: string | null;
  mergedBy: string | null;
  mergedAt: string;
  headSha: string | null;
  /** Lowercase `buildkite/ci/pr` state at merge time; null when none existed. */
  ciState: string | null;
  forceMerged: boolean;
}

type SearchNode = {
  number?: number;
  title?: string;
  url?: string;
  mergedAt?: string | null;
  author?: { login?: string | null } | null;
  mergedBy?: { login?: string | null } | null;
  commits?: {
    nodes?: Array<{
      commit?: {
        oid?: string;
        status?: {
          context?: { state?: string; createdAt?: string } | null;
        } | null;
      } | null;
    } | null>;
  } | null;
} | null;

interface GraphQLSearchResult {
  issueCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: SearchNode[];
}

export interface CommitStatus {
  context: string;
  state: string;
  created_at: string;
}

export type GraphQLRunner = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<{ data?: Record<string, unknown>; errors?: unknown[] }>;

export interface GitHubClient {
  graphql: GraphQLRunner;
  /** One page of a commit's statuses across all contexts, newest first. */
  commitStatuses: (sha: string, page: number) => Promise<CommitStatus[]>;
}

function utcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Inclusive [start, end] UTC date chunks covering the window, non-overlapping. */
export function dateRangeChunks(
  start: Date,
  end: Date,
  stepDays: number = 1,
): Array<{ start: Date; end: Date }> {
  const chunks: Array<{ start: Date; end: Date }> = [];
  const endUtc = utcMidnight(end);
  for (let cur = utcMidnight(start); cur <= endUtc; cur += stepDays * DAY_MS) {
    chunks.push({
      start: new Date(cur),
      end: new Date(Math.min(cur + (stepDays - 1) * DAY_MS, endUtc)),
    });
  }
  return chunks;
}

/**
 * First UTC day to ingest. A merged PR's CI state at merge never changes, so
 * ingest resumes from the newest stored merge (re-reading the day before it to
 * cover search-index lag) and only backfills when the table is empty.
 */
export function ingestStartDate(
  lastMergedAt: Date | null,
  now: Date,
  backfillDays: number,
): Date {
  const floor = utcMidnight(now) - backfillDays * DAY_MS;
  if (!lastMergedAt) return new Date(floor);
  return new Date(Math.max(floor, utcMidnight(lastMergedAt) - DAY_MS));
}

export function searchQueryForWindow(chunkStart: Date, chunkEnd: Date): string {
  const from = chunkStart.toISOString().slice(0, 10);
  const to = chunkEnd.toISOString().slice(0, 10);
  return `repo:${REPOSITORY_OWNER}/${REPOSITORY_NAME} is:pr is:merged merged:${from}..${to}`;
}

/** State of `buildkite/ci/pr` on the head commit at the moment of merge. */
export async function ciStateAtMerge(
  client: GitHubClient,
  headSha: string | null,
  latest: { state: string; createdAt: string } | null,
  mergedAt: string,
): Promise<string | null> {
  if (!latest) return null;
  const mergedMs = Date.parse(mergedAt);
  if (Date.parse(latest.createdAt) <= mergedMs) return latest.state.toLowerCase();
  if (!headSha) return null;

  for (let page = 1; page <= MAX_STATUS_PAGES; page++) {
    const statuses = await client.commitStatuses(headSha, page);
    const atMerge = statuses.find(
      (status) =>
        status.context === CI_STATUS_CONTEXT &&
        Date.parse(status.created_at) <= mergedMs,
    );
    if (atMerge) return atMerge.state.toLowerCase();
    if (statuses.length < STATUS_PAGE_SIZE) break;
  }
  return null;
}

async function toRecord(
  client: GitHubClient,
  node: SearchNode,
): Promise<ForceMergeRecord | null> {
  if (!node || typeof node.number !== "number" || !node.mergedAt) return null;
  const commit = node.commits?.nodes?.[0]?.commit ?? null;
  const headSha = commit?.oid ?? null;
  const latest = commit?.status?.context;
  const ciState = await ciStateAtMerge(
    client,
    headSha,
    latest?.state && latest.createdAt
      ? { state: latest.state, createdAt: latest.createdAt }
      : null,
    node.mergedAt,
  );
  return {
    prNumber: node.number,
    title: node.title ?? "",
    url: node.url ?? "",
    author: node.author?.login ?? null,
    mergedBy: node.mergedBy?.login ?? null,
    mergedAt: node.mergedAt,
    headSha,
    ciState,
    forceMerged: ciState !== null && RED_CI_STATES.has(ciState),
  };
}

/**
 * All merged PRs in one window, paginated through the search API and
 * deduplicated by PR number (results can shift between pages).
 */
export async function fetchWindowRecords(
  client: GitHubClient,
  chunkStart: Date,
  chunkEnd: Date,
): Promise<ForceMergeRecord[]> {
  const query = searchQueryForWindow(chunkStart, chunkEnd);
  const byNumber = new Map<number, ForceMergeRecord>();
  let cursor: string | null = null;

  do {
    const payload = await client.graphql(MERGED_PR_SEARCH_QUERY, {
      q: query,
      cursor,
    });
    if (payload.errors?.length) {
      throw new Error(`GitHub GraphQL errors: ${JSON.stringify(payload.errors)}`);
    }
    const search = payload.data?.search as GraphQLSearchResult | undefined;
    if (!search) {
      throw new Error(`GitHub GraphQL search returned no data for ${query}`);
    }
    for (const node of search.nodes) {
      const record = await toRecord(client, node);
      if (record) byNumber.set(record.prNumber, record);
    }
    cursor = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
  } while (cursor);

  return [...byNumber.values()];
}

export function createGitHubClient(token: string): GitHubClient {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "vllm-dashboard",
  };

  async function request(url: string, init: RequestInit = {}) {
    const response = await fetch(url, {
      ...init,
      headers: { ...headers, ...init.headers },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(
        `GitHub request failed: ${response.status} ${response.statusText} (${url})`,
      );
    }
    return response.json();
  }

  return {
    graphql: (query, variables) =>
      request(`${GITHUB_API_URL}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      }),
    commitStatuses: (sha, page) =>
      request(
        `${GITHUB_API_URL}/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/commits/${sha}/statuses?per_page=${STATUS_PAGE_SIZE}&page=${page}`,
      ),
  };
}
