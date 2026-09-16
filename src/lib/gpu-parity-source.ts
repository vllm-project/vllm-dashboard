import yaml from "js-yaml";

import { getOrLoadCached } from "./api-cache";
import { GITHUB_API_BASE, githubHeaders, githubRawUrl } from "./github";
import {
  computeParity,
  parseTestAreaFile,
  summarizeForHistory,
  type ParityHistorySample,
  type ParitySnapshot,
  type TestAreaFile,
} from "./gpu-parity";

/**
 * Reads `.buildkite/test_areas` from vllm-project/vllm at a commit and turns
 * it into a parity snapshot. History samples the directory at one commit per
 * week; file blobs are cached by their git sha, so weeks that share unchanged
 * files cost one raw fetch each rather than one per sample.
 */

export const PARITY_REPO = "vllm-project/vllm";
export const PARITY_REF = "main";
export const PARITY_DIR = ".buildkite/test_areas";

const SNAPSHOT_TTL = 60 * 60 * 1000;
const HISTORY_TTL = 60 * 60 * 1000;
const BLOB_CACHE_LIMIT = 2_000;
const FETCH_CONCURRENCY = 8;
const YAML_PATTERN = /\.ya?ml$/;

export const DEFAULT_HISTORY_WEEKS = 26;
export const MAX_HISTORY_WEEKS = 52;

export interface ParitySource {
  repo: string;
  ref: string;
  directory: string;
  commit: string;
  commitDate: string;
  commitUrl: string;
  fetchedAt: string;
}

export interface ParitySnapshotResponse extends ParitySnapshot {
  source: ParitySource;
}

export interface ParityHistoryResponse {
  source: Pick<ParitySource, "repo" | "ref" | "directory" | "fetchedAt">;
  weeks: number;
  samples: ParityHistorySample[];
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimited: boolean,
  ) {
    super(message);
  }
}

interface CommitRecord {
  sha: string;
  commit: { committer?: { date?: string }; author?: { date?: string } };
}

interface ContentEntry {
  type: string;
  path: string;
  sha: string;
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const rateLimited =
      (response.status === 403 || response.status === 429) &&
      remaining === "0";
    throw new GitHubError(
      `GitHub API ${response.status} for ${url}${
        rateLimited ? " (rate limit exhausted)" : ""
      }`,
      response.status,
      rateLimited,
    );
  }
  return (await response.json()) as T;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/** Latest commit on the ref that touched the test-area directory, optionally at or before `until`. */
export async function resolveTestAreasCommit(
  until?: Date,
): Promise<{ sha: string; date: string } | null> {
  const params = new URLSearchParams({
    sha: PARITY_REF,
    path: PARITY_DIR,
    per_page: "1",
  });
  if (until) params.set("until", until.toISOString());
  const commits = await githubJson<CommitRecord[]>(
    `${GITHUB_API_BASE}/repos/${PARITY_REPO}/commits?${params}`,
  );
  const commit = commits[0];
  if (!commit) return null;
  return {
    sha: commit.sha,
    date:
      commit.commit.committer?.date ??
      commit.commit.author?.date ??
      new Date(0).toISOString(),
  };
}

async function listTestAreaFiles(commit: string): Promise<ContentEntry[]> {
  const entries = await githubJson<ContentEntry[] | { type?: string }>(
    `${GITHUB_API_BASE}/repos/${PARITY_REPO}/contents/${PARITY_DIR}?ref=${encodeURIComponent(commit)}`,
  );
  if (!Array.isArray(entries)) {
    throw new GitHubError(`${PARITY_DIR} is not a directory at ${commit}`, 500, false);
  }
  return entries.filter(
    (entry) => entry.type === "file" && YAML_PATTERN.test(entry.path),
  );
}

// Parsed YAML keyed by blob sha. Insertion order doubles as an eviction order.
const blobCache = new Map<string, unknown>();
const blobInFlight = new Map<string, Promise<unknown>>();

