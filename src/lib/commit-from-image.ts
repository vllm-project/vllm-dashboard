export function commitFromImage(image: string | null | undefined): string | null {
  if (!image) return null;
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon <= slash) return null;

  const tag = image.slice(colon + 1).split("@")[0];
  const nightlyMatch = tag.match(/^nightly-([0-9a-f]{7,40})(?:[-_.].*)?$/i);
  if (nightlyMatch) return nightlyMatch[1];

  const shaMatch = tag.match(/(?:^|[-_.])([0-9a-f]{12,40})(?:$|[-_.])/i);
  return shaMatch?.[1] ?? null;
}

export type ImageKind = "release" | "nightly" | "commit" | "other";

export interface ImageInfo {
  kind: ImageKind;
  /** Release version without the leading "v" (e.g. "0.26.0"). */
  version?: string;
  /** Date embedded in a date-based nightly tag (e.g. "2026-09-01"). */
  date?: string;
  /** Commit sha embedded in the tag, as found (7-40 hex chars). */
  sha?: string;
}

const VERSION_RE = /^v?(\d+\.\d+\.\d+)(?:[-_.+].*)?$/;
const NIGHTLY_RE = /^nightly(?:[-_.](.+))?$/i;
const TAG_DATE_RE = /^(\d{4}[-.]\d{2}[-.]\d{2})/;
const PURE_SHA_RE = /^[0-9a-f]{7,40}$/i;
const SEGMENT_SHA_RE = /(?:^|[-_.])([0-9a-f]{12,40})(?:$|[-_.])/i;

// Images built by the main vLLM CI and tagged with a bare commit sha.
const CI_COMMIT_REPO_RE = /vllm-(release|ci-test)-repo/;

function imageTag(image: string): string | null {
  const withoutDigest = image.split("@")[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  if (colon <= slash) return null;
  return withoutDigest.slice(colon + 1);
}

function imageRepo(image: string): string {
  const withoutDigest = image.split("@")[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

export function classifyImage(image: string | null | undefined): ImageInfo {
  const tag = image ? imageTag(image) : null;
  if (!tag) return { kind: "other" };

  const nightly = tag.match(NIGHTLY_RE);
  if (nightly) {
    const rest = nightly[1] ?? "";
    const date = rest.match(TAG_DATE_RE);
    if (date) return { kind: "nightly", date: date[1] };
    if (PURE_SHA_RE.test(rest)) return { kind: "nightly", sha: rest };
    const version = rest.match(VERSION_RE);
    if (version) return { kind: "nightly", version: version[1] };
    return { kind: "nightly" };
  }

  const version = tag.match(VERSION_RE);
  if (version) return { kind: "release", version: version[1] };

  if (PURE_SHA_RE.test(tag)) return { kind: "commit", sha: tag };
  const sha = tag.match(SEGMENT_SHA_RE);
  if (sha) return { kind: "commit", sha: sha[1] };

  return { kind: "other" };
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function imageDateMs(
  image: string,
  dates?: Record<string, string>
): number {
  const raw = dates?.[image];
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

export interface GroupedImages {
  nightly: string[];
  release: string[];
  commit: string[];
  other: string[];
}

/**
 * Group images by kind and sort each group newest first.
 * Recency comes from per-image run dates when available; releases fall
 * back to semver order and everything else to a name tiebreak.
 */
export function groupImagesByKind(
  images: string[],
  dates?: Record<string, string>
): GroupedImages {
  const groups: GroupedImages = { nightly: [], release: [], commit: [], other: [] };
  for (const image of images) {
    groups[classifyImage(image).kind].push(image);
  }

  const byDateDesc = (a: string, b: string) =>
    imageDateMs(b, dates) - imageDateMs(a, dates) || a.localeCompare(b);

  groups.release.sort((a, b) => {
    const va = classifyImage(a).version;
    const vb = classifyImage(b).version;
    if (va && vb) return compareVersionsDesc(va, vb) || byDateDesc(a, b);
    return byDateDesc(a, b);
  });
  groups.nightly.sort(byDateDesc);
  groups.commit.sort(byDateDesc);
  groups.other.sort((a, b) => a.localeCompare(b));
  return groups;
}

/** Images grouped by kind, flattened with the most actionable kinds first. */
export function sortImagesByKind(
  images: string[],
  dates?: Record<string, string>
): string[] {
  const groups = groupImagesByKind(images, dates);
  return [...groups.nightly, ...groups.release, ...groups.commit, ...groups.other];
}

// Restrict a sorted list to the repo of its first (most recent) entry, so a
// preset never pairs images from different repos (e.g. CUDA vs ROCm nightlies).
function topRepoSubset(sorted: string[]): string[] {
  if (sorted.length === 0) return sorted;
  const repo = imageRepo(sorted[0]);
  return sorted.filter((image) => imageRepo(image) === repo);
}

export interface ComparePreset {
  id: string;
  label: string;
  baseline: string;
  candidate: string;
}

/**
 * Resolve the fixed preset definitions against the available images.
 * Only presets whose baseline and candidate both resolve are returned.
 */
export function resolveComparePresets(
  images: string[],
  dates?: Record<string, string>
): ComparePreset[] {
  const groups = groupImagesByKind(images, dates);
  const nightlies = topRepoSubset(groups.nightly);
  const releases = topRepoSubset(groups.release);
  const mainCommits = groups.commit.filter((image) =>
    CI_COMMIT_REPO_RE.test(image)
  );

  const presets: ComparePreset[] = [];
  if (nightlies[0] && nightlies[1]) {
    presets.push({
      id: "nightly-vs-previous-nightly",
      label: "Latest nightly vs previous nightly",
      baseline: nightlies[1],
      candidate: nightlies[0],
    });
  }
  if (releases[0] && releases[1]) {
    presets.push({
      id: "release-vs-previous-release",
      label: "Latest release vs previous release",
      baseline: releases[1],
      candidate: releases[0],
    });
  }
  if (nightlies[0] && releases[0] && nightlies[0] !== releases[0]) {
    presets.push({
      id: "nightly-vs-release",
      label: "Latest nightly vs latest release",
      baseline: releases[0],
      candidate: nightlies[0],
    });
  }
  if (mainCommits[0] && releases[0] && mainCommits[0] !== releases[0]) {
    presets.push({
      id: "main-commit-vs-release",
      label: "Latest main commit vs latest release",
      baseline: releases[0],
      candidate: mainCommits[0],
    });
  }
  return presets;
}

function formatImageDate(raw: string): string | null {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Short human label for an image, e.g. "release v0.26.0" or "nightly 94c0ef3". */
export function describeImage(
  image: string,
  dates?: Record<string, string>
): string {
  const info = classifyImage(image);
  let label: string;
  switch (info.kind) {
    case "release":
      label = `release v${info.version}`;
      break;
    case "nightly":
      label = info.sha
        ? `nightly ${info.sha.slice(0, 7)}`
        : info.date
          ? `nightly ${info.date}`
          : info.version
            ? `nightly v${info.version}`
            : "nightly (moving tag)";
      break;
    case "commit":
      label = `commit ${info.sha?.slice(0, 7)}`;
      break;
    default:
      label = imageTag(image) ?? image;
  }

  const runDate = dates?.[image] ? formatImageDate(dates[image]) : null;
  return runDate ? `${label} · ${runDate}` : label;
}
