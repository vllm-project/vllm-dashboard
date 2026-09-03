const REST_ENDPOINT = "https://api.buildkite.com/v2";

export interface BuildJobRosterEntry {
  name: string;
  state: string;
  web_url?: string;
  started_at: string | null;
}

export interface BuildJobRoster {
  jobs: BuildJobRosterEntry[];
  commit: string | null;
  branch: string | null;
}

export class BuildkiteApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "BuildkiteApiError";
  }
}

function getToken(): string {
  const token = process.env.BUILDKITE_API_TOKEN;
  if (!token) {
    throw new BuildkiteApiError("BUILDKITE_API_TOKEN is not configured.", 503);
  }
  return token;
}

function organization(): string {
  return process.env.BUILDKITE_ORGANIZATION || "vllm";
}

// The OTel notification service only emits spans for jobs that executed, so the
// never-run jobs behind the pipeline's manual gate have no spans. The full
// roster (including blocked jobs) is only available from the REST API.
// https://buildkite.com/docs/apis/rest-api/builds#get-a-build
//
// buildIds are the composite "pipeline_slug:build_number" keys the dashboard
// uses for OTel-sourced builds. Returns rows in the same shape the groups/jobs
// endpoints get from the warehouse (build_id echoes the composite key).
export async function getBuildJobRosterRows(
  buildIds: string[],
): Promise<Record<string, unknown>[]> {
  const builds = buildIds.map((id) => {
    const idx = id.lastIndexOf(":");
    return {
      key: id,
      pipeline: id.slice(0, idx),
      buildNumber: id.slice(idx + 1),
    };
  });
  const rosters = await getBuildJobRosters(organization(), builds);

  const rows: Record<string, unknown>[] = [];
  for (const build of builds) {
    const roster = rosters.get(`${build.pipeline}:${build.buildNumber}`);
    if (!roster) continue;
    for (const job of roster.jobs) {
      rows.push({
        build_id: build.key,
        name: job.name,
        state: job.state,
        web_url: job.web_url,
        started_at: job.started_at,
        commit_sha: roster.commit,
        branch: roster.branch,
      });
    }
  }
  return rows;
}

export async function getBuildJobRoster(
  organization: string,
  pipeline: string,
  buildNumber: string,
): Promise<BuildJobRoster> {
  return fetchBuildJobRoster(organization, pipeline, buildNumber);
}

// Fetch rosters for many builds concurrently, tolerating per-build failures so
// one missing/expired build does not blank the whole page.
export async function getBuildJobRosters(
  organization: string,
  builds: Array<{ pipeline: string; buildNumber: string }>,
): Promise<Map<string, BuildJobRoster>> {
  const results = await Promise.all(
    builds.map(async ({ pipeline, buildNumber }): Promise<[string, BuildJobRoster]> => {
      const key = `${pipeline}:${buildNumber}`;
      try {
        return [key, await fetchBuildJobRoster(organization, pipeline, buildNumber)];
      } catch {
        return [key, { jobs: [], commit: null, branch: null }];
      }
    }),
  );
  return new Map(results);
}

async function fetchBuildJobRoster(
  organization: string,
  pipeline: string,
  buildNumber: string,
): Promise<BuildJobRoster> {
  const response = await fetch(
    `${REST_ENDPOINT}/organizations/${encodeURIComponent(organization)}/pipelines/${encodeURIComponent(pipeline)}/builds/${encodeURIComponent(buildNumber)}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${getToken()}`,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new BuildkiteApiError(
      `Buildkite could not load jobs for build ${buildNumber}.`,
      response.status >= 500 ? 502 : response.status || 502,
    );
  }

  const build = (await response.json()) as {
    commit?: string;
    branch?: string;
    jobs?: Array<{
      name?: string | null;
      state?: string;
      type?: string;
      web_url?: string;
      started_at?: string | null;
    }>;
  };

  const jobs = (build.jobs ?? [])
    .filter((job) => job.type === "script" && job.name)
    .map((job) => ({
      name: job.name as string,
      state: normalizeJobState(job.state),
      web_url: job.web_url,
      started_at: job.started_at ?? null,
    }));

  return { jobs, commit: build.commit ?? null, branch: build.branch ?? null };
}

// Map the REST API job state vocabulary onto the one the dashboard already
// uses (matches the Fivetran build_job.state values).
function normalizeJobState(state: string | undefined): string {
  switch (state) {
    case "passed":
    case "failed":
    case "broken":
    case "timed_out":
    case "canceled":
    case "skipped":
      return state;
    case "running":
    case "assigned":
    case "accepted":
      return "running";
    case "scheduled":
    case "pending":
    case "waiting":
    case "waiting_failed":
    case "unblocked":
    case "unblocked_failed":
      return "scheduled";
    case "blocked":
    case "blocked_failed":
      return "blocked";
    case "canceling":
      return "canceling";
    case "expired":
    case "limited":
      return "not_run";
    default:
      return state ?? "not_run";
  }
}
