import { allowedLogins, maintainerTeam } from "@/lib/triage-auth";

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "vllm-ci-dashboard-triage";

export function oauthConfig(env: Env = process.env): { clientId: string; clientSecret: string } | null {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:org");
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

export function callbackUrl(requestUrl: string, env: Env = process.env): string {
  return env.TRIAGE_OAUTH_REDIRECT_URI || new URL("/api/triage/auth/callback", requestUrl).toString();
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  config: { clientId: string; clientSecret: string },
  fetchImpl: Fetch = fetch,
): Promise<string | null> {
  const response = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    cache: "no-store",
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { access_token?: unknown };
  return typeof body.access_token === "string" ? body.access_token : null;
}

function githubHeaders(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function fetchLogin(token: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  const response = await fetchImpl(`${GITHUB_API}/user`, { headers: githubHeaders(token), cache: "no-store" });
  if (!response.ok) return null;
  const body = (await response.json()) as { login?: unknown };
  return typeof body.login === "string" ? body.login : null;
}

export async function isActiveTeamMember(
  token: string,
  team: { org: string; team: string },
  login: string,
  fetchImpl: Fetch = fetch,
): Promise<boolean> {
  const url = `${GITHUB_API}/orgs/${encodeURIComponent(team.org)}/teams/${encodeURIComponent(team.team)}/memberships/${encodeURIComponent(login)}`;
  const response = await fetchImpl(url, { headers: githubHeaders(token), cache: "no-store" });
  if (!response.ok) return false;
  const body = (await response.json()) as { state?: unknown };
  return body.state === "active";
}

/**
 * Whether a GitHub login may use triage: listed in TRIAGE_ALLOWED_LOGINS, or
 * an active member of TRIAGE_MAINTAINER_TEAM (checked with the user's own
 * read:org token, which is then discarded).
 */
export async function isTriageMaintainer(
  login: string,
  token: string,
  env: Env = process.env,
  fetchImpl: Fetch = fetch,
): Promise<boolean> {
  if (allowedLogins(env).has(login.toLowerCase())) return true;
  const team = maintainerTeam(env);
  if (!team) return false;
  return isActiveTeamMember(token, team, login, fetchImpl);
}
