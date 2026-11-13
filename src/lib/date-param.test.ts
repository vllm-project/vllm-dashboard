import assert from "node:assert/strict";
import test from "node:test";

import { isValidDateParam } from "./date-param";

test("dates, timestamps and absent values pass", () => {
  for (const value of [null, "", "2026-10-20", "2026-10-20T10:00:00.000Z", "2026-10-20T10:00Z"]) {
    assert.equal(isValidDateParam(value), true, String(value));
  }
});

test("anything else is refused", () => {
  for (const value of ["2026-13-45", "yesterday", "2026-10-20' OR 1=1", "2026-10-20\\", "2026-10-20T10:00:00.000Z x"]) {
    assert.equal(isValidDateParam(value), false, value);
  }
});
