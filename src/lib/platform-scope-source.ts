import { getOrLoadCached } from "./api-cache";
import {
  GitHubError,
  loadTestAreaFilesAt,
  PARITY_DIR,
  PARITY_REF,
  PARITY_REPO,
  resolveTestAreasCommit,
  type ParitySource,
} from "./gpu-parity-source";
import { computePlatformScope, type PlatformScopeSnapshot } from "./platform-scope";

/**
 * Platform scope of `.buildkite/test_areas` at the latest commit on main that
 * touched it. Shares the parity loader's GitHub reads and blob cache.
 */

const SNAPSHOT_TTL = 60 * 60 * 1000;

export type PlatformScopeSource = ParitySource;

export interface PlatformScopeResponse extends PlatformScopeSnapshot {
  source: PlatformScopeSource;
}

async function fetchSnapshot(): Promise<PlatformScopeResponse> {
  const head = await resolveTestAreasCommit();
  if (!head) {
    throw new GitHubError(`No commits touch ${PARITY_DIR} on ${PARITY_REF}`, 404, false);
  }
  const files = await loadTestAreaFilesAt(head.sha);
  if (files.length === 0) {
    throw new GitHubError(`No test area YAML found at ${head.sha}`, 404, false);
  }
  return {
    ...computePlatformScope(files),
    source: {
      repo: PARITY_REPO,
      ref: PARITY_REF,
      directory: PARITY_DIR,
      commit: head.sha,
      commitDate: head.date,
      commitUrl: `https://github.com/${PARITY_REPO}/commit/${head.sha}`,
      fetchedAt: new Date().toISOString(),
    },
  };
}

export async function loadPlatformScopeSnapshot(): Promise<PlatformScopeResponse> {
  const { data } = await getOrLoadCached(
    "platform-scope:snapshot",
    SNAPSHOT_TTL,
    fetchSnapshot,
  );
  return data;
}
