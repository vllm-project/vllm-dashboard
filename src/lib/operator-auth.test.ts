import assert from "node:assert/strict";
import test from "node:test";
import { bearerTokenMatches, cronAuthError } from "./operator-auth";

test("accepts the configured bearer token", () => {
  assert.equal(bearerTokenMatches("Bearer secret-token", "secret-token"), true);
});

test("rejects a wrong token", () => {
  assert.equal(bearerTokenMatches("Bearer other-token", "secret-token"), false);
});

test("rejects a token of a different length", () => {
  assert.equal(bearerTokenMatches("Bearer secret", "secret-token"), false);
  assert.equal(
    bearerTokenMatches("Bearer secret-token-extra", "secret-token"),
    false,
  );
});

test("rejects a missing or malformed Authorization header", () => {
  assert.equal(bearerTokenMatches(null, "secret-token"), false);
  assert.equal(bearerTokenMatches("", "secret-token"), false);
  assert.equal(bearerTokenMatches("secret-token", "secret-token"), false);
  assert.equal(bearerTokenMatches("Basic c2VjcmV0", "secret-token"), false);
  assert.equal(bearerTokenMatches("Bearer ", "secret-token"), false);
});

test("rejects everything when no token is configured", () => {
  assert.equal(bearerTokenMatches("Bearer secret-token", undefined), false);
  assert.equal(bearerTokenMatches("Bearer ", ""), false);
});

test("cronAuthError refuses every caller while CRON_SECRET is unset", () => {
  const saved = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    assert.deepEqual(cronAuthError(null), {
      error: "CRON_SECRET is not configured",
      status: 503,
    });
    process.env.CRON_SECRET = "cron-secret";
    assert.equal(cronAuthError("Bearer cron-secret"), null);
    assert.equal(cronAuthError("Bearer wrong")?.status, 401);
    assert.equal(cronAuthError(null)?.status, 401);
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  }
});
