import { getTestAreaMapping, type TestAreaMapping } from "./test-areas";

// Strip device prefix from AMD CI pipeline jobs
// e.g. "mi325_1: Basic Correctness" -> "Basic Correctness"
// e.g. "mi355B_4: V1 e2e (4 GPUs)" -> "V1 e2e (4 GPUs)"
function stripDevicePrefix(jobName: string): string | null {
  const match = jobName.match(/^mi\d+[A-Z]?_\d+:\s*(.+)$/);
  return match ? match[1] : null;
}

function resolveGroup(jobName: string, mapping: TestAreaMapping): string | null {
  // Direct match from yaml labels
  const direct = mapping.jobToGroup.get(jobName);
  if (direct) return direct;

  // Pattern match for parallelized jobs (label contains %N → "Kernels MoE Test 1", etc.)
  for (const { regex, group } of mapping.patterns) {
    if (regex.test(jobName)) return group;
  }

  return null;
}

export function getTestGroup(jobName: string, mapping: TestAreaMapping): string | null {
  // Direct match or pattern match
  const group = resolveGroup(jobName, mapping);
  if (group) return group;

  // AMD CI pipeline jobs with device prefix (mi250_1:, mi325_1:, mi355_1:, etc.)
  const stripped = stripDevicePrefix(jobName);
  if (stripped) {
    const strippedGroup = resolveGroup(stripped, mapping);
    if (strippedGroup) return strippedGroup;
    // Try stripping " Test" suffix (AMD CI often appends "Test")
    const withoutTest = stripped.replace(/\s+Test$/, "");
    const withoutTestGroup = resolveGroup(withoutTest, mapping);
    if (withoutTestGroup) return withoutTestGroup;
    return "Hardware-AMD Tests";
  }

  // AMD mirror jobs from CI pipeline. Explicit mirror labels use the Buildkite
  // emoji prefix; historical mirrors use the generated "AMD: " prefix.
  if (jobName.startsWith("AMD: ") || jobName.startsWith(":amd: ")) {
    return "Hardware-AMD Tests";
  }

  // Filter out infrastructure steps (docker builds, bootstrap, etc.)
  if (jobName.startsWith(":docker:") || jobName === "bootstrap") return null;

  return null;
}

// --- Parametrized test grouping and search (Tests page) ---
//
// Buildkite Test Engine reports each pytest parameter set as its own test
// ("test_foo[a]" / "test_foo[b]"), which buries the signal under near-duplicate
// rows. These helpers collapse variants that share file + scope + function
// name (with the trailing "[...]" removed) and power the server-side search.

export interface ParametrizedTestRecord {
  id: string;
  name: string;
  scope?: string | null;
  file_name?: string | null;
  location?: string | null;
  labels?: string[];
  reliability: number | null;
  duration_sum?: number;
  executions_count: number;
  executions_count_by_result?: Record<string, number>;
}

export interface TestGroupRow<T extends ParametrizedTestRecord> {
  key: string;
  scope: string | null;
  name: string;
  file: string | null;
  tests: T[];
  parametrized: boolean;
  reliability: number | null;
  durationAvg: number | null;
  executionsCount: number;
  failedCount: number;
  labels: string[];
}

export function stripParametrizedSuffix(name: string): string {
  return name.replace(/\s*\[[^\]]*\]\s*$/, "");
}

function testFile(test: ParametrizedTestRecord): string | null {
  return test.file_name ?? test.location ?? null;
}

function parametrizedGroupKey(test: ParametrizedTestRecord): string {
  return [
    testFile(test) ?? "",
    test.scope ?? "",
    stripParametrizedSuffix(test.name),
  ].join("\n");
}

