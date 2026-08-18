const GRAPHQL_ENDPOINT = "https://graphql.buildkite.com/v1";
const REST_ENDPOINT = "https://api.buildkite.com/v2";
const JOBS_PAGE_SIZE = 100;

export interface QueueJob {
  uuid: string;
  label: string | null;
  url: string;
  scheduledAt: string;
  priority: number;
}

interface GraphQLResponse {
  data?: {
    organization?: {
      jobs: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        edges: Array<{
          node: {
            uuid?: string;
            label?: string | null;
            url?: string;
            scheduledAt?: string;
            priority?: { number?: number };
            clusterQueue?: { id?: string } | null;
          };
        }>;
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface ClusterQueueConnection {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  edges: Array<{
    node: {
      id: string;
      key: string;
    };
  }>;
}

interface ClusterQueueTarget {
  clusterId: string;
  queueId: string;
}

interface ClusterQueuesGraphQLResponse {
  data?: {
    organization?: {
      clusters: {
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
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface ClusterQueuePageGraphQLResponse {
  data?: {
    node?: {
      queues: ClusterQueueConnection;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface ClusterQueueMetricGraphQLResponse {
  data?: {
    node?: {
      metrics?: {
        waitingJobsCount?: number;
      } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

export interface QueueJobsResult {
  jobs: QueueJob[];
  waitingCount: number | null;
}

export class BuildkiteQueueError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

function getToken(): string {
  const token = process.env.BUILDKITE_API_TOKEN;
  if (!token) {
    throw new BuildkiteQueueError(
      "Queue jobs need a Buildkite API token with GraphQL API access.",
      503,
      "BUILDKITE_NOT_CONFIGURED",
    );
  }
  return token;
}

function organization(): string {
  return process.env.BUILDKITE_ORGANIZATION || "vllm";
}

function queueRule(queue: string): string {
  if (!queue || queue.length > 255) {
    throw new BuildkiteQueueError("A valid queue is required.", 400, "INVALID_QUEUE");
  }
  return `queue=${queue}`;
}

function requestError(response: Response, errors?: Array<{ message: string }>): BuildkiteQueueError {
  const detail = errors?.map((error) => error.message).join(" ");
  const message =
    response.status === 401
      ? "The configured Buildkite API token is no longer valid."
      : response.status === 403 || response.status === 404
        ? "The Buildkite token needs GraphQL API access and read access to this organization."
        : detail || "Buildkite could not load the queue jobs.";
  return new BuildkiteQueueError(
    message,
    response.status >= 500 ? 502 : response.status || 502,
    "BUILDKITE_REQUEST_FAILED",
  );
}

async function getClusterQueuePage(
  token: string,
  clusterId: string,
  after: string,
): Promise<ClusterQueueConnection> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `
        query ClusterQueuePage($cluster: ID!, $first: Int!, $after: String) {
          node(id: $cluster) {
            ... on Cluster {
              queues(first: $first, after: $after) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                edges {
                  node {
                    id
                    key
                  }
                }
              }
            }
          }
        }
      `,
      variables: {
        cluster: clusterId,
        first: JOBS_PAGE_SIZE,
        after,
      },
    }),
    cache: "no-store",
  });

  let result: ClusterQueuePageGraphQLResponse;
  try {
    result = (await response.json()) as ClusterQueuePageGraphQLResponse;
  } catch {
    throw new BuildkiteQueueError(
      "Buildkite returned an invalid cluster-queue response.",
      502,
      "BUILDKITE_INVALID_RESPONSE",
    );
  }

  if (!response.ok || result.errors?.length) throw requestError(response, result.errors);

  const queues = result.data?.node?.queues;
  if (!queues) {
    throw new BuildkiteQueueError(
      "Buildkite did not return queues for a cluster.",
      502,
      "BUILDKITE_INVALID_RESPONSE",
    );
  }

  return queues;
}

async function getClusterQueue(queue: string): Promise<ClusterQueueTarget | null> {
  const token = getToken();
  let after: string | null = null;

  do {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          query ClusterQueues($organization: ID!, $first: Int!, $after: String) {
            organization(slug: $organization) {
              clusters(first: $first, after: $after) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                edges {
                  node {
                    id
                    queues(first: $first) {
                      pageInfo {
                        hasNextPage
                        endCursor
                      }
                      edges {
                        node {
                          id
                          key
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: {
          organization: organization(),
          first: JOBS_PAGE_SIZE,
          after,
        },
      }),
      cache: "no-store",
    });

    let result: ClusterQueuesGraphQLResponse;
    try {
      result = (await response.json()) as ClusterQueuesGraphQLResponse;
    } catch {
      throw new BuildkiteQueueError(
        "Buildkite returned an invalid cluster-queues response.",
        502,
        "BUILDKITE_INVALID_RESPONSE",
      );
    }

    if (!response.ok || result.errors?.length) throw requestError(response, result.errors);

    const clusters = result.data?.organization?.clusters;
    if (!clusters) {
      throw new BuildkiteQueueError(
        "Buildkite did not return clusters for the configured organization.",
        502,
        "BUILDKITE_INVALID_RESPONSE",
      );
    }

    for (const { node: cluster } of clusters.edges) {
      const clusterQueue = cluster.queues.edges.find(({ node }) => node.key === queue)?.node;
      if (clusterQueue) return { clusterId: cluster.id, queueId: clusterQueue.id };

      let queueAfter = cluster.queues.pageInfo.hasNextPage
        ? cluster.queues.pageInfo.endCursor
        : null;
      while (queueAfter) {
        const queues = await getClusterQueuePage(token, cluster.id, queueAfter);
        const paginatedQueue = queues.edges.find(({ node }) => node.key === queue)?.node;
        if (paginatedQueue) return { clusterId: cluster.id, queueId: paginatedQueue.id };
        queueAfter = queues.pageInfo.hasNextPage ? queues.pageInfo.endCursor : null;
      }
    }

    after = clusters.pageInfo.hasNextPage ? clusters.pageInfo.endCursor : null;
  } while (after);

  return null;
}

async function getClusterQueueWaitingCount(queue: string): Promise<number | null> {
  const token = getToken();
  const clusterQueue = await getClusterQueue(queue);
  if (!clusterQueue) return null;

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `
        query ClusterQueueMetric($queue: ID!) {
          node(id: $queue) {
            ... on ClusterQueue {
              metrics {
                waitingJobsCount
              }
            }
          }
        }
      `,
      variables: { queue: clusterQueue.queueId },
    }),
    cache: "no-store",
  });

  let result: ClusterQueueMetricGraphQLResponse;
  try {
    result = (await response.json()) as ClusterQueueMetricGraphQLResponse;
  } catch {
    throw new BuildkiteQueueError(
      "Buildkite returned an invalid cluster-queue metric response.",
      502,
      "BUILDKITE_INVALID_RESPONSE",
    );
  }

  if (!response.ok || result.errors?.length) throw requestError(response, result.errors);
  return result.data?.node?.metrics?.waitingJobsCount ?? null;
}

async function graphqlQueueJobs(queue: string): Promise<QueueJob[]> {
  const token = getToken();
  const agentQueryRule = queueRule(queue);
  const clusterQueue = await getClusterQueue(queue);
  const jobs: QueueJob[] = [];
  let after: string | null = null;

  do {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          query QueueJobs($organization: ID!, $agentQueryRules: [String!], $cluster: ID, $first: Int!, $after: String) {
            organization(slug: $organization) {
              jobs(
                first: $first
                after: $after
                type: [COMMAND]
                state: [SCHEDULED]
                agentQueryRules: $agentQueryRules
                cluster: $cluster
              ) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                edges {
                  node {
                    ... on JobTypeCommand {
                      uuid
                      label
                      url
                      scheduledAt
                      priority { number }
                      clusterQueue { id }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: {
          organization: organization(),
          agentQueryRules: clusterQueue ? null : [agentQueryRule],
          cluster: clusterQueue?.clusterId ?? null,
          first: JOBS_PAGE_SIZE,
          after,
        },
      }),
      cache: "no-store",
    });

    let result: GraphQLResponse;
    try {
      result = (await response.json()) as GraphQLResponse;
    } catch {
      throw new BuildkiteQueueError(
        "Buildkite returned an invalid queue-jobs response.",
        502,
        "BUILDKITE_INVALID_RESPONSE",
      );
    }

    if (!response.ok || result.errors?.length) throw requestError(response, result.errors);

    const connection = result.data?.organization?.jobs;
    if (!connection) {
      throw new BuildkiteQueueError(
        "Buildkite did not return jobs for the configured organization.",
        502,
        "BUILDKITE_INVALID_RESPONSE",
      );
    }

    for (const { node } of connection.edges) {
      if (!node.uuid || !node.url || !node.scheduledAt) continue;
      if (clusterQueue && node.clusterQueue?.id !== clusterQueue.queueId) continue;
      jobs.push({
        uuid: node.uuid,
        label: node.label ?? null,
        url: node.url,
        scheduledAt: node.scheduledAt,
        priority: node.priority?.number ?? 0,
      });
    }

    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  return jobs.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const scheduledDifference = new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
    if (scheduledDifference !== 0) return scheduledDifference;
    return a.uuid.localeCompare(b.uuid);
  });
}

export async function getQueueJobs(queue: string): Promise<QueueJobsResult> {
  const [jobs, waitingCount] = await Promise.all([
    graphqlQueueJobs(queue),
    getClusterQueueWaitingCount(queue),
  ]);
  return { jobs, waitingCount };
}

export async function reprioritizeQueueJob(queue: string, jobUuid: string): Promise<{ priority: number }> {
  if (!/^[0-9a-f-]{36}$/i.test(jobUuid)) {
    throw new BuildkiteQueueError("A valid job UUID is required.", 400, "INVALID_JOB");
  }

  const jobs = await graphqlQueueJobs(queue);
  const job = jobs.find((candidate) => candidate.uuid === jobUuid);
  if (!job) {
    throw new BuildkiteQueueError(
      "This job is no longer scheduled in the selected queue. Refresh the list and try again.",
      409,
      "JOB_NOT_SCHEDULED",
    );
  }

  const highestPriority = Math.max(...jobs.map((candidate) => candidate.priority));
  if (highestPriority >= 2_147_483_647) {
    throw new BuildkiteQueueError(
      "The queue's current priority is too high to promote another job.",
      409,
      "PRIORITY_LIMIT_REACHED",
    );
  }
  const priority = highestPriority + 1;

  const response = await fetch(
    `${REST_ENDPOINT}/organizations/${encodeURIComponent(organization())}/jobs/${encodeURIComponent(jobUuid)}/reprioritize`,
    {
      method: "PUT",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${getToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ priority }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    const message =
      response.status === 401
        ? "The configured Buildkite API token is no longer valid."
        : response.status === 403 || response.status === 404
          ? "The Buildkite token needs write_builds access to reprioritize jobs."
          : "Buildkite could not reprioritize this job.";
    console.error(`Buildkite job reprioritize failed: ${response.status} ${detail}`);
    throw new BuildkiteQueueError(
      message,
      response.status >= 500 ? 502 : response.status,
      "BUILDKITE_REPRIORITIZE_FAILED",
    );
  }

  return { priority };
}
