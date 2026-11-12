import assert from "node:assert/strict";
import test from "node:test";

import type { PlatformScopeResponse } from "@/lib/platform-scope-source";
import { GET } from "./route";

const commit = "89abcdef0123456789abcdef0123456789abcdef";
const file = ".buildkite/test_areas/platform-fixture.yaml";
const fixture = `
group: Platform fixture
steps:
  - label: ":nvidia: (H100) Mirrored"
    key: mirrored
    device: h100
    mirror:
      amd:
        device: mi300_1
  - label: ":nvidia: (B200) MiniMax M3 MegaMoE"
    key: minimax-m3-mega-moe-test-b200
    device: b200-k8s
  - label: ":amd: (MI355 DPX) UMBP Connector Unit Tests"
    key: amd-umbp-connector-unit-mi355
    device: mi355_dpx
  - label: ":computer: (CPU) Lint"
    device: cpu-small
`;

test("platform scope route reads test_areas at main's latest commit", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/repos/vllm-project/vllm/commits") {
      return Response.json([
        { sha: commit, commit: { committer: { date: "2026-11-01T00:00:00Z" } } },
      ]);
    }
    if (url.pathname === "/repos/vllm-project/vllm/contents/.buildkite/test_areas") {
      assert.equal(url.searchParams.get("ref"), commit);
      return Response.json([{ type: "file", path: file, sha: "platform-fixture-blob" }]);
    }
    if (url.href === `https://raw.githubusercontent.com/vllm-project/vllm/${commit}/${file}`) {
      return new Response(fixture);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const response = await GET();
  assert.equal(response.status, 200);
  const snapshot = (await response.json()) as PlatformScopeResponse;
  assert.equal(snapshot.source.commit, commit);
  assert.deepEqual(
    snapshot.jobs.map((job) => [job.id, job.scope]),
    [
      ["mirrored", "common"],
      ["minimax-m3-mega-moe-test-b200", "nvidia-only"],
      ["amd-umbp-connector-unit-mi355", "rocm-only"],
    ],
  );
  assert.equal(snapshot.summary.all.commonOnBoth, 1);
  assert.equal(snapshot.skipped.cpuJobs, 1);
});
