import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyImage,
  describeImage,
  groupImagesByKind,
  resolveComparePresets,
  sortImagesByKind,
} from "./commit-from-image";

test("classifies release tags", () => {
  assert.deepEqual(classifyImage("vllm/vllm-openai:v0.26.0"), {
    kind: "release",
    version: "0.26.0",
  });
  assert.deepEqual(classifyImage("vllm/vllm-openai-rocm:v0.25.1"), {
    kind: "release",
    version: "0.25.1",
  });
  // Release tag with a build suffix must not be misread as a commit sha.
  assert.deepEqual(classifyImage("vllm-openai-rocm:v0.25.1-aiter-1ba09a47"), {
    kind: "release",
    version: "0.25.1",
  });
});

test("classifies nightly tags", () => {
  assert.deepEqual(classifyImage("vllm/vllm-openai:nightly"), {
    kind: "nightly",
  });
  assert.deepEqual(
    classifyImage(
      "vllm/vllm-openai:nightly-94c0ef300180f8fd1071d9cbe7270a8348155f94"
    ),
    { kind: "nightly", sha: "94c0ef300180f8fd1071d9cbe7270a8348155f94" }
  );
  assert.deepEqual(classifyImage("vllm/vllm-openai-rocm:nightly-v0.23.0"), {
    kind: "nightly",
    version: "0.23.0",
  });
  assert.deepEqual(classifyImage("repo/image:nightly-2026-09-01"), {
    kind: "nightly",
    date: "2026-09-01",
  });
});

test("classifies commit-sha tags", () => {
  assert.deepEqual(
    classifyImage(
      "public.ecr.aws/q9t5s3a7/vllm-release-repo:33898f832c53c3e98999e0ec2c689f61ee92a9bc-x86_64"
    ),
    { kind: "commit", sha: "33898f832c53c3e98999e0ec2c689f61ee92a9bc" }
  );
  assert.deepEqual(
    classifyImage(
      "public.ecr.aws/q9t5s3a7/vllm-release-repo:2dfaae752b4db0d43cfc0715c780e33be030d0f1"
    ),
    { kind: "commit", sha: "2dfaae752b4db0d43cfc0715c780e33be030d0f1" }
  );
  // Short-sha-only tags still count as commits.
  assert.deepEqual(classifyImage("glm52-vllm-0251-aiter:91f582c134c3"), {
    kind: "commit",
    sha: "91f582c134c3",
  });
});

test("classifies other images", () => {
  assert.deepEqual(classifyImage("lmsysorg/sglang:latest"), { kind: "other" });
  assert.deepEqual(classifyImage("vllm/vllm-openai:minimax-m3"), {
    kind: "other",
  });
  assert.deepEqual(classifyImage("auth-smoke"), { kind: "other" });
  // Digest-pinned images carry no usable tag.
  assert.deepEqual(
    classifyImage(
      "vllm/vllm-openai@sha256:e90e2603b2781936651ba019804137714367c69e10a7b25a2e57b46995225616"
    ),
    { kind: "other" }
  );
  assert.deepEqual(classifyImage(null), { kind: "other" });
  assert.deepEqual(classifyImage(undefined), { kind: "other" });
});

const DATES = {
  "vllm/vllm-openai:nightly-aaa1111111111111111111111111111111111111":
    "2026-08-30",
  "vllm/vllm-openai:nightly-bbb2222222222222222222222222222222222222":
    "2026-09-01",
  "vllm/vllm-openai:nightly-ccc3333333333333333333333333333333333333":
    "2026-09-02",
  "vllm/vllm-openai:v0.25.1": "2026-08-10",
  "vllm/vllm-openai:v0.26.0": "2026-08-20",
  "public.ecr.aws/q9t5s3a7/vllm-release-repo:33898f832c53c3e98999e0ec2c689f61ee92a9bc-x86_64":
    "2026-09-01",
  "lmsysorg/sglang:latest": "2026-07-01",
};

const IMAGES = Object.keys(DATES);

test("groupImagesByKind sorts each group newest first", () => {
  const groups = groupImagesByKind(IMAGES, DATES);
  assert.deepEqual(
    groups.nightly,
    [
      "vllm/vllm-openai:nightly-ccc3333333333333333333333333333333333333",
      "vllm/vllm-openai:nightly-bbb2222222222222222222222222222222222222",
      "vllm/vllm-openai:nightly-aaa1111111111111111111111111111111111111",
    ]
  );
  // Releases sort by version even without run dates.
  assert.deepEqual(groups.release, [
    "vllm/vllm-openai:v0.26.0",
    "vllm/vllm-openai:v0.25.1",
  ]);
  assert.deepEqual(groups.commit, [
    "public.ecr.aws/q9t5s3a7/vllm-release-repo:33898f832c53c3e98999e0ec2c689f61ee92a9bc-x86_64",
  ]);
  assert.deepEqual(groups.other, ["lmsysorg/sglang:latest"]);
});

