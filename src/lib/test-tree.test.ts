import assert from "node:assert/strict";
import test from "node:test";

import { buildTestTree, parseTestNodeId } from "./test-tree";

const T0 = Date.parse("2026-09-09T23:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1_000).toISOString();

function leaf(
  label: string,
  start: number,
  end: number,
  status: "passed" | "failed" | "skipped" | "unknown" = "passed",
) {
  return { id: label, label, startTime: at(start), endTime: at(end), status };
}

test("parseTestNodeId splits file, function and parameters", () => {
  assert.deepEqual(
    parseTestNodeId("tests/models/test_hybrid.py::test_models[model0-5-True]"),
    { file: "tests/models/test_hybrid.py", testCase: "test_models", params: "[model0-5-True]" },
  );
  assert.deepEqual(parseTestNodeId("tests/a.py::TestX::test_y"), {
    file: "tests/a.py",
    testCase: "TestX::test_y",
    params: null,
  });
  assert.deepEqual(parseTestNodeId("tests/a.py::test_z[a[b]-c]"), {
    file: "tests/a.py",
    testCase: "test_z",
    params: "[a[b]-c]",
  });
  assert.deepEqual(parseTestNodeId("not-a-nodeid"), {
    file: "not-a-nodeid",
    testCase: null,
    params: null,
  });
});

test("tests group into file → function → parameter combination", () => {
  const tree = buildTestTree("cmd", [
    leaf("tests/a.py::test_x[p1]", 10, 20),
    leaf("tests/a.py::test_x[p2]", 20, 35, "failed"),
    leaf("tests/a.py::test_plain", 35, 40),
    leaf("tests/b.py::test_y[q]", 0, 5),
  ]);

  assert.equal(tree.length, 2);
  const [fileB, fileA] = tree;
  assert.equal(fileB.type, "group");
  assert.equal(fileA.type, "group");
  if (fileB.type !== "group" || fileA.type !== "group") return;

  // Ordered by first start.
  assert.equal(fileB.label, "tests/b.py");
  assert.equal(fileA.label, "tests/a.py");
  assert.equal(fileA.kind, "test-file");
  assert.equal(fileA.testCount, 3);
  assert.equal(fileA.failedCount, 1);
  assert.equal(fileA.status, "failed");
  assert.equal(fileA.durationMs, 30_000);
  assert.equal(fileA.id, "cmd::file:tests/a.py");

  const [caseX, plain] = fileA.children;
  assert.equal(caseX.type, "group");
  if (caseX.type !== "group") return;
  assert.equal(caseX.kind, "test-case");
  assert.equal(caseX.label, "test_x");
  assert.equal(caseX.testCount, 2);
  assert.deepEqual(
    caseX.children.map((child) => child.type === "leaf" && child.displayLabel),
    ["[p1]", "[p2]"],
  );

  // An unparametrized function is a leaf directly under its file.
  assert.equal(plain.type, "leaf");
  assert.equal(plain.type === "leaf" && plain.displayLabel, "test_plain");
});

test("node IDs without :: stay as direct children", () => {
  const tree = buildTestTree("cmd", [leaf("setup", 0, 1)]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].type, "leaf");
});

test("a group of only skipped tests reads as skipped", () => {
  const tree = buildTestTree("cmd", [
    leaf("tests/a.py::test_x[p1]", 0, 1, "skipped"),
    leaf("tests/a.py::test_x[p2]", 1, 2, "skipped"),
  ]);
  assert.equal(tree[0].type === "group" && tree[0].status, "skipped");
});
