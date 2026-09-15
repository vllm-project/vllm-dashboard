import { getOrLoadCached } from "@/lib/api-cache";
import type {
  MainCiJobAlert,
  MainCiSuspectedFixPr,
} from "@/lib/alerts-main-ci";

const GITHUB_API = "https://api.github.com";
const VLLM_PULL_PATH = /^\/vllm-project\/vllm\/pull\/(\d+)\/?$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_VERIFICATIONS = 50;

type Fetcher = typeof fetch;
type FixAssessment = "carry" | "regressed" | "inactive" | "unknown";

interface PullResponse {
  state?: unknown;
  merged?: unknown;
  merge_commit_sha?: unknown;
  base?: { ref?: unknown };
}

interface CompareResponse {
  status?: unknown;
}

function githubHeaders(token: string | undefined): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vllm-dashboard",
  };
}

function vllmPullNumber(pr: MainCiSuspectedFixPr): number | null {
  try {
    const url = new URL(pr.url);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    const match = url.pathname.match(VLLM_PULL_PATH);
    if (!match) return null;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    return pr.number === null || pr.number === number ? number : null;
  } catch {
    return null;
  }
}

async function githubJson<T>(
  url: string,
  fetcher: Fetcher,
  token: string | undefined,
): Promise<T | null> {
  try {
    const response = await fetcher(url, {
      headers: githubHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function assessFixPr(
  pr: MainCiSuspectedFixPr,
  failureCommitSha: string,
  fetcher: Fetcher,
  token: string | undefined,
): Promise<FixAssessment> {
  const number = vllmPullNumber(pr);
  if (number === null) return "unknown";

  const pull = await getOrLoadCached(
    `main-ci-fix-pr:${number}`,
    CACHE_TTL_MS,
    () =>
      githubJson<PullResponse>(
        `${GITHUB_API}/repos/vllm-project/vllm/pulls/${number}`,
        fetcher,
        token,
      ),
  );
  if (pull.data === null) return "unknown";
  if (pull.data.base?.ref === undefined) return "unknown";
  if (pull.data.base.ref !== "main") return "inactive";
  if (pull.data.state === "open") return "carry";
  if (pull.data.merged !== true) return "inactive";

  const mergeCommitSha = pull.data.merge_commit_sha;
  if (
    typeof mergeCommitSha !== "string" ||
    !COMMIT_SHA.test(mergeCommitSha) ||
    !COMMIT_SHA.test(failureCommitSha)
  ) {
    return "unknown";
  }
  const normalizedMergeSha = mergeCommitSha.toLowerCase();
  const normalizedFailureSha = failureCommitSha.toLowerCase();
  if (normalizedMergeSha === normalizedFailureSha) return "regressed";

  const comparison = await getOrLoadCached(
    `main-ci-fix-compare:${normalizedMergeSha}:${normalizedFailureSha}`,
    CACHE_TTL_MS,
    () =>
      githubJson<CompareResponse>(
        `${GITHUB_API}/repos/vllm-project/vllm/compare/${normalizedMergeSha}...${normalizedFailureSha}`,
        fetcher,
        token,
      ),
  );
  if (comparison.data === null) return "unknown";
  // BASE...HEAD is ahead/identical exactly when the merged fix is already
  // reachable from the new failing commit. Carrying it would hide a regression.
  if (comparison.data.status === "ahead" || comparison.data.status === "identical") {
    return "regressed";
  }
  if (comparison.data.status === "behind" || comparison.data.status === "diverged") {
    return "carry";
  }
  return "unknown";
}

/**
 * Verify signature-matched fix links against live GitHub state. Exact-revision
 * updates need no carry decision. Every unverifiable stale link fails closed.
 */
export async function verifyMainCiFixOwnership(
  alerts: MainCiJobAlert[],
  fetcher: Fetcher = fetch,
): Promise<MainCiJobAlert[]> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  let verificationCount = 0;

  return Promise.all(
    alerts.map(async (alert) => ({
      ...alert,
      updates: await Promise.all(
        alert.updates.map(async (update) => {
          if (update.fixOwnershipStatus !== "unverified") return update;
          if (verificationCount + update.fixPrs.length > MAX_VERIFICATIONS) {
            return update;
          }
          verificationCount += update.fixPrs.length;
          const assessments = await Promise.all(
            update.fixPrs.map(async (pr) => ({
              pr,
              assessment: await assessFixPr(
                pr,
                alert.lastFailure.commitSha,
                fetcher,
                token,
              ),
            })),
          );
          const carriedFixPrs = assessments
            .filter(({ assessment }) => assessment === "carry")
            .map(({ pr }) => pr);
          const states = new Set(assessments.map(({ assessment }) => assessment));
          return {
            ...update,
            carriedFixPrs,
            fixOwnershipStatus:
              carriedFixPrs.length > 0
                ? "carried"
                : states.has("unknown")
                  ? "unverified"
                  : states.has("regressed")
                    ? "regressed"
                    : "stale",
          };
        }),
      ),
    })),
  );
}
