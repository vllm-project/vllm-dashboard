import assert from "node:assert/strict";
import test from "node:test";
import { getOrLoadCached, setCache } from "./api-cache";

test("failed concurrent cache fills can be retried", async () => {
  let calls = 0;
  const load = async () => {
    calls++;
    throw new Error("temporary backend failure");
  };
  const results = await Promise.allSettled([
    getOrLoadCached("retry-test", 60_000, load),
    getOrLoadCached("retry-test", 60_000, load),
  ]);
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.deepEqual(await getOrLoadCached("retry-test", 60_000, async () => "recovered"), {
    data: "recovered", status: "MISS",
  });
});

test("expired data is refreshed, including falsy cached values", async (t) => {
  t.mock.method(Date, "now", () => 1000);
  setCache("expiry-test", "old", 10);
  t.mock.method(Date, "now", () => 1011);
  assert.deepEqual(await getOrLoadCached("expiry-test", 10, async () => false), {
    data: false, status: "MISS",
  });
  assert.deepEqual(await getOrLoadCached("expiry-test", 10, async () => "wrong"), {
    data: false, status: "HIT",
  });
});