export function groupParametrizedTests<T extends ParametrizedTestRecord>(
  tests: T[],
): TestGroupRow<T>[] {
  const byKey = new Map<string, T[]>();
  for (const test of tests) {
    const key = parametrizedGroupKey(test);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(test);
    else byKey.set(key, [test]);
  }

  return [...byKey.entries()].map(([key, variants]) => {
    const first = variants[0];
    const name = stripParametrizedSuffix(first.name);

    let reliability: number | null = null;
    for (const variant of variants) {
      if (variant.reliability == null) continue;
      reliability =
        reliability == null
          ? variant.reliability
          : Math.min(reliability, variant.reliability);
    }

    const executionsCount = variants.reduce(
      (sum, variant) => sum + (variant.executions_count || 0),
      0,
    );
    const failedCount = variants.reduce(
      (sum, variant) =>
        sum + (variant.executions_count_by_result?.failed ?? 0),
      0,
    );
    const hasDurationSum = variants.every(
      (variant) => typeof variant.duration_sum === "number",
    );
    const durationSum = variants.reduce(
      (sum, variant) => sum + (variant.duration_sum ?? 0),
      0,
    );

    return {
      key,
      scope: first.scope ?? null,
      name,
      file: testFile(first),
      tests: variants,
      parametrized: variants.length > 1 && name !== first.name,
      reliability,
      durationAvg:
        hasDurationSum && executionsCount > 0
          ? durationSum / executionsCount
          : null,
      executionsCount,
      failedCount,
      labels: [...new Set(variants.flatMap((variant) => variant.labels ?? []))],
    };
  });
}

export function matchesTestQuery(
  test: ParametrizedTestRecord,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [test.scope, test.name, test.location, test.file_name, ...(test.labels ?? [])]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(needle));
}

export interface JobInfo {
  name: string;
  state: string;
  web_url?: string;
}

export interface GroupStatus {
  group: string;
  state: "passed" | "failed" | "running" | "blocked";
  passed: number;
  failed: number;
  running: number;
  blocked: number;
  total: number;
  jobs: JobInfo[];
}

export function isFailedJobState(state: string): boolean {
  return (
    state === "failed" ||
    state === "failing" ||
    state === "broken" ||
    state === "timed_out"
  );
}

export function resolveGroupsToJobConditions(groups: string[]): { exactNames: string[]; regexPatterns: string[] } {
  const mapping = getTestAreaMapping();
  const exactNames: string[] = [];
  const regexPatterns: string[] = [];
  const groupSet = new Set(groups);

  for (const [name, group] of mapping.jobToGroup) {
    if (groupSet.has(group)) exactNames.push(name);
  }

  for (const { regex, group } of mapping.patterns) {
    if (groupSet.has(group)) {
      regexPatterns.push(regex.source);
    }
  }

  if (groupSet.has("Hardware-AMD Tests")) {
    regexPatterns.push("^mi\\d+[A-Z]?_\\d+:.*$");
    // AMD image preparation is its own Buildkite group.
    regexPatterns.push("^AMD: (?!:docker: ).*$");
    regexPatterns.push("^:amd: .*$");
  }

  return { exactNames, regexPatterns };
}

export function aggregateJobsByGroup(
  jobs: { name: string; state: string; web_url?: string }[],
  mapping: TestAreaMapping = getTestAreaMapping(),
): GroupStatus[] {
  const groupMap = new Map<
    string,
    { passed: number; failed: number; running: number; blocked: number; total: number; jobs: JobInfo[] }
  >();

  for (const job of jobs) {
    const group = getTestGroup(job.name, mapping);
    if (!group) continue;

    if (!groupMap.has(group)) {
      groupMap.set(group, { passed: 0, failed: 0, running: 0, blocked: 0, total: 0, jobs: [] });
    }
    const g = groupMap.get(group)!;
    g.total++;
    g.jobs.push({ name: job.name, state: job.state, web_url: job.web_url });

    const state = job.state;
    if (state === "passed") g.passed++;
    else if (isFailedJobState(state)) g.failed++;
    else if (state === "running" || state === "scheduled" || state === "reserved") g.running++;
    else g.blocked++;
  }

  // Use groups from yaml (sorted alphabetically) for consistent column ordering
  // Also include any groups that appeared in data but aren't in the yaml list
  const orderedGroups = [...mapping.groups];
  for (const group of groupMap.keys()) {
    if (!orderedGroups.includes(group)) {
      orderedGroups.push(group);
    }
  }

  return orderedGroups.filter((group) => groupMap.has(group)).map((group) => {
    const g = groupMap.get(group)!;
    let state: GroupStatus["state"];
    const unblocked = g.passed + g.failed + g.running;
    if (g.failed > 0) state = "failed";
    else if (g.running > 0) state = "running";
    else if (unblocked > 0 && g.passed === unblocked) state = "passed";
    else state = "blocked";

    return { group, state, ...g };
  });
}
