export interface CompareImagePair {
  baseline: string;
  candidate: string;
}

export interface NightlyImageEntry {
  sourceImage: string;
  deltaVsPrev?: {
    prevSourceImage?: string | null;
  };
}

interface ReleaseImage {
  image: string;
  version: [number, number, number];
}

const OFFICIAL_RELEASE_RE =
  /^vllm\/vllm-openai:v(\d+)\.(\d+)\.(\d+)$/i;
const NIGHTLY_COMMIT_RE =
  /(?:nightly-|vllm-release-repo:)([0-9a-f]{7,40})(?:[-_.](.+))?$/i;

function compareVersion(
  a: [number, number, number],
  b: [number, number, number]
) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function latestReleasePair(images: string[]): CompareImagePair | null {
  const releases: ReleaseImage[] = images.flatMap((image) => {
    const match = image.match(OFFICIAL_RELEASE_RE);
    if (!match) return [];
    return [
      {
        image,
        version: [Number(match[1]), Number(match[2]), Number(match[3])],
      },
    ];
  });

  releases.sort((a, b) => compareVersion(a.version, b.version));
  if (releases.length < 2) return null;

  return {
    baseline: releases[releases.length - 2].image,
    candidate: releases[releases.length - 1].image,
  };
}

export function latestNightlyPair(
  nightlies: NightlyImageEntry[],
  availableImages: string[]
): CompareImagePair | null {
  const available = new Set(availableImages);
  const candidate = nightlies[0]?.sourceImage;
  const baseline =
    nightlies[0]?.deltaVsPrev?.prevSourceImage ?? nightlies[1]?.sourceImage;

  if (
    !baseline ||
    !candidate ||
    baseline === candidate ||
    !available.has(baseline) ||
    !available.has(candidate)
  ) {
    return null;
  }

  return { baseline, candidate };
}

export function compareImageLabel(image: string): string {
  const release = image.match(OFFICIAL_RELEASE_RE);
  if (release) return `Release v${release[1]}.${release[2]}.${release[3]}`;

  const nightly = image.match(NIGHTLY_COMMIT_RE);
  if (nightly) {
    const suffix = nightly[2]?.replace(/[-_.]+/g, " ");
    return `Nightly ${nightly[1].slice(0, 7)}${suffix ? ` · ${suffix}` : ""}`;
  }

  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(colon + 1) : image;
}
