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

function getTestGroup(jobName: string, mapping: TestAreaMapping): string | null {
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
    return "Hardware - AMD";
  }

  // AMD mirror jobs from CI pipeline (AMD: prefix)
  if (jobName.startsWith("AMD: ")) {
    return "Hardware - AMD";
  }

  // Filter out infrastructure steps (docker builds, bootstrap, etc.)
  if (jobName.startsWith(":docker:") || jobName === "bootstrap") return null;

  return null;
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

  if (groupSet.has("Hardware - AMD")) {
    regexPatterns.push("^mi\\d+[A-Z]?_\\d+:.*$");
    regexPatterns.push("^AMD: .*$");
  }

  return { exactNames, regexPatterns };
}

export function aggregateJobsByGroup(
  jobs: { name: string; state: string; web_url?: string }[]
): GroupStatus[] {
  const mapping = getTestAreaMapping();

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
    else if (state === "failed" || state === "failing" || state === "broken" || state === "timed_out") g.failed++;
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
