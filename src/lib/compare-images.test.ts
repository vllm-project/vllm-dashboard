import assert from "node:assert/strict";
import test from "node:test";
import {
  compareImageLabel,
  latestNightlyPair,
  latestReleasePair,
} from "./compare-images";

test("latestReleasePair selects the two newest official releases", () => {
  assert.deepEqual(
    latestReleasePair([
      "vllm/vllm-openai:v0.25.1",
      "vllm/vllm-openai-rocm:v0.30.0",
      "vllm/vllm-openai:v0.9.0",
      "vllm/vllm-openai:v0.26.0",
    ]),
    {
      baseline: "vllm/vllm-openai:v0.25.1",
      candidate: "vllm/vllm-openai:v0.26.0",
    }
  );
});

test("latestNightlyPair prefers the canonical previous image", () => {
  const previous = "public.ecr.aws/vllm-release-repo:bbbbbbbb-x86_64";
  const latest = "public.ecr.aws/vllm-release-repo:aaaaaaaa-x86_64";
  assert.deepEqual(
    latestNightlyPair(
      [
        {
          sourceImage: latest,
          deltaVsPrev: { prevSourceImage: previous },
        },
      ],
      [latest, previous]
    ),
    { baseline: previous, candidate: latest }
  );
});

test("latestNightlyPair ignores pairs missing from the compare filters", () => {
  assert.equal(
    latestNightlyPair(
      [
        {
          sourceImage: "nightly-current",
          deltaVsPrev: { prevSourceImage: "nightly-previous" },
        },
      ],
      ["nightly-current"]
    ),
    null
  );
});

test("compareImageLabel makes release and nightly images scannable", () => {
  assert.equal(
    compareImageLabel("vllm/vllm-openai:v0.26.0"),
    "Release v0.26.0"
  );
  assert.equal(
    compareImageLabel(
      "public.ecr.aws/q9t5s3a7/vllm-release-repo:aa9903490c616dc6871e5acc62cec7bb1e5e9434-x86_64"
    ),
    "Nightly aa99034 · x86 64"
  );
});
