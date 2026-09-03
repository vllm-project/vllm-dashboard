import assert from "node:assert/strict";
import test from "node:test";

import {
  joinGpuHostsToAgents,
  normalizeHostname,
  queueKeyFromAgentQueryRules,
  queueTagsFromMetaData,
  type BuildkiteAgentInfo,
} from "./buildkite-agent-query";

test("queueKeyFromAgentQueryRules extracts the Kubernetes queue tag", () => {
  assert.equal(
    queueKeyFromAgentQueryRules(["docker=true", "queue=l4-k8s"]),
    "l4-k8s",
  );
});

test("queueKeyFromAgentQueryRules ignores missing and unrelated rules", () => {
  assert.equal(queueKeyFromAgentQueryRules(undefined), null);
  assert.equal(queueKeyFromAgentQueryRules(["docker=true", "queue="]), null);
  assert.equal(queueKeyFromAgentQueryRules(["notqueue=l4-k8s"]), null);
});

test("normalizeHostname lowercases and strips the domain suffix", () => {
  assert.equal(normalizeHostname("DGXB200-01"), "dgxb200-01");
  assert.equal(normalizeHostname("dgxb200-01.example.com"), "dgxb200-01");
  assert.equal(normalizeHostname("  dgxb200-01.  "), "dgxb200-01");
});

test("normalizeHostname keeps IPv4 addresses whole and rejects blanks", () => {
  assert.equal(normalizeHostname("10.0.0.5"), "10.0.0.5");
  assert.equal(normalizeHostname(""), null);
  assert.equal(normalizeHostname("   "), null);
  assert.equal(normalizeHostname(null), null);
  assert.equal(normalizeHostname(undefined), null);
});

test("queueTagsFromMetaData collects every queue tag without duplicates", () => {
  assert.deepEqual(
    queueTagsFromMetaData(["docker=true", "queue=a100", "queue=a100", "queue= b200 "]),
    ["a100", "b200"],
  );
  assert.deepEqual(queueTagsFromMetaData(null), []);
  assert.deepEqual(queueTagsFromMetaData(["queue=", "notqueue=x"]), []);
});

function agent(
  overrides: Partial<BuildkiteAgentInfo> & { agentName: string },
): BuildkiteAgentInfo {
  return { hostname: null, queues: [], job: null, ...overrides };
}

test("joinGpuHostsToAgents matches hosts regardless of case and domain", () => {
  const agents = [
    agent({
      agentName: "b200-agent-1",
      hostname: "DGXB200-01.example.com",
      queues: ["b200"],
      job: {
        id: "job-1",
        label: "tests",
        buildNumber: 12,
        url: "https://buildkite.com/vllm/builds/12#job-1",
      },
    }),
  ];

  const joined = joinGpuHostsToAgents(["dgxb200-01", "h100-01"], agents);

  assert.equal(joined.get("dgxb200-01")?.agentName, "b200-agent-1");
  assert.equal(joined.get("dgxb200-01")?.queues[0], "b200");
  assert.equal(joined.get("dgxb200-01")?.job?.label, "tests");
  assert.equal(joined.get("h100-01"), null);
});

test("joinGpuHostsToAgents prefers an agent running a job on a shared hostname", () => {
  const idle = agent({ agentName: "idle", hostname: "dgxb200-01" });
  const busy = agent({
    agentName: "busy",
    hostname: "dgxb200-01",
    job: { id: "job-2", label: null, buildNumber: null, url: null },
  });

  assert.equal(
    joinGpuHostsToAgents(["dgxb200-01"], [idle, busy]).get("dgxb200-01")?.agentName,
    "busy",
  );
  assert.equal(
    joinGpuHostsToAgents(["dgxb200-01"], [busy, idle]).get("dgxb200-01")?.agentName,
    "busy",
  );
});

test("joinGpuHostsToAgents maps every host, with null for unmatched", () => {
  const joined = joinGpuHostsToAgents(["gpu-1", "gpu-2"], []);
  assert.deepEqual([...joined.keys()], ["gpu-1", "gpu-2"]);
  assert.equal(joined.get("gpu-1"), null);
  assert.equal(joined.get("gpu-2"), null);
});
