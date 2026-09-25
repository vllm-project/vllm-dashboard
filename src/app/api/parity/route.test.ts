import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import type {
  ParityHistoryResponse,
  ParitySnapshotResponse,
} from "@/lib/gpu-parity-source";
import { GET as getSnapshot } from "./route";
import { GET as getHistory } from "./history/route";

const commit = "0123456789abcdef0123456789abcdef01234567";
const file = ".buildkite/test_areas/parity-fixture.yaml";
const fixture = `
group: Mixed backends
steps:
  - label: ":nvidia: FlashInfer Attention"
    key: flashinfer
    device: h100
  - label: ":nvidia: DeepGEMM Kernels"
    key: deepgemm
    device: b200
    optional: true
  - label: ":nvidia: TP2 AsyncTP Fusion E2E"
    key: asynctp
    device: h100
  - label: ":nvidia: MLA Fusion"
    key: mla-fusion
    device: h100
  - label: ":nvidia: H100 DeepSeek Kernels"
    key: deepseek-kernels
    device: h100
  - label: ":nvidia: Optional Shared Kernels"
    key: optional-shared
    device: h100
    optional: true
  - label: ":nvidia: FlashInfer Comparison with AMD Mirror"
    key: mirrored-flashinfer
    device: h100
    soft_fail: true
    mirror:
      amd:
        device: mi300_1
  - label: ":nvidia: (H100) Batch Invariance"
    key: batch-invariance-h100
    device: h100
    optional: true
    mirror:
      amd:
        device: mi355_1
        optional: false
  - label: ":nvidia: (B200) Batch Invariance"
    key: batch-invariance-b200
    device: b200
    optional: false
    soft_fail: true
`;

test("parity snapshot and history use optional-only gating and retain hardware variants", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin === "https://api.github.com" &&
      url.pathname === "/repos/vllm-project/vllm/commits"
    ) {
      assert.equal(url.searchParams.get("path"), ".buildkite/test_areas");
      return Response.json([
        {
          sha: commit,
          commit: { committer: { date: "2026-01-01T00:00:00Z" } },
        },
      ]);
    }
    if (
      url.origin === "https://api.github.com" &&
      url.pathname === "/repos/vllm-project/vllm/contents/.buildkite/test_areas"
    ) {
      assert.equal(url.searchParams.get("ref"), commit);
      return Response.json([{ type: "file", path: file, sha: "parity-fixture-blob" }]);
    }
    if (
      url.href === `https://raw.githubusercontent.com/vllm-project/vllm/${commit}/${file}`
    ) {
      return new Response(fixture);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const response = await getSnapshot();
  assert.equal(response.status, 200);
  const snapshot = (await response.json()) as ParitySnapshotResponse;
  assert.equal(snapshot.source.commit, commit);
  assert.deepEqual(snapshot.summary, {
    all: { nvidiaJobs: 7, mirroredJobs: 2, coverage: 2 / 7 },
    gating: { nvidiaJobs: 5, mirroredJobs: 1, coverage: 1 / 5 },
    nonGating: { nvidiaJobs: 2, mirroredJobs: 1, coverage: 1 / 2 },
  });
  assert.deepEqual(
    snapshot.jobs.map((job) => job.key),
    [
      "asynctp", "mla-fusion", "deepseek-kernels", "optional-shared",
      "mirrored-flashinfer", "batch-invariance-h100", "batch-invariance-b200",
    ],
  );
  const mirrored = snapshot.jobs.find((job) => job.key === "mirrored-flashinfer");
  assert.equal(mirrored?.gating, true);
  assert.equal(mirrored?.softFail, true);
  assert.equal(mirrored?.mirror?.gating, true);
  assert.equal(mirrored?.mirror?.softFail, true);
  const optionalVariant = snapshot.jobs.find((job) => job.key === "batch-invariance-h100");
  assert.equal(optionalVariant?.gating, false);
  assert.equal(optionalVariant?.mirror?.gating, true);
  const requiredVariant = snapshot.jobs.find((job) => job.key === "batch-invariance-b200");
  assert.equal(requiredVariant?.gating, true);
  assert.equal(requiredVariant?.softFail, true);
  assert.equal(requiredVariant?.mirror, null);
  assert.deepEqual(snapshot.groups, [
    {
      group: "Mixed backends",
      file,
      all: snapshot.summary.all,
      gating: snapshot.summary.gating,
    },
  ]);
  assert.deepEqual(
    snapshot.excluded.map(({ job, reason }) => ({
      key: job.key,
      gating: job.gating,
      reason,
    })),
    [
      { key: "flashinfer", gating: true, reason: "FlashInfer-specific job" },
      { key: "deepgemm", gating: false, reason: "DeepGEMM-specific job" },
    ],
  );

  const historyResponse = await getHistory(
    new NextRequest("http://localhost/api/parity/history?weeks=4"),
  );
  assert.equal(historyResponse.status, 200);
  const history = (await historyResponse.json()) as ParityHistoryResponse;
  assert.equal(history.weeks, 4);
  assert.equal(history.samples.length, 4);
  for (const sample of history.samples) {
    assert.equal(sample.commit, commit);
    assert.deepEqual(sample.all, snapshot.summary.all);
    assert.deepEqual(sample.gating, snapshot.summary.gating);
  }
});
