import { queueKeyFromAgentQueryRules } from "@/lib/buildkite-agent-query";

const GRAPHQL_ENDPOINT = "https://graphql.buildkite.com/v1";
const PAGE_SIZE = 100;

export interface QueueWaitPercentiles {
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  sampleSize: number;
}

export interface BuildkiteQueueSnapshot extends QueueWaitPercentiles {
  queue: string;
  polledAt: string;
  connectedAgents: number;
  runningJobs: number;
  waitingJobs: number;
}

interface ClusterQueueNode {
  id: string;
  key: string;
  metrics: {
    connectedAgentsCount: number;
    runningJobsCount: number;
    waitingJobsCount: number;
  } | null;
}

interface ClusterQueueConnection {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  edges: Array<{ node: ClusterQueueNode }>;
}

interface ClusterConnection {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  edges: Array<{
    node: {
      id: string;
      queues: ClusterQueueConnection;
    };
  }>;
}

interface ClustersResponse {
  organization: { clusters: ClusterConnection } | null;
}

interface ClusterQueuePageResponse {
  node: {
    queues: ClusterQueueConnection;
  } | null;
}

interface ScheduledJobsConnection {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  edges: Array<{
    node: {
      runnableAt: string | null;
      clusterQueue: { id: string } | null;
      agentQueryRules: string[] | null;
    };
  }>;
}

interface ScheduledJobsResponse {
  organization: { jobs: ScheduledJobsConnection } | null;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface ScheduledQueueJob {
  runnableAt: string | null;
  clusterQueueId: string | null;
  queueKey?: string | null;
}

async function graphqlRequest<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  let result: GraphQLResponse<T>;
  try {
    result = (await response.json()) as GraphQLResponse<T>;
  } catch {
    throw new Error("Buildkite returned an invalid queue-metrics response.");
  }

  if (!response.ok || result.errors?.length || !result.data) {
    const detail = result.errors?.map((error) => error.message).join(" ");
    throw new Error(detail || `Buildkite queue-metrics request failed (${response.status}).`);
  }

  return result.data;
}

export function calculateWaitPercentiles(
  runnableAtValues: Array<string | null>,
  now: Date,
): QueueWaitPercentiles {
  const ages = runnableAtValues
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.max(0, (now.getTime() - value) / 1000))
    .sort((a, b) => a - b);

  function nearestRank(percentile: number): number | null {
    if (ages.length === 0) return null;
    const index = Math.max(0, Math.ceil(percentile * ages.length) - 1);
    return ages[Math.min(index, ages.length - 1)];
  }

  return {
    p50: nearestRank(0.5),
    p90: nearestRank(0.9),
    p95: nearestRank(0.95),
    p99: nearestRank(0.99),
    sampleSize: ages.length,
  };
}

export function aggregateQueueSnapshots(
  queues: ClusterQueueNode[],
  jobs: ScheduledQueueJob[],
  now: Date,
): BuildkiteQueueSnapshot[] {
  const jobsByQueue = new Map<string, Array<string | null>>();
  const jobsByQueueKey = new Map<string, Array<string | null>>();
  for (const job of jobs) {
    if (job.clusterQueueId) {
      const queueJobs = jobsByQueue.get(job.clusterQueueId) ?? [];
      queueJobs.push(job.runnableAt);
      jobsByQueue.set(job.clusterQueueId, queueJobs);
    } else if (job.queueKey) {
      const queueJobs = jobsByQueueKey.get(job.queueKey) ?? [];
      queueJobs.push(job.runnableAt);
      jobsByQueueKey.set(job.queueKey, queueJobs);
    }
  }

  const queuesByKey = new Map<string, {
    ids: string[];
    connectedAgents: number;
    runningJobs: number;
    waitingJobs: number;
  }>();
  for (const queue of queues) {
    if (!queue.metrics) continue;
    const aggregate = queuesByKey.get(queue.key) ?? {
      ids: [],
      connectedAgents: 0,
      runningJobs: 0,
      waitingJobs: 0,
    };
    aggregate.ids.push(queue.id);
    aggregate.connectedAgents += queue.metrics.connectedAgentsCount;
    aggregate.runningJobs += queue.metrics.runningJobsCount;
    aggregate.waitingJobs += queue.metrics.waitingJobsCount;
    queuesByKey.set(queue.key, aggregate);
  }

  return [...queuesByKey.entries()]
    .map(([queue, aggregate]) => {
      const runnableAtValues = [
        ...aggregate.ids.flatMap((id) => jobsByQueue.get(id) ?? []),
        ...(jobsByQueueKey.get(queue) ?? []),
      ];
      const wait = calculateWaitPercentiles(runnableAtValues, now);
      return {
        queue,
        polledAt: now.toISOString(),
        connectedAgents: aggregate.connectedAgents,
        runningJobs: aggregate.runningJobs,
        waitingJobs: aggregate.waitingJobs,
        ...wait,
      };
    })
    .sort((a, b) => a.queue.localeCompare(b.queue));
}

