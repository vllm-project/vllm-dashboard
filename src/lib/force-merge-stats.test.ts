import assert from "node:assert/strict";
import test from "node:test";
import {
  FORCE_MERGE_LOGIN,
  collectForceMergeRecords,
  dateRangeChunks,
  fetchWindowRecords,
  searchQueryForWindow,
} from "./force-merge-stats";

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

test("dateRangeChunks covers the window inclusively without overlap", () => {
  const chunks = dateRangeChunks(utcDate("2026-06-01"), utcDate("2026-06-20"));
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((chunk) => [
      chunk.start.toISOString().slice(0, 10),
      chunk.end.toISOString().slice(0, 10),
    ]),
    [
      ["2026-06-01", "2026-06-07"],
      ["2026-06-08", "2026-06-14"],
      ["2026-06-15", "2026-06-20"],
    ],
  );
  for (const [index, chunk] of chunks.entries()) {
    if (index === 0) continue;
    assert.ok(
      chunk.start.getTime() > chunks[index - 1].end.getTime(),
      "chunks must not overlap",
    );
  }
});

test("dateRangeChunks returns one chunk when the window is a single day", () => {
  const chunks = dateRangeChunks(utcDate("2026-06-01"), utcDate("2026-06-01"));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].start.toISOString().slice(0, 10), "2026-06-01");
  assert.equal(chunks[0].end.toISOString().slice(0, 10), "2026-06-01");
});

test("searchQueryForWindow targets merged PRs in the repository", () => {
  const query = searchQueryForWindow(
    utcDate("2026-06-01"),
    utcDate("2026-06-07"),
  );
  assert.equal(
    query,
    "repo:vllm-project/vllm is:pr is:merged merged:2026-06-01..2026-06-07",
  );
});

function searchResponse(nodes: unknown[], hasNextPage = false, cursor = null) {
  return {
    data: {
      search: {
        issueCount: nodes.length,
        pageInfo: { hasNextPage, endCursor: cursor },
        nodes,
      },
    },
  };
}

test("fetchWindowRecords flags force-merges and skips non-PR nodes", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const runner = async (_query: string, variables: Record<string, unknown>) => {
    calls.push(variables);
    if (calls.length === 1) {
      return searchResponse(
        [
          {
            number: 101,
            title: "Fix kernel launch",
            url: "https://github.com/vllm-project/vllm/pull/101",
            mergedAt: "2026-06-02T10:00:00Z",
            author: { login: "alice" },
            mergedBy: { login: FORCE_MERGE_LOGIN },
          },
          null,
        ],
        true,
        "cursor-1",
      );
    }
    return searchResponse([
      {
        number: 102,
        title: "Normal change",
        url: "https://github.com/vllm-project/vllm/pull/102",
        mergedAt: "2026-06-03T10:00:00Z",
        author: { login: "bob" },
        mergedBy: { login: "simon-mo" },
      },
      {
        number: 103,
        title: "Ghost author",
        url: "https://github.com/vllm-project/vllm/pull/103",
        mergedAt: "2026-06-04T10:00:00Z",
        author: null,
        mergedBy: null,
      },
    ]);
  };

  const records = await fetchWindowRecords(
    runner,
    utcDate("2026-06-01"),
    utcDate("2026-06-07"),
  );

  assert.equal(calls[1].cursor, "cursor-1");
  assert.equal(records.length, 3);
  assert.equal(records[0].forceMerged, true);
  assert.equal(records[0].mergedBy, "vllm-bot");
  assert.equal(records[1].forceMerged, false);
  assert.equal(records[2].author, null);
  assert.equal(records[2].mergedBy, null);
  assert.equal(records[2].forceMerged, false);
});

test("fetchWindowRecords surfaces GraphQL errors", async () => {
  const runner = async () => ({ errors: [{ message: "bad credentials" }] });
  await assert.rejects(
    fetchWindowRecords(runner, utcDate("2026-06-01"), utcDate("2026-06-07")),
    /bad credentials/,
  );
});

test("collectForceMergeRecords chunks the window and deduplicates by PR", async () => {
  const queries: string[] = [];
  const runner = async (_query: string, variables: Record<string, unknown>) => {
    queries.push(String(variables.q));
    // The same PR comes back from both chunk queries.
    return searchResponse([
      {
        number: 101,
        title: "Fix kernel launch",
        url: "https://github.com/vllm-project/vllm/pull/101",
        mergedAt: "2026-06-02T10:00:00Z",
        author: { login: "alice" },
        mergedBy: { login: FORCE_MERGE_LOGIN },
      },
    ]);
  };

  const records = await collectForceMergeRecords({
    token: "token",
    days: 10,
    now: utcDate("2026-06-10"),
    runner,
  });

  // 10 days back from 2026-06-10 chunks into 2026-05-31..2026-06-06 and
  // 2026-06-07..2026-06-10.
  assert.equal(queries.length, 2);
  assert.ok(queries[0].endsWith("merged:2026-05-31..2026-06-06"));
  assert.ok(queries[1].endsWith("merged:2026-06-07..2026-06-10"));
  assert.equal(records.length, 1, "repeated PRs collapse to one record");
  assert.equal(records[0].forceMerged, true);
});
