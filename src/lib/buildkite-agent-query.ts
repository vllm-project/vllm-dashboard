export function queueKeyFromAgentQueryRules(
  rules: readonly string[] | null | undefined,
): string | null {
  for (const rule of rules ?? []) {
    const match = /^queue=(.+)$/.exec(rule.trim());
    if (!match) continue;
    const value = match[1].trim();
    if (value) return value;
  }
  return null;
}

// GPU reporters and Buildkite agents don't always agree on a host's name:
// the reporter sends the short hostname (e.g. `dgxb200-01`) while Buildkite
// may record an FQDN (`dgxb200-01.example.com`) or different casing. The join
// key is therefore the lowercased first DNS label. IPv4 addresses contain
// dots but have no domain suffix, so they are kept whole.
export function normalizeHostname(
  hostname: string | null | undefined,
): string | null {
  const trimmed = hostname?.trim().toLowerCase();
  if (!trimmed) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(trimmed)) return trimmed;
  return trimmed.split(".", 1)[0];
}

export function queueTagsFromMetaData(
  metaData: readonly string[] | null | undefined,
): string[] {
  const queues: string[] = [];
  for (const entry of metaData ?? []) {
    const match = /^queue=(.+)$/.exec(entry.trim());
    if (!match) continue;
    const value = match[1].trim();
    if (value && !queues.includes(value)) queues.push(value);
  }
  return queues;
}

export interface AgentJobInfo {
  id: string;
  label: string | null;
  buildNumber: number | null;
  url: string | null;
}

export interface BuildkiteAgentInfo {
  agentName: string;
  hostname: string | null;
  queues: string[];
  job: AgentJobInfo | null;
}

// Joins GPU-reported hostnames to the connected Buildkite agents by
// normalized hostname. Every GPU host gets an entry; hosts without a matching
// agent map to null (e.g. hosts that only run the GPU reporter, or agents
// whose Buildkite hostname does not match the reported GPU hostname even
// after normalization). When several agents share a normalized hostname,
// an agent currently running a job wins over an idle one.
export function joinGpuHostsToAgents(
  hostnames: readonly string[],
  agents: readonly BuildkiteAgentInfo[],
): Map<string, BuildkiteAgentInfo | null> {
  const agentsByHostname = new Map<string, BuildkiteAgentInfo>();
  for (const agent of agents) {
    const key = normalizeHostname(agent.hostname);
    if (!key) continue;
    const existing = agentsByHostname.get(key);
    if (!existing || (!existing.job && agent.job)) {
      agentsByHostname.set(key, agent);
    }
  }

  const joined = new Map<string, BuildkiteAgentInfo | null>();
  for (const hostname of hostnames) {
    const key = normalizeHostname(hostname);
    joined.set(hostname, key ? (agentsByHostname.get(key) ?? null) : null);
  }
  return joined;
}