test("sortImagesByKind flattens groups in kind order", () => {
  const sorted = sortImagesByKind(IMAGES, DATES);
  assert.deepEqual(
    sorted.map((image) => classifyImage(image).kind),
    ["nightly", "nightly", "nightly", "release", "release", "commit", "other"]
  );
});

test("resolveComparePresets resolves all four presets", () => {
  const presets = resolveComparePresets(IMAGES, DATES);
  const byId = new Map(presets.map((p) => [p.id, p]));

  assert.equal(presets.length, 4);
  assert.equal(
    byId.get("nightly-vs-previous-nightly")?.baseline,
    "vllm/vllm-openai:nightly-bbb2222222222222222222222222222222222222"
  );
  assert.equal(
    byId.get("nightly-vs-previous-nightly")?.candidate,
    "vllm/vllm-openai:nightly-ccc3333333333333333333333333333333333333"
  );
  assert.equal(
    byId.get("release-vs-previous-release")?.baseline,
    "vllm/vllm-openai:v0.25.1"
  );
  assert.equal(
    byId.get("release-vs-previous-release")?.candidate,
    "vllm/vllm-openai:v0.26.0"
  );
  assert.equal(
    byId.get("nightly-vs-release")?.baseline,
    "vllm/vllm-openai:v0.26.0"
  );
  assert.equal(
    byId.get("main-commit-vs-release")?.candidate,
    "public.ecr.aws/q9t5s3a7/vllm-release-repo:33898f832c53c3e98999e0ec2c689f61ee92a9bc-x86_64"
  );
});

test("resolveComparePresets hides presets that do not resolve", () => {
  // A single nightly and no releases: only no preset can resolve.
  assert.deepEqual(
    resolveComparePresets(["vllm/vllm-openai:nightly"], {}),
    []
  );
  // Two nightlies but nothing else.
  const presets = resolveComparePresets(
    ["vllm/vllm-openai:nightly", "vllm/vllm-openai:nightly-abc1234"],
    {}
  );
  assert.deepEqual(
    presets.map((p) => p.id),
    ["nightly-vs-previous-nightly"]
  );
});

test("resolveComparePresets never mixes repos within a pair", () => {
  // The ROCm nightly is the most recent; presets must stick to its repo.
  const presets = resolveComparePresets(
    [
      "vllm/vllm-openai-rocm:nightly-ddd4444444444444444444444444444444444444",
      ...IMAGES,
    ],
    { ...DATES, "vllm/vllm-openai-rocm:nightly-ddd4444444444444444444444444444444444444": "2026-09-03" }
  );
  const nightlyPreset = presets.find(
    (p) => p.id === "nightly-vs-previous-nightly"
  );
  // Only one ROCm nightly exists, so the nightly pair cannot resolve.
  assert.equal(nightlyPreset, undefined);
  const crossPreset = presets.find((p) => p.id === "nightly-vs-release");
  assert.equal(
    crossPreset?.candidate,
    "vllm/vllm-openai-rocm:nightly-ddd4444444444444444444444444444444444444"
  );
});

test("describeImage renders human labels", () => {
  assert.equal(
    describeImage("vllm/vllm-openai:v0.26.0"),
    "release v0.26.0"
  );
  assert.equal(
    describeImage(
      "vllm/vllm-openai:nightly-94c0ef300180f8fd1071d9cbe7270a8348155f94"
    ),
    "nightly 94c0ef3"
  );
  assert.equal(
    describeImage(
      "public.ecr.aws/q9t5s3a7/vllm-release-repo:33898f832c53c3e98999e0ec2c689f61ee92a9bc-rocm"
    ),
    "commit 33898f8"
  );
  assert.equal(describeImage("vllm/vllm-openai:nightly"), "nightly (moving tag)");
  assert.equal(describeImage("lmsysorg/sglang:latest"), "latest");
  // Run date appended when available.
  const withDate = describeImage("vllm/vllm-openai:v0.26.0", {
    "vllm/vllm-openai:v0.26.0": "2026-08-20",
  });
  assert.match(withDate, /^release v0\.26\.0 · /);
});
