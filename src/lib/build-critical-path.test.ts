import assert from "node:assert/strict";
import test from "node:test";

import { criticalPathIds } from "./build-critical-path";

const T0 = Date.parse("2026-09-09T23:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1_000).toISOString();

function lane(id: string, start: number, end: number) {
  return { id, startTime: at(start), endTime: at(end) };
}

/** Bootstrap plus `count` jobs released within a few seconds of it ending. */
function fanOut(count: number, gateEnd: number, prefix = "job") {
  return Array.from({ length: count }, (_, index) =>
    lane(`${prefix}-${index}`, gateEnd + 1 + (index % 8), gateEnd + 600 + index * 30),
  );
}

test("a fan-out build yields bootstrap plus the single longest job", () => {
  // Under the old furthest-end frontier, every job whose end exceeded all
  // earlier-starting jobs was amber, which in a real nightly was 13 lanes.
  const lanes = [lane("bootstrap", 0, 50), ...fanOut(12, 50), lane("longest", 55, 62 * 60)];

  assert.deepEqual([...criticalPathIds(lanes)].sort(), ["bootstrap", "longest"]);
});

test("jobs finishing within a minute of the build end all bound it", () => {
  const lanes = [
    lane("bootstrap", 0, 50),
    ...fanOut(12, 50),
    lane("xpu", 882, 4477),
    lane("mi300", 1030, 4470),
    lane("b200", 2158, 4276),
  ];
  const chain = criticalPathIds(lanes);

  assert.ok(chain.has("xpu"));
  assert.ok(chain.has("mi300"));
  assert.ok(!chain.has("b200"));
});

test("a job gated on an image build includes the image build in the chain", () => {
  const lanes = [
    lane("bootstrap", 0, 50),
    ...fanOut(12, 50),
    lane("build-image", 55, 20 * 60),
    ...fanOut(20, 20 * 60, "gpu"),
    lane("gpu-tests", 20 * 60 + 8, 55 * 60),
  ];

  assert.deepEqual(
    [...criticalPathIds(lanes)].sort(),
    ["bootstrap", "build-image", "gpu-tests"],
  );
});

test("a job that merely finishes during a start burst is not a gate", () => {
  // The AMD image build ends at 1015s and releases the AMD shards over the
  // next 20s. An unrelated H200 job ends at 1030s in the middle of that
  // burst; under a naive "latest lane to finish before I started" rule it
  // would be blamed for the MI300 job that started at 1030s.
  const lanes = [
    lane("bootstrap", 0, 50),
    ...fanOut(12, 50),
    lane("amd-image", 55, 1015),
    ...Array.from({ length: 40 }, (_, index) =>
      lane(`amd-${index}`, 1016 + (index % 20), 2000 + index),
    ),
    lane("h200-coincidence", 144, 1030),
    lane("mi300", 1030, 4470),
  ];
  const chain = criticalPathIds(lanes);

  assert.deepEqual([...chain].sort(), ["amd-image", "bootstrap", "mi300"]);
});

test("a long queue wait breaks the chain rather than inventing a predecessor", () => {
  // The XPU test was gated by an image build at 144s but waited twelve
  // minutes for an agent. Nothing gated a burst near 882s, so the chain
  // stops at the test itself instead of blaming whatever ended at 881s.
  const lanes = [
    lane("bootstrap", 0, 50),
    ...fanOut(12, 50),
    lane("coincidence", 144, 881),
    lane("xpu", 882, 4477),
  ];

  assert.deepEqual([...criticalPathIds(lanes)].sort(), ["xpu"]);
});

test("a small fan-out in a large build is not a gate", () => {
  // 200 lanes: a lane whose end happens to precede six starts is noise.
  const lanes = [
    lane("bootstrap", 0, 50),
    ...fanOut(190, 50),
    lane("coincidence", 60, 300),
    ...Array.from({ length: 6 }, (_, index) => lane(`late-${index}`, 302 + index, 900)),
    lane("longest", 305, 7200),
  ];

  assert.deepEqual([...criticalPathIds(lanes)].sort(), ["longest"]);
});

test("a tiny build with no fan-out marks only the last job", () => {
  const chain = criticalPathIds([lane("a", 0, 50), lane("b", 55, 600), lane("c", 60, 300)]);
  assert.deepEqual([...chain], ["b"]);
});

test("empty and malformed input yield an empty chain", () => {
  assert.equal(criticalPathIds([]).size, 0);
  assert.equal(
    criticalPathIds([{ id: "x", startTime: "nope", endTime: "nope" }]).size,
    0,
  );
});
