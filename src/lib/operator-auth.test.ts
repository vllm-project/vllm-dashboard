import assert from "node:assert/strict";
import test from "node:test";
import { bearerTokenMatches } from "./operator-auth";

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
