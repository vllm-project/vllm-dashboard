/**
 * Group flat pytest node IDs into a file → test function → parameter tree
 * for the build waterfall, so a shard with thousands of parametrized cases
 * reads as a handful of files and functions until the viewer drills in.
 */

export type TestStatus = "passed" | "failed" | "skipped" | "unknown";

export interface TestNodeIdParts {
  /** Path of the test module, e.g. `tests/models/test_hybrid.py`. */
  file: string;
  /** Function (and class) name, e.g. `TestX::test_models`; null without `::`. */
  testCase: string | null;
  /** Parametrize suffix including brackets, e.g. `[model0-5-True]`. */
  params: string | null;
}

export function parseTestNodeId(nodeid: string): TestNodeIdParts {
  const separator = nodeid.indexOf("::");
  if (separator === -1) return { file: nodeid, testCase: null, params: null };
  const file = nodeid.slice(0, separator);
  const rest = nodeid.slice(separator + 2);
  const bracket = rest.indexOf("[");
  if (bracket === -1 || !rest.endsWith("]")) {
    return { file, testCase: rest, params: null };
  }
  return { file, testCase: rest.slice(0, bracket), params: rest.slice(bracket) };
}

export interface TestLeafLike {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
  status: TestStatus;
}

export interface TestTreeGroup<T extends TestLeafLike> {
  type: "group";
  kind: "test-file" | "test-case";
  id: string;
  /** Short label shown in the row: file path or function name. */
  label: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: TestStatus;
  testCount: number;
  failedCount: number;
  children: TestTreeNode<T>[];
}

export interface TestTreeLeaf<T extends TestLeafLike> {
  type: "leaf";
  /** The part of the node ID not already shown by the enclosing groups. */
  displayLabel: string;
  lane: T;
}

export type TestTreeNode<T extends TestLeafLike> =
  | TestTreeGroup<T>
  | TestTreeLeaf<T>;

function byStart<T extends TestLeafLike>(a: TestTreeNode<T>, b: TestTreeNode<T>) {
  const startA = a.type === "leaf" ? a.lane.startTime : a.startTime;
  const startB = b.type === "leaf" ? b.lane.startTime : b.startTime;
  return Date.parse(startA) - Date.parse(startB);
}

function summarize<T extends TestLeafLike>(
  kind: TestTreeGroup<T>["kind"],
  id: string,
  label: string,
  children: TestTreeNode<T>[],
): TestTreeGroup<T> {
  children.sort(byStart);
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let testCount = 0;
  let failedCount = 0;
  let passedCount = 0;
  let skippedCount = 0;
  for (const child of children) {
    if (child.type === "leaf") {
      start = Math.min(start, Date.parse(child.lane.startTime));
      end = Math.max(end, Date.parse(child.lane.endTime));
      testCount += 1;
      if (child.lane.status === "failed") failedCount += 1;
      else if (child.lane.status === "passed") passedCount += 1;
      else if (child.lane.status === "skipped") skippedCount += 1;
    } else {
      start = Math.min(start, Date.parse(child.startTime));
      end = Math.max(end, Date.parse(child.endTime));
      testCount += child.testCount;
      failedCount += child.failedCount;
      if (child.status === "passed") passedCount += 1;
      else if (child.status === "skipped") skippedCount += 1;
    }
  }
  const status: TestStatus =
    failedCount > 0
      ? "failed"
      : skippedCount > 0 && passedCount === 0 && skippedCount === children.length
        ? "skipped"
        : passedCount > 0
          ? "passed"
          : "unknown";
  return {
    type: "group",
    kind,
    id,
    label,
    startTime: new Date(start).toISOString(),
    endTime: new Date(end).toISOString(),
    durationMs: Math.max(0, end - start),
    status,
    testCount,
    failedCount,
    children,
  };
}

/**
 * Build the tree for one pytest command. Tests whose node ID has no `::`
 * stay as direct children. A function without parameters sits directly
 * under its file; a parametrized function gets its own group whose leaves
 * show only the parameter combination.
 */
export function buildTestTree<T extends TestLeafLike>(
  parentId: string,
  tests: T[],
): TestTreeNode<T>[] {
  const files = new Map<string, Map<string, TestTreeLeaf<T>[]>>();
  const loose: TestTreeNode<T>[] = [];
  const unparametrized = new Map<string, TestTreeLeaf<T>[]>();

  for (const lane of tests) {
    const parts = parseTestNodeId(lane.label);
    if (parts.testCase === null) {
      loose.push({ type: "leaf", displayLabel: lane.label, lane });
      continue;
    }
    const cases = files.get(parts.file) ?? new Map<string, TestTreeLeaf<T>[]>();
    files.set(parts.file, cases);
    if (parts.params === null) {
      const key = `${parts.file}::${parts.testCase}`;
      const direct = unparametrized.get(key) ?? [];
      direct.push({ type: "leaf", displayLabel: parts.testCase, lane });
      unparametrized.set(key, direct);
      if (!cases.has(parts.testCase)) cases.set(parts.testCase, []);
      continue;
    }
    const leaves = cases.get(parts.testCase) ?? [];
    leaves.push({ type: "leaf", displayLabel: parts.params, lane });
    cases.set(parts.testCase, leaves);
  }

  const roots: TestTreeNode<T>[] = [...loose];
  for (const [file, cases] of files) {
    const fileId = `${parentId}::file:${file}`;
    const children: TestTreeNode<T>[] = [];
    for (const [testCase, leaves] of cases) {
      const direct = unparametrized.get(`${file}::${testCase}`) ?? [];
      if (leaves.length === 0) {
        children.push(...direct);
        continue;
      }
      children.push(
        summarize("test-case", `${fileId}::case:${testCase}`, testCase, [
          ...direct,
          ...leaves,
        ]),
      );
    }
    roots.push(summarize("test-file", fileId, file, children));
  }
  roots.sort(byStart);
  return roots;
}
