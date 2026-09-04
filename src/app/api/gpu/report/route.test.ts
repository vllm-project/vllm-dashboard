import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { POST } from "./route";

const endpoint = "http://localhost/api/gpu/report";

function request(
  body: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(endpoint, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

function preserveGpuEnvironment() {
  const secret = process.env.GPU_REPORT_SECRET;
  const maxBytes = process.env.GPU_REPORT_MAX_BYTES;
  return () => {
    if (secret === undefined) delete process.env.GPU_REPORT_SECRET;
    else process.env.GPU_REPORT_SECRET = secret;
    if (maxBytes === undefined) delete process.env.GPU_REPORT_MAX_BYTES;
    else process.env.GPU_REPORT_MAX_BYTES = maxBytes;
  };
}

test("GPU report route fails closed when its secret is not configured", async () => {
  const restore = preserveGpuEnvironment();
  try {
    delete process.env.GPU_REPORT_SECRET;
    const response = await POST(request("{}"));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "GPU report ingestion is not configured",
    });
  } finally {
    restore();
  }
});

test("GPU report route authenticates before inspecting the body", async () => {
  const restore = preserveGpuEnvironment();
  try {
    process.env.GPU_REPORT_SECRET = "correct-secret";
    const response = await POST(
      request("not-json", { authorization: "Bearer wrong-secret" }),
    );
    assert.equal(response.status, 401);
  } finally {
    restore();
  }
});

test("GPU report route validates media type and encoding", async () => {
  const restore = preserveGpuEnvironment();
  try {
    process.env.GPU_REPORT_SECRET = "secret";
    const auth = { authorization: "Bearer secret" };
    const wrongType = await POST(
      request("{}", { ...auth, "content-type": "text/plain" }),
    );
    const compressed = await POST(
      request("{}", { ...auth, "content-encoding": "gzip" }),
    );
    assert.equal(wrongType.status, 415);
    assert.equal(compressed.status, 415);
  } finally {
    restore();
  }
});

test("GPU report route enforces its byte limit while reading the stream", async () => {
  const restore = preserveGpuEnvironment();
  try {
    process.env.GPU_REPORT_SECRET = "secret";
    process.env.GPU_REPORT_MAX_BYTES = "32";
    const response = await POST(
      request(JSON.stringify({ padding: "x".repeat(64) }), {
        authorization: "Bearer secret",
      }),
    );
    assert.equal(response.status, 413);
  } finally {
    restore();
  }
});

test("GPU report route returns a validation error for malformed JSON", async () => {
  const restore = preserveGpuEnvironment();
  try {
    process.env.GPU_REPORT_SECRET = "secret";
    delete process.env.GPU_REPORT_MAX_BYTES;
    const response = await POST(
      request("not-json", { authorization: "Bearer secret" }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Invalid GPU report",
      detail: "payload must be valid JSON",
    });
  } finally {
    restore();
  }
});
