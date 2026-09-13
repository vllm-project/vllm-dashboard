import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "./route";

const endpoint = "http://localhost/api/alerts/main-ci/updates";

function request(body: string, headers: Record<string, string> = {}) {
  return new NextRequest(endpoint, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

function preserveEnvironment() {
  const token = process.env.ALERT_AGENT_TOKEN;
  return () => {
    if (token === undefined) delete process.env.ALERT_AGENT_TOKEN;
    else process.env.ALERT_AGENT_TOKEN = token;
  };
}

test("agent update route fails closed before reading the body", async () => {
  const restore = preserveEnvironment();
  try {
    delete process.env.ALERT_AGENT_TOKEN;
    const response = await POST(request("not-json"));
    assert.equal(response.status, 503);
  } finally {
    restore();
  }
});

test("agent update route rejects a bad token before reading the body", async () => {
  const restore = preserveEnvironment();
  try {
    process.env.ALERT_AGENT_TOKEN = "correct-secret";
    const response = await POST(
      request("not-json", { authorization: "Bearer wrong-secret" }),
    );
    assert.equal(response.status, 401);
  } finally {
    restore();
  }
});

test("agent update route validates encoding and bounds request bytes", async () => {
  const restore = preserveEnvironment();
  try {
    process.env.ALERT_AGENT_TOKEN = "secret";
    const auth = { authorization: "Bearer secret" };
    const wrongType = await POST(
      request("{}", { ...auth, "content-type": "text/plain" }),
    );
    const compressed = await POST(
      request("{}", { ...auth, "content-encoding": "gzip" }),
    );
    const oversized = await POST(
      request(JSON.stringify({ padding: "x".repeat(33 * 1024) }), auth),
    );
    assert.equal(wrongType.status, 415);
    assert.equal(compressed.status, 415);
    assert.equal(oversized.status, 413);
  } finally {
    restore();
  }
});

test("agent update route reports malformed and invalid JSON without a DB call", async () => {
  const restore = preserveEnvironment();
  try {
    process.env.ALERT_AGENT_TOKEN = "secret";
    const auth = { authorization: "Bearer secret" };
    const malformed = await POST(request("not-json", auth));
    const invalid = await POST(request("{}", auth));
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      error: "Request body must be JSON.",
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), {
      error: "alertId must be a positive integer.",
    });
  } finally {
    restore();
  }
});
