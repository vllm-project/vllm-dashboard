import assert from "node:assert/strict";
import test from "node:test";
import type { MainCiJobAlert } from "./alerts-main-ci";
import { verifyMainCiFixOwnership } from "./main-ci-fix-ownership";

const FAILURE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function candidate(number: number): MainCiJobAlert {
  const pr = {
    number,
    url: `https://github.com/vllm-project/vllm/pull/${number}`,
    title: "Fix the root failure",
  };
  return {
    alertId: "42",
    jobKey: "step:gpu|name:GPU test",
    jobName: "GPU test",
    status: "open",
    openedAt: "2026-08-29T08:00:00.000Z",
    firstFailure: {
      buildkiteJobId: "job-1",
      state: "failed",
      finishedAt: "2026-08-29T08:00:00.000Z",
      buildkiteBuildId: "build-100",
      buildNumber: 100,
      buildUrl: "https://buildkite.com/vllm/ci/builds/100",
      jobUrl: "https://example.test/job-1",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    lastFailure: {
      buildkiteJobId: "job-2",
      state: "failed",
      finishedAt: "2026-08-29T09:00:00.000Z",
      buildkiteBuildId: "build-101",
      buildNumber: 101,
      buildUrl: "https://buildkite.com/vllm/ci/builds/101",
      jobUrl: "https://example.test/job-2",
      commitSha: FAILURE_SHA,
    },
    failureCount: 2,
    resolvedAt: null,
    resolution: null,
    resolutionKind: null,
    analysis: null,
    updates: [
      {
        updateId: "9",
        failureJobId: "job-1",
        failureSignature: "gpu test | runtimeerror | stable marker",
        kind: "fix_opened",
        message: "Opened the fix.",
        fixPrs: [pr],
        author: "Sherlock",
        createdAt: "2026-08-29T08:10:00.000Z",
        stale: true,
        carriedFixPrs: [],
        fixOwnershipStatus: "unverified",
      },
    ],
  };
}

test("an open exact-signature fix is carried to the newer failure", async () => {
  const alerts = await verifyMainCiFixOwnership([candidate(70001)], async () =>
    Response.json({
      state: "open",
      merged: false,
      merge_commit_sha: null,
      base: { ref: "main" },
    }),
  );

  assert.equal(alerts[0].updates[0].fixOwnershipStatus, "carried");
  assert.equal(alerts[0].updates[0].carriedFixPrs[0].number, 70001);
});

test("a merged fix is carried when the failing commit predates it", async () => {
  const mergeSha = "cccccccccccccccccccccccccccccccccccccccc";
  const requested: string[] = [];
  const alerts = await verifyMainCiFixOwnership(
    [candidate(70002)],
    async (input) => {
      const url = String(input);
      requested.push(url);
      return url.includes("/compare/")
        ? Response.json({ status: "behind" })
        : Response.json({
            state: "closed",
            merged: true,
            merge_commit_sha: mergeSha,
            base: { ref: "main" },
          });
    },
  );

  assert.equal(requested.length, 2);
  assert.match(requested[1], new RegExp(`${mergeSha}\\.\\.\\.${FAILURE_SHA}$`));
  assert.equal(alerts[0].updates[0].fixOwnershipStatus, "carried");
});

test("a merged fix already in the failing commit is marked regressed", async () => {
  const alerts = await verifyMainCiFixOwnership(
    [candidate(70003)],
    async (input) =>
      String(input).includes("/compare/")
        ? Response.json({ status: "ahead" })
        : Response.json({
            state: "closed",
            merged: true,
            merge_commit_sha:
              "dddddddddddddddddddddddddddddddddddddddd",
            base: { ref: "main" },
          }),
  );

  assert.equal(alerts[0].updates[0].fixOwnershipStatus, "regressed");
  assert.deepEqual(alerts[0].updates[0].carriedFixPrs, []);
});

test("an open fix targeting another branch is not carried", async () => {
  const alerts = await verifyMainCiFixOwnership([candidate(70005)], async () =>
    Response.json({
      state: "open",
      merged: false,
      merge_commit_sha: null,
      base: { ref: "releases/v0.12.0" },
    }),
  );

  assert.equal(alerts[0].updates[0].fixOwnershipStatus, "stale");
  assert.deepEqual(alerts[0].updates[0].carriedFixPrs, []);
});

test("GitHub failures leave signature-matched ownership unverified", async () => {
  const alerts = await verifyMainCiFixOwnership([candidate(70004)], async () =>
    Response.json({ message: "rate limited" }, { status: 403 }),
  );

  assert.equal(alerts[0].updates[0].fixOwnershipStatus, "unverified");
  assert.deepEqual(alerts[0].updates[0].carriedFixPrs, []);
});
