import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresErrorCode } from "./postgres-errors";

test("matches an exact PostgreSQL error code", () => {
  assert.equal(hasPostgresErrorCode({ code: "42P01" }, "42P01"), true);
  assert.equal(hasPostgresErrorCode({ code: "42703" }, "42P01"), false);
});

test("rejects non-error values safely", () => {
  assert.equal(hasPostgresErrorCode(null, "42P01"), false);
  assert.equal(hasPostgresErrorCode("42P01", "42P01"), false);
  assert.equal(hasPostgresErrorCode({}, "42P01"), false);
});
