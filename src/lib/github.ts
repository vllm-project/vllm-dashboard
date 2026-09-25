export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_RAW_BASE = "https://raw.githubusercontent.com";

/**
 * Headers for GitHub REST calls. A token is optional but raises the rate
 * limit from 60 to 5000 requests per hour, which the test-area discovery and
 * the parity history sampler both rely on in production.
 */
export function githubHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function githubRawUrl(repo: string, ref: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${GITHUB_RAW_BASE}/${repo}/${encodeURIComponent(ref)}/${encodedPath}`;
}
