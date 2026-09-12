/** Curated public status reads. Never return raw Buildkite jobs (env/commands). */
export class AgentApiError extends Error {
  constructor(message: string, public status = 400, public retryAfter?: string) { super(message); }
}

export function integer(params: URLSearchParams, key: string, fallback: number, max: number, min = 0) {
  const value = params.get(key) ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new AgentApiError(`${key} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

export function validateAgentParams(resource: string, params: URLSearchParams) {
  const common = ["pipeline", "organization"];
  const options: Record<string, string[]> = {
    builds: [...common, "branch", "state", "commit", "limit", "page"],
    build: [...common, "buildNumber", "failed", "attempts", "limit", "offset"],
    failures: ["status", "limit", "offset"], queues: ["queue"],
  };
  if (!options[resource]) throw new AgentApiError("Unknown resource. Read /agents.md", 404);
  for (const key of params.keys()) {
    if (!options[resource].includes(key) || params.getAll(key).length !== 1 || (params.get(key)?.length ?? 0) > 500) {
      throw new AgentApiError(`Unknown, repeated, or oversized parameter: ${key}`);
    }
  }
  if (params.has("failed") && params.get("failed") !== "1") throw new AgentApiError("failed must be 1");
  if (params.has("attempts") && params.get("attempts") !== "all") throw new AgentApiError("attempts must be all (omit for latest)");
}

export function pipelineIdentity(params: URLSearchParams) {
  const organization = process.env.BUILDKITE_ORGANIZATION || "vllm";
  const pipeline = params.get("pipeline") || "ci";
  const allowed = (process.env.AGENT_BUILDKITE_PIPELINES || "ci").split(",").map(s => s.trim());
  if ((params.has("organization") && params.get("organization") !== organization)
      || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(pipeline) || !allowed.includes(pipeline)) {
    throw new AgentApiError("Organization or pipeline is not enabled for the public agent API", 403);
  }
  return { organization, pipeline };
}

type Build = {
  id: string; number: number; state: string; branch: string; commit: string;
  web_url: string; created_at: string; started_at: string | null; finished_at: string | null;
  message?: string; jobs?: Job[];
};
type Job = {
  id: string; type: string; name?: string; state: string; web_url?: string;
  step_key?: string; exit_status?: number | null; soft_failed?: boolean;
  started_at?: string | null; finished_at?: string | null; runnable_at?: string | null;
  retries_count?: number | null; retried?: boolean; retried_in_job_id?: string | null;
  agent_query_rules?: string[]; parallel_group_index?: number | null;
};
export const FAILED_STATES = new Set(["failed", "broken", "timed_out", "expired"]);

export function compactBuild(build: Build) {
  return {
    id: build.id, number: build.number, state: build.state, branch: build.branch,
    commit: build.commit, url: build.web_url, createdAt: build.created_at,
    startedAt: build.started_at, finishedAt: build.finished_at,
    message: build.message?.slice(0, 500) ?? null,
  };
}

export function compactJobs(jobs: Job[]) {
  return jobs.map(job => ({
    id: job.id, type: job.type, name: job.name ?? null, state: job.state,
    stepKey: job.step_key ?? null, url: job.web_url ?? null,
    queue: job.agent_query_rules?.find(rule => rule.startsWith("queue="))?.slice(6) ?? null,
    startedAt: job.started_at ?? null, finishedAt: job.finished_at ?? null,
    runnableAt: job.runnable_at ?? null, exitStatus: job.exit_status ?? null,
    softFailed: job.soft_failed ?? false, retriesCount: job.retries_count ?? 0,
    retried: job.retried ?? false, retriedInJobId: job.retried_in_job_id ?? null,
    parallelGroupIndex: job.parallel_group_index ?? null,
  }));
}

async function readBuildkite(path: string, query: URLSearchParams) {
  const token = process.env.BUILDKITE_API_TOKEN;
  if (!token) throw new AgentApiError("Buildkite status is not configured", 503);
  const response = await fetch(`https://api.buildkite.com/v2/${path}?${query}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new AgentApiError("Buildkite status is unavailable; an HTTP 404 can also mean access is unavailable",
      response.status >= 500 ? 502 : response.status, response.headers.get("Retry-After") ?? undefined);
  }
  return { body: await response.json(), link: response.headers.get("Link") };
}

export async function agentBuilds(params: URLSearchParams, single: boolean) {
  const { organization, pipeline } = pipelineIdentity(params);
  const root = `organizations/${encodeURIComponent(organization)}/pipelines/${encodeURIComponent(pipeline)}/builds`;
  const query = new URLSearchParams({ exclude_pipeline: "true" });
  if (!single) {
    const page = integer(params, "page", 1, 10000, 1);
    const limit = integer(params, "limit", 20, 100, 1);
    query.set("exclude_jobs", "true"); query.set("page", String(page)); query.set("per_page", String(limit));
    for (const key of ["branch", "state", "commit"]) {
      const value = params.get(key);
      if (value) query.set(key, value);
    }
    const { body, link } = await readBuildkite(root, query);
    if (!Array.isArray(body)) throw new AgentApiError("Invalid Buildkite build list", 502);
    const next = link?.match(/<([^>]+)>;\s*rel="next"/);
    const nextPage = next ? Number(new URL(next[1]).searchParams.get("page")) : null;
    return { organization, pipeline, builds: body.map(compactBuild), page, nextPage, limit };
  }
  const number = integer(params, "buildNumber", 0, 999999999999, 1);
  const offset = integer(params, "offset", 0, 100000);
  const limit = integer(params, "limit", 100, 500, 1);
  query.set("include_retried_jobs", params.get("attempts") === "all" ? "true" : "false");
  const { body } = await readBuildkite(`${root}/${number}`, query);
  if (!body || !Array.isArray(body.jobs)) throw new AgentApiError("Invalid Buildkite job roster", 502);
  const jobs = compactJobs(body.jobs);
  const counts: Record<string, number> = {};
  for (const job of jobs) counts[job.state] = (counts[job.state] ?? 0) + 1;
  const matching = params.get("failed") === "1" ? jobs.filter(job => FAILED_STATES.has(job.state)) : jobs;
  return { organization, pipeline, build: compactBuild(body), counts, totalJobs: jobs.length,
    attempts: params.get("attempts") === "all" ? "all" : "latest", matchingJobs: matching.length,
    jobs: matching.slice(offset, offset + limit), offset,
    nextOffset: offset + limit < matching.length ? offset + limit : null };
}