async function fetchClusterQueuePage(
  token: string,
  clusterId: string,
  after: string,
): Promise<ClusterQueueConnection> {
  const data = await graphqlRequest<ClusterQueuePageResponse>(
    token,
    `
      query ClusterQueueMetricsPage($cluster: ID!, $first: Int!, $after: String) {
        node(id: $cluster) {
          ... on Cluster {
            queues(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  id
                  key
                  metrics {
                    connectedAgentsCount
                    runningJobsCount
                    waitingJobsCount
                  }
                }
              }
            }
          }
        }
      }
    `,
    { cluster: clusterId, first: PAGE_SIZE, after },
  );

  if (!data.node?.queues) {
    throw new Error("Buildkite did not return queues for a cluster.");
  }
  return data.node.queues;
}

async function fetchClusterQueues(token: string, organization: string): Promise<ClusterQueueNode[]> {
  const queues: ClusterQueueNode[] = [];
  let after: string | null = null;

  do {
    const data: ClustersResponse = await graphqlRequest<ClustersResponse>(
      token,
      `
        query ClusterQueueMetrics($organization: ID!, $first: Int!, $after: String) {
          organization(slug: $organization) {
            clusters(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  id
                  queues(first: $first) {
                    pageInfo { hasNextPage endCursor }
                    edges {
                      node {
                        id
                        key
                        metrics {
                          connectedAgentsCount
                          runningJobsCount
                          waitingJobsCount
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { organization, first: PAGE_SIZE, after },
    );

    const clusters: ClusterConnection | undefined = data.organization?.clusters;
    if (!clusters) throw new Error("Buildkite did not return clusters for the organization.");

    for (const { node: cluster } of clusters.edges) {
      queues.push(...cluster.queues.edges.map(({ node }) => node));
      let queueAfter = cluster.queues.pageInfo.hasNextPage
        ? cluster.queues.pageInfo.endCursor
        : null;
      while (queueAfter) {
        const page = await fetchClusterQueuePage(token, cluster.id, queueAfter);
        queues.push(...page.edges.map(({ node }) => node));
        queueAfter = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      }
    }

    after = clusters.pageInfo.hasNextPage ? clusters.pageInfo.endCursor : null;
  } while (after);

  return queues;
}

async function fetchScheduledJobs(token: string, organization: string): Promise<ScheduledQueueJob[]> {
  const jobs: ScheduledQueueJob[] = [];
  let after: string | null = null;

  do {
    const data: ScheduledJobsResponse = await graphqlRequest<ScheduledJobsResponse>(
      token,
      `
        query ScheduledQueueJobs($organization: ID!, $first: Int!, $after: String) {
          organization(slug: $organization) {
            jobs(first: $first, after: $after, type: [COMMAND], state: [SCHEDULED]) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  ... on JobTypeCommand {
                    runnableAt
                    clusterQueue { id }
                    agentQueryRules
                  }
                }
              }
            }
          }
        }
      `,
      { organization, first: PAGE_SIZE, after },
    );

    const connection: ScheduledJobsConnection | undefined = data.organization?.jobs;
    if (!connection) throw new Error("Buildkite did not return scheduled jobs for the organization.");

    jobs.push(
      ...connection.edges.map(({ node }) => ({
        runnableAt: node.runnableAt,
        clusterQueueId: node.clusterQueue?.id ?? null,
        queueKey: queueKeyFromAgentQueryRules(node.agentQueryRules),
      })),
    );
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  return jobs;
}

export async function fetchBuildkiteQueueSnapshots(
  token: string,
  organization: string,
  now = new Date(),
): Promise<BuildkiteQueueSnapshot[]> {
  const [queues, jobs] = await Promise.all([
    fetchClusterQueues(token, organization),
    fetchScheduledJobs(token, organization),
  ]);
  return aggregateQueueSnapshots(queues, jobs, now);
}
