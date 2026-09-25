import assert from "node:assert/strict";
import test from "node:test";
import {
  CI_STATUS_CONTEXT,
  type CommitStatus,
  type GitHubClient,
  type GraphQLRunner,
  ciStateAtMerge,
  dateRangeChunks,
  fetchWindowRecords,
  ingestStartDate,
  searchQueryForWindow,
} from "./force-merge-stats";

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

test("dateRangeChunks covers the window inclusively without overlap", () => {
  const chunks = dateRangeChunks(
    utcDate("2026-06-01"),
    utcDate("2026-06-20"),
    7,
  );
  assert.deepEqual(
    chunks.map((chunk) => [isoDay(chunk.start), isoDay(chunk.end)]),
    [
      ["2026-06-01", "2026-06-07"],
      ["2026-06-08", "2026-06-14"],
      ["2026-06-15", "2026-06-20"],
    ],
  );
});

test("dateRangeChunks defaults to one chunk per UTC day", () => {
  const chunks = dateRangeChunks(
    new Date("2026-06-01T18:00:00Z"),
    new Date("2026-06-03T01:00:00Z"),
  );
  assert.deepEqual(
    chunks.map((chunk) => [isoDay(chunk.start), isoDay(chunk.end)]),
    [
      ["2026-06-01", "2026-06-01"],
      ["2026-06-02", "2026-06-02"],
      ["2026-06-03", "2026-06-03"],
    ],
  );
});

test("searchQueryForWindow targets merged PRs in the repository", () => {
  assert.equal(
    searchQueryForWindow(utcDate("2026-06-01"), utcDate("2026-06-07")),
    "repo:vllm-project/vllm is:pr is:merged merged:2026-06-01..2026-06-07",
  );
});

test("ingestStartDate backfills an empty table and otherwise resumes near the newest merge", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  assert.equal(isoDay(ingestStartDate(null, now, 182)), "2026-03-27");
  assert.equal(
    isoDay(ingestStartDate(new Date("2026-09-24T23:59:00Z"), now, 182)),
    "2026-09-23",
    "re-reads the day before the newest stored merge",
  );
  assert.equal(
    isoDay(ingestStartDate(new Date("2025-01-01T00:00:00Z"), now, 182)),
    "2026-03-27",
    "never reaches past the backfill window",
  );
});

function prNode(
  number: number,
  mergedAt: string,
  ci: { state: string; createdAt: string } | null,
  mergedBy = "maintainer",
) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/vllm-project/vllm/pull/${number}`,
    mergedAt,
    author: { login: `author-${number}` },
    mergedBy: { login: mergedBy },
    commits: {
      nodes: [{ commit: { oid: `sha-${number}`, status: { context: ci } } }],
    },
  };
}

function searchResponse(nodes: unknown[], endCursor: string | null = null) {
  return {
    data: {
      search: {
        issueCount: nodes.length,
        pageInfo: { hasNextPage: endCursor !== null, endCursor },
        nodes,
      },
    },
  };
}

function client(
  graphql: GraphQLRunner,
  statuses: Record<string, CommitStatus[][]> = {},
): GitHubClient {
  return {
    graphql,
    commitStatuses: async (sha, page) => statuses[sha]?.[page - 1] ?? [],
  };
}

test("fetchWindowRecords flags PRs merged on red buildkite/ci/pr, whoever merged them", async () => {
  const cursors: unknown[] = [];
  const graphql: GraphQLRunner = async (_query, variables) => {
    cursors.push(variables.cursor);
    if (cursors.length === 1) {
      return searchResponse(
        [
          prNode(101, "2026-06-02T10:00:00Z", {
            state: "FAILURE",
            createdAt: "2026-06-02T09:00:00Z",
          }),
          prNode(102, "2026-06-02T11:00:00Z", {
            state: "ERROR",
            createdAt: "2026-06-02T10:00:00Z",
          }),
          null,
        ],
        "cursor-1",
      );
    }
    return searchResponse([
      prNode(
        103,
        "2026-06-03T10:00:00Z",
        { state: "SUCCESS", createdAt: "2026-06-03T09:00:00Z" },
        "vllm-bot",
      ),
      prNode(104, "2026-06-03T11:00:00Z", {
        state: "PENDING",
        createdAt: "2026-06-03T10:30:00Z",
      }),
      prNode(105, "2026-06-03T12:00:00Z", null),
      // Search results can shift between pages.
      prNode(101, "2026-06-02T10:00:00Z", {
        state: "FAILURE",
        createdAt: "2026-06-02T09:00:00Z",
      }),
    ]);
  };

  const records = await fetchWindowRecords(
    client(graphql),
    utcDate("2026-06-02"),
    utcDate("2026-06-03"),
  );

  assert.deepEqual(cursors, [null, "cursor-1"]);
  assert.deepEqual(
    records.map((r) => [r.prNumber, r.ciState, r.forceMerged]),
    [
      [101, "failure", true],
      [102, "error", true],
      [103, "success", false],
      [104, "pending", false],
      [105, null, false],
    ],
  );
  assert.equal(records[2].mergedBy, "vllm-bot");
  assert.equal(records[0].headSha, "sha-101");
});

function status(context: string, createdAt: string, state: string): CommitStatus {
  return { context, state, created_at: createdAt };
}

const JOB_CONTEXT = `${CI_STATUS_CONTEXT}/nvidia-h100-e2e`;

test("ciStateAtMerge walks the status history back to the merge when CI reported afterwards", async () => {
  // Build went red mid-run, the PR was merged, then the build finished red.
  // The pre-merge entry sits on page two behind per-job statuses.
  const history = {
    sha: [
      [
        status(CI_STATUS_CONTEXT, "2026-09-21T16:43:14Z", "failure"),
        ...Array.from({ length: 99 }, () =>
          status(JOB_CONTEXT, "2026-09-21T16:00:00Z", "success"),
        ),
      ],
      [
        status(JOB_CONTEXT, "2026-09-21T15:50:00Z", "failure"),
        status(CI_STATUS_CONTEXT, "2026-09-21T15:45:19Z", "failure"),
        status(CI_STATUS_CONTEXT, "2026-09-21T15:30:54Z", "pending"),
      ],
    ],
  };
  const state = await ciStateAtMerge(
    client(async () => ({}), history),
    "sha",
    { state: "FAILURE", createdAt: "2026-09-21T16:43:14Z" },
    "2026-09-21T16:39:21Z",
  );
  assert.equal(state, "failure");
});

test("ciStateAtMerge does not count a PR merged while a rerun was pending", async () => {
  // Red build, rerun started, PR merged mid-rerun, rerun passed afterwards.
  const history = {
    sha: [
      [
        status(CI_STATUS_CONTEXT, "2026-09-21T02:38:45Z", "success"),
        status(CI_STATUS_CONTEXT, "2026-09-21T02:13:24Z", "pending"),
        status(CI_STATUS_CONTEXT, "2026-09-20T13:23:10Z", "failure"),
      ],
    ],
  };
  const state = await ciStateAtMerge(
    client(async () => ({}), history),
    "sha",
    { state: "SUCCESS", createdAt: "2026-09-21T02:38:45Z" },
    "2026-09-21T02:17:24Z",
  );
  assert.equal(state, "pending");
});

test("fetchWindowRecords surfaces GraphQL errors", async () => {
  const graphql: GraphQLRunner = async () => ({
    errors: [{ message: "bad credentials" }],
  });
  await assert.rejects(
    fetchWindowRecords(
      client(graphql),
      utcDate("2026-06-01"),
      utcDate("2026-06-07"),
    ),
    /bad credentials/,
  );
});
