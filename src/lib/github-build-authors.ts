import { getCached, setCache } from "@/lib/api-cache";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const REPOSITORY_OWNER = "vllm-project";
const REPOSITORY_NAME = "vllm";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type BuildRow = Record<string, unknown>;
type GitHubBuildRef = { author: string | null; prNumber: string | null };

function pullRequestNumber(build: BuildRow): string | null {
  if (typeof build.message !== "string") return null;
  const match = build.message.match(/\(#(\d+)\)|\bPR\s+#(\d+)\b/i);
  return match?.[1] ?? match?.[2] ?? null;
}

function commitSha(build: BuildRow): string | null {
  return typeof build.commit_sha === "string" && SHA_PATTERN.test(build.commit_sha)
    ? build.commit_sha.toLowerCase()
    : null;
}

async function fetchAuthors(keys: string[]): Promise<Map<string, GitHubBuildRef>> {
  const resolved = new Map<string, GitHubBuildRef>();
  const missing = keys.filter((key) => {
    const cached = getCached<GitHubBuildRef>(`github-build-ref:${key}`);
    if (cached === undefined) return true;
    resolved.set(key, cached);
    return false;
  });
  if (missing.length === 0) return resolved;

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return resolved;

  const fields = missing.map((key, index) => {
    const [kind, value] = key.split(":", 2);
    if (kind === "pr") {
      return `item${index}: pullRequest(number: ${value}) { author { login } }`;
    }
    return `item${index}: object(oid: "${value}") { ... on Commit { author { user { login } } associatedPullRequests(first: 1) { nodes { number author { login } } } } }`;
  });
  const query = `
    query BuildAuthors($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${fields.join("\n")}
      }
    }
  `;

  try {
    const response = await fetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "vllm-dashboard",
      },
      body: JSON.stringify({
        query,
        variables: { owner: REPOSITORY_OWNER, name: REPOSITORY_NAME },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return resolved;

    const body = (await response.json()) as {
      data?: { repository?: Record<string, unknown> | null };
      errors?: unknown[];
    };
    if (body.errors?.length || !body.data?.repository) return resolved;

    for (const [index, key] of missing.entries()) {
      const item = body.data.repository[`item${index}`] as
        | {
            author?: {
              login?: string | null;
              user?: { login?: string | null } | null;
            } | null;
            associatedPullRequests?: {
              nodes?: { number?: number; author?: { login?: string | null } | null }[];
            } | null;
          }
        | null
        | undefined;
      const pullRequest = item?.associatedPullRequests?.nodes?.[0];
      const author = {
        author:
          item?.author?.login?.trim() ||
          pullRequest?.author?.login?.trim() ||
          item?.author?.user?.login?.trim() ||
          null,
        prNumber: key.startsWith("pr:")
          ? key.slice(3)
          : pullRequest?.number?.toString() ?? null,
      };
      setCache(`github-build-ref:${key}`, author, CACHE_TTL_MS);
      resolved.set(key, author);
    }
  } catch {
    return resolved;
  }

  return resolved;
}

export async function enrichBuildAuthors(builds: BuildRow[]): Promise<BuildRow[]> {
  const normalized = builds.map((build) => {
    const prNumber = pullRequestNumber(build);
    const sha = commitSha(build);
    const authorKey = prNumber ? `pr:${prNumber}` : sha ? `commit:${sha}` : null;
    return { build, prNumber, authorKey };
  });
  const keys = [...new Set(normalized.flatMap(({ authorKey }) => authorKey ? [authorKey] : []))];
  const authors = await fetchAuthors(keys);

  return normalized.map(({ build, prNumber, authorKey }) => {
    const github = authorKey ? authors.get(authorKey) : null;
    return {
      ...build,
      pr_number: github?.prNumber ?? prNumber,
      author: github?.author ?? build.author ?? null,
    };
  });
}
