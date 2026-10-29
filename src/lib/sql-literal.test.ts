import assert from "node:assert/strict";
import test from "node:test";

import { escapeSqlString } from "./sql-literal";

test("escapeSqlString escapes backslashes before quotes", () => {
  assert.equal(escapeSqlString("main"), "main");
  assert.equal(escapeSqlString("it's"), "it\\'s");
  // The breakout: a trailing backslash would escape the closing quote.
  assert.equal(escapeSqlString("x\\' , 42 AS injected --"), "x\\\\\\' , 42 AS injected --");
  assert.equal(escapeSqlString("ends\\"), "ends\\\\");
  // Regex escapes reach Databricks intact (RLIKE '^mi\d+').
  assert.equal(escapeSqlString("^mi\\d+"), "^mi\\\\d+");
});

test("no escaped value can close a single-quoted literal", () => {
  for (const value of ["'", "\\'", "\\\\'", "''", "a\\", "\\u0027"]) {
    const escaped = escapeSqlString(value);
    // Every quote is preceded by an odd run of backslashes.
    for (const match of escaped.matchAll(/(\\*)'/g)) {
      assert.equal(match[1].length % 2, 1, `${value} → ${escaped}`);
    }
    // And the literal never ends in an unescaped backslash.
    const trailing = escaped.match(/\\*$/)![0].length;
    assert.equal(trailing % 2, 0, `${value} → ${escaped}`);
  }
});
