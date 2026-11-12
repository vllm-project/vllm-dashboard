import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Access control for the maintainers-only Triage tab.
 *
 * - `TRIAGE_ENABLED=1` turns the whole feature on; otherwise pages and APIs 404.
 * - A session is an HMAC-SHA256-signed cookie `{login, exp}`. The GitHub OAuth
 *   token is used once at sign-in to check team membership and never stored.
 * - `TRIAGE_DEV_LOGIN` signs everyone in as that login, outside production only.
 */

export const SESSION_COOKIE = "triage_session";
export const OAUTH_STATE_COOKIE = "triage_oauth";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const MIN_SECRET_LENGTH = 32;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface TriageSession {
  login: string;
  exp: number;
}

type Env = Record<string, string | undefined>;

export function triageEnabled(env: Env = process.env): boolean {
  return env.TRIAGE_ENABLED === "1";
}

export function sessionSecret(env: Env = process.env): string | null {
  const secret = env.TRIAGE_SESSION_SECRET;
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

export function devLogin(env: Env = process.env): string | null {
  if (env.NODE_ENV === "production") return null;
  const login = env.TRIAGE_DEV_LOGIN?.trim();
  return login && isValidLogin(login) ? login : null;
}

export function isValidLogin(login: string): boolean {
  return LOGIN_PATTERN.test(login);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signSession(session: TriageSession, secret: string): string {
  const payload = base64url(JSON.stringify({ login: session.login, exp: session.exp }));
  return `${payload}.${base64url(hmac(payload, secret))}`;
}

export function verifySession(
  token: string | undefined | null,
  secret: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TriageSession | null {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = hmac(payload, secret);
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { login, exp } = parsed as { login?: unknown; exp?: unknown };
  if (typeof login !== "string" || !isValidLogin(login)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowSeconds) return null;
  return { login, exp };
}

export function newSession(login: string, nowSeconds = Math.floor(Date.now() / 1000)): TriageSession {
  return { login, exp: nowSeconds + SESSION_TTL_SECONDS };
}

/** Reads one cookie from a raw `Cookie` header. */
export function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}

/** The signed-in login for a cookie value, honouring the dev bypass. */
export function loginFromSessionCookie(
  cookieValue: string | undefined,
  env: Env = process.env,
  nowSeconds?: number,
): string | null {
  const dev = devLogin(env);
  if (dev) return dev;
  return verifySession(cookieValue, sessionSecret(env), nowSeconds)?.login ?? null;
}

/**
 * CSRF guard for mutating routes. The session cookie is SameSite=Lax, and in
 * addition the request must carry an Origin whose host equals the Host the
 * request was sent to. Without an Origin header, only `Sec-Fetch-Site:
 * same-origin` is accepted.
 */
export function isSameOrigin(request: Request): boolean {
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    safeHost(request.url);
  const origin = request.headers.get("origin");
  if (origin) {
    if (origin === "null") return false;
    const originHost = safeHost(origin);
    return Boolean(host && originHost && originHost === host);
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Only same-site paths under /triage may be a post-sign-in destination. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return "/triage";
  if (!next.startsWith("/triage")) return "/triage";
  if (next.startsWith("//") || next.includes("\\") || /[\r\n]/.test(next)) {
    return "/triage";
  }
  const rest = next.slice("/triage".length);
  if (rest && !/^[/?#]/.test(rest)) return "/triage";
  return next;
}

export function newOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

export function encodeOAuthStateCookie(state: string, next: string): string {
  return base64url(JSON.stringify({ state, next }));
}

export function decodeOAuthStateCookie(
  value: string | undefined,
): { state: string; next: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      state?: unknown;
      next?: unknown;
    };
    if (typeof parsed.state !== "string" || typeof parsed.next !== "string") return null;
    return { state: parsed.state, next: safeNextPath(parsed.next) };
  } catch {
    return null;
  }
}

export function statesMatch(expected: string, received: string | null): boolean {
  if (!received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function allowedLogins(env: Env = process.env): Set<string> {
  return new Set(
    (env.TRIAGE_ALLOWED_LOGINS ?? "")
      .split(",")
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** `TRIAGE_MAINTAINER_TEAM=org/team-slug` → {org, team}. */
export function maintainerTeam(
  env: Env = process.env,
): { org: string; team: string } | null {
  const raw = env.TRIAGE_MAINTAINER_TEAM?.trim();
  if (!raw) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(raw);
  return match ? { org: match[1], team: match[2] } : null;
}

export function sessionCookieOptions(env: Env = process.env, maxAge = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}
