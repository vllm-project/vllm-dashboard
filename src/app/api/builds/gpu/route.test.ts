import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET } from "./route";

test("GPU queries require an exact job identity and a bounded, positive time interval", async () => {
  const valid = { organization: "vllm", pipeline: "ci", buildNumber: "42", jobId: "00000000-0000-0000-0000-000000000001", start: "2026-09-11T00:00:00Z", end: "2026-09-11T00:01:00Z" };
  for (const invalid of [{ jobId: "" }, { buildNumber: "42 OR 1=1" }, { organization: "../vllm" }, { start: "yesterday" }, { end: valid.start }, { end: "2026-10-11T00:00:00Z" }]) {
    const query = new URLSearchParams({ ...valid, ...invalid });
    const response = await GET(new NextRequest(`http://localhost/api/builds/gpu?${query}`));
    assert.equal(response.status, 400);
  }
});
