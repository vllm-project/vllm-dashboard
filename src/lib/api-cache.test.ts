import assert from "node:assert/strict";
import test from "node:test";

import { cacheSize, getCached, setCache } from "./api-cache";

test("the cache keeps at most 500 entries, dropping the least recently used", () => {
  setCache("keep", 1, 60_000);
  for (let i = 0; i < 499; i++) setCache(`k${i}`, i, 60_000);
  assert.equal(getCached("keep"), 1); // touched: now most recent
  for (let i = 499; i < 1_000; i++) setCache(`k${i}`, i, 60_000);
  assert.equal(cacheSize(), 500);
  assert.equal(getCached("k0"), undefined);
  assert.equal(getCached("k999"), 999);
});

test("expired entries are dropped when read", () => {
  setCache("old", 1, -1);
  assert.equal(getCached("old"), undefined);
});