async function loadBlob(
  commit: string,
  path: string,
  blobSha: string,
): Promise<unknown> {
  if (blobCache.has(blobSha)) return blobCache.get(blobSha);
  const pending = blobInFlight.get(blobSha);
  if (pending) return pending;

  const promise = (async () => {
    const response = await fetch(githubRawUrl(PARITY_REPO, commit, path));
    if (!response.ok) {
      throw new GitHubError(
        `GitHub raw ${response.status} for ${path} at ${commit}`,
        response.status,
        false,
      );
    }
    const document = yaml.load(await response.text());
    blobCache.set(blobSha, document);
    if (blobCache.size > BLOB_CACHE_LIMIT) {
      const oldest = blobCache.keys().next().value;
      if (oldest !== undefined) blobCache.delete(oldest);
    }
    return document;
  })().finally(() => {
    blobInFlight.delete(blobSha);
  });
  blobInFlight.set(blobSha, promise);
  return promise;
}

export async function loadTestAreaFilesAt(commit: string): Promise<TestAreaFile[]> {
  const entries = await listTestAreaFiles(commit);
  const files = await mapWithConcurrency(entries, FETCH_CONCURRENCY, async (entry) =>
    parseTestAreaFile(entry.path, await loadBlob(commit, entry.path, entry.sha)),
  );
  return files.filter((file): file is TestAreaFile => file !== null);
}

async function fetchSnapshot(): Promise<ParitySnapshotResponse> {
  const head = await resolveTestAreasCommit();
  if (!head) {
    throw new GitHubError(`No commits touch ${PARITY_DIR} on ${PARITY_REF}`, 404, false);
  }
  const files = await loadTestAreaFilesAt(head.sha);
  if (files.length === 0) {
    throw new GitHubError(`No test area YAML found at ${head.sha}`, 404, false);
  }
  return {
    ...computeParity(files),
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

export async function loadParitySnapshot(): Promise<ParitySnapshotResponse> {
  const { data } = await getOrLoadCached(
    "gpu-parity:snapshot",
    SNAPSHOT_TTL,
    fetchSnapshot,
  );
  return data;
}

/** UTC midnights for the last `weeks` weeks, oldest first, ending today. */
export function weeklySampleDates(weeks: number, now = new Date()): Date[] {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return Array.from({ length: weeks }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - 7 * (weeks - 1 - index));
    return date;
  });
}

export function clampHistoryWeeks(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_HISTORY_WEEKS;
  return Math.min(MAX_HISTORY_WEEKS, Math.max(4, parsed));
}

async function fetchHistory(weeks: number): Promise<ParityHistoryResponse> {
  const dates = weeklySampleDates(weeks);
  const newest = dates[dates.length - 1].getTime();
  // Each sample is the last commit on or before the end of its UTC day. The
  // newest sample is "now" so it matches the snapshot shown beside the trend.
  const commits = await mapWithConcurrency(dates, FETCH_CONCURRENCY, (date) =>
    resolveTestAreasCommit(
      date.getTime() === newest
        ? undefined
        : new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1),
    ),
  );

  const snapshotsByCommit = new Map<string, Promise<ParitySnapshot>>();
  for (const commit of commits) {
    if (!commit || snapshotsByCommit.has(commit.sha)) continue;
    snapshotsByCommit.set(
      commit.sha,
      loadTestAreaFilesAt(commit.sha).then((files) => computeParity(files)),
    );
  }

  const samples: ParityHistorySample[] = [];
  for (const [index, commit] of commits.entries()) {
    // Weeks before the directory existed have no commit and no sample.
    if (!commit) continue;
    const snapshot = await snapshotsByCommit.get(commit.sha)!;
    samples.push({
      date: dates[index].toISOString().slice(0, 10),
      commit: commit.sha,
      commitDate: commit.date,
      ...summarizeForHistory(snapshot),
    });
  }

  return {
    source: {
      repo: PARITY_REPO,
      ref: PARITY_REF,
      directory: PARITY_DIR,
      fetchedAt: new Date().toISOString(),
    },
    weeks,
    samples,
  };
}

export async function loadParityHistory(
  weeks: number,
): Promise<ParityHistoryResponse> {
  const { data } = await getOrLoadCached(
    `gpu-parity:history:${weeks}`,
    HISTORY_TTL,
    () => fetchHistory(weeks),
  );
  return data;
}
