/**
 * The changed-files list in the item drawer: "4 files · +18 −4" and the
 * first few paths. `triage_items.files` is `[{path, additions, deletions}]`
 * (triage/store.py), capped at 300 entries by the ingest.
 */

export const STORED_FILES_CAP = 300;
export const DRAWER_FILES_SHOWN = 15;

export interface ChangedFile {
  path: string;
  additions: number | null;
  deletions: number | null;
}

export interface FilesSummary {
  /** Files with a path, in stored order. */
  count: number;
  /** True when the ingest cap was hit, so `count` is a lower bound. */
  capped: boolean;
  /** Null when no file reported line counts. */
  additions: number | null;
  deletions: number | null;
  shown: ChangedFile[];
  /** How many more files are not in `shown`. */
  more: number;
  /** "4 files · +18 −4", "1 file", "300+ files · +9000 −12". */
  line: string;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

export function summarizeFiles(raw: unknown, shownMax: number = DRAWER_FILES_SHOWN): FilesSummary {
  const files: ChangedFile[] = (Array.isArray(raw) ? raw : [])
    .filter((entry): entry is { path: string } => !!entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string" && (entry as { path: string }).path.length > 0)
    .map((entry) => {
      const value = entry as { path: string; additions?: unknown; deletions?: unknown };
      return { path: value.path, additions: count(value.additions), deletions: count(value.deletions) };
    });
  const withCounts = files.filter((file) => file.additions !== null || file.deletions !== null);
  const additions = withCounts.length ? withCounts.reduce((sum, file) => sum + (file.additions ?? 0), 0) : null;
  const deletions = withCounts.length ? withCounts.reduce((sum, file) => sum + (file.deletions ?? 0), 0) : null;
  const capped = files.length >= STORED_FILES_CAP;
  const noun = `${files.length}${capped ? "+" : ""} ${files.length === 1 && !capped ? "file" : "files"}`;
  const lines = additions !== null || deletions !== null ? ` · +${additions ?? 0} −${deletions ?? 0}` : "";
  const shown = files.slice(0, Math.max(0, shownMax));
  return {
    count: files.length,
    capped,
    additions,
    deletions,
    shown,
    more: files.length - shown.length,
    line: `${noun}${lines}`,
  };
}

/**
 * GitHub's "Files changed" tab for a PR URL (`…/pull/123` → `…/pull/123/files`),
 * or null for anything else.
 */
export function prFilesUrl(htmlUrl: string): string | null {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(htmlUrl) ? `${htmlUrl}/files` : null;
}

/** GitHub anchors a file in the PR diff as `#diff-<sha256 hex of the path>`. */
export async function fileDiffAnchor(path: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
    return `diff-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}
