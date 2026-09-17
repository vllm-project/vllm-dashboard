/**
 * Force-merge records for merged vllm-project/vllm pull requests, ported from
 * the standalone vllm-force-merge-stats fetcher.
 *
 * A "force-merge" is a merge performed by the `vllm-bot` account, which lead
 * maintainers use to override CI when a failure is unrelated to the PR. Every
 * PR is squash-merged with an identical git committer, so git history cannot
 * distinguish a force-merge; GitHub's `mergedBy` field is the only signal.
 *
 * The GitHub search API caps a single query at 1000 results, so the fetch
 * window is chunked by week and each chunk is paginated.
 */

export const FORCE_MERGE_LOGIN = "vllm-bot";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const REPOSITORY_OWNER = "vllm-project";
const REPOSITORY_NAME = "vllm";
const SEARCH_PAGE_SIZE = 100;
const CHUNK_DAYS = 7;

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
  forceMerged: boolean;
}

type SearchNode = {
  number?: number;
  title?: string;
  url?: string;
  mergedAt?: string | null;
  author?: { login?: string | null } | null;
  mergedBy?: { login?: string | null } | null;
} | null;

interface GraphQLSearchResult {
  issueCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: SearchNode[];
}

export type GraphQLRunner = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<{ data?: Record<string, unknown>; errors?: unknown[] }>;

/** Inclusive [start, end] UTC date chunks covering the window, non-overlapping. */
export function dateRangeChunks(
  start: Date,
  end: Date,
  stepDays: number = CHUNK_DAYS,
): Array<{ start: Date; end: Date }> {
  const chunks: Array<{ start: Date; end: Date }> = [];
  const startUtc = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  const endUtc = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  );
  for (let cur = startUtc; cur <= endUtc; cur += stepDays * 86_400_000) {
    chunks.push({
      start: new Date(cur),
      end: new Date(Math.min(cur + (stepDays - 1) * 86_400_000, endUtc)),
    });
  }
  return chunks;
}

export function searchQueryForWindow(chunkStart: Date, chunkEnd: Date): string {
  const from = chunkStart.toISOString().slice(0, 10);
  const to = chunkEnd.toISOString().slice(0, 10);
  return `repo:${REPOSITORY_OWNER}/${REPOSITORY_NAME} is:pr is:merged merged:${from}..${to}`;
}

function toRecord(node: SearchNode): ForceMergeRecord | null {
  if (!node || typeof node.number !== "number" || !node.mergedAt) return null;
  const mergedBy = node.mergedBy?.login ?? null;
  return {
    prNumber: node.number,
    title: node.title ?? "",
    url: node.url ?? "",
    author: node.author?.login ?? null,
    mergedBy,
    mergedAt: node.mergedAt,
    forceMerged: mergedBy === FORCE_MERGE_LOGIN,
  };
}

/** All merged PRs in one week-sized window, paginated through the search API. */
export async function fetchWindowRecords(
  runner: GraphQLRunner,
  chunkStart: Date,
  chunkEnd: Date,
): Promise<ForceMergeRecord[]> {
  const query = searchQueryForWindow(chunkStart, chunkEnd);
  const records: ForceMergeRecord[] = [];
  let cursor: string | null = null;

  do {
    const payload = await runner(MERGED_PR_SEARCH_QUERY, { q: query, cursor });
    if (payload.errors?.length) {
      throw new Error(`GitHub GraphQL errors: ${JSON.stringify(payload.errors)}`);
    }
    const search = payload.data?.search as GraphQLSearchResult | undefined;
    if (!search) {
      throw new Error(`GitHub GraphQL search returned no data for ${query}`);
    }
    for (const node of search.nodes) {
      const record = toRecord(node);
      if (record) records.push(record);
    }
    cursor = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
  } while (cursor);

  return records;
}

/** Merged PRs over the whole window, newest first, deduplicated by PR number. */
export async function collectForceMergeRecords(options: {
  token: string;
  days?: number;
  now?: Date;
  runner?: GraphQLRunner;
}): Promise<ForceMergeRecord[]> {
  const days = options.days ?? 182;
  const now = options.now ?? new Date();
  const windowStart = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - days,
    ),
  );
  const windowEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  const runner: GraphQLRunner =
    options.runner ??
    (async (query, variables) => {
      const response = await fetch(GITHUB_GRAPHQL_URL, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
          "User-Agent": "vllm-dashboard",
        },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(
          `GitHub GraphQL request failed: ${response.status} ${response.statusText}`,
        );
      }
      return (await response.json()) as {
        data?: Record<string, unknown>;
        errors?: unknown[];
      };
    });

  const byNumber = new Map<number, ForceMergeRecord>();
  for (const chunk of dateRangeChunks(windowStart, windowEnd)) {
    for (const record of await fetchWindowRecords(runner, chunk.start, chunk.end)) {
      byNumber.set(record.prNumber, record);
    }
  }

  return [...byNumber.values()].sort((a, b) =>
    b.mergedAt.localeCompare(a.mergedAt),
  );
}
