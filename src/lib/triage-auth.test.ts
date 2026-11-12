import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedLogins,
  decodeOAuthStateCookie,
  devLogin,
  encodeOAuthStateCookie,
  isSameOrigin,
  loginFromSessionCookie,
  maintainerTeam,
  readCookie,
  safeNextPath,
  signSession,
  statesMatch,
  verifySession,
} from "./triage-auth";

const SECRET = "x".repeat(40);
const NOW = 1_800_000_000;

test("a signed session verifies and returns its login", () => {
  const token = signSession({ login: "octocat", exp: NOW + 60 }, SECRET);
  assert.deepEqual(verifySession(token, SECRET, NOW), { login: "octocat", exp: NOW + 60 });
});

test("a tampered payload, signature, or wrong secret is rejected", () => {
  const token = signSession({ login: "octocat", exp: NOW + 60 }, SECRET);
  const [payload, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ login: "admin", exp: NOW + 60 })).toString("base64url");
  assert.equal(verifySession(`${forged}.${signature}`, SECRET, NOW), null);
  assert.equal(verifySession(`${payload}.${signature.slice(0, -2)}AA`, SECRET, NOW), null);
  assert.equal(verifySession(token, "y".repeat(40), NOW), null);
  assert.equal(verifySession(`${payload}`, SECRET, NOW), null);
  assert.equal(verifySession("", SECRET, NOW), null);
});

test("an expired session is rejected", () => {
  const token = signSession({ login: "octocat", exp: NOW }, SECRET);
  assert.equal(verifySession(token, SECRET, NOW), null);
  assert.equal(verifySession(token, SECRET, NOW - 1)?.login, "octocat");
});

test("no secret (or a short one) means no session", () => {
  const token = signSession({ login: "octocat", exp: NOW + 60 }, SECRET);
  assert.equal(verifySession(token, null, NOW), null);
  assert.equal(
    loginFromSessionCookie(token, { TRIAGE_SESSION_SECRET: "short" }, NOW),
    null,
  );
  assert.equal(
    loginFromSessionCookie(token, { TRIAGE_SESSION_SECRET: SECRET }, NOW),
    "octocat",
  );
});

test("an invalid login inside a validly signed payload is rejected", () => {
  const token = signSession({ login: "bad login<script>", exp: NOW + 60 }, SECRET);
  assert.equal(verifySession(token, SECRET, NOW), null);
});

test("the dev login bypass never applies in production", () => {
  assert.equal(devLogin({ NODE_ENV: "development", TRIAGE_DEV_LOGIN: "me" }), "me");
  assert.equal(devLogin({ NODE_ENV: "production", TRIAGE_DEV_LOGIN: "me" }), null);
  assert.equal(
    loginFromSessionCookie(undefined, { NODE_ENV: "production", TRIAGE_DEV_LOGIN: "me" }),
    null,
  );
});

test("readCookie finds one cookie in a header", () => {
  assert.equal(readCookie("a=1; triage_session=abc.def; b=2", "triage_session"), "abc.def");
  assert.equal(readCookie("a=1", "triage_session"), undefined);
  assert.equal(readCookie(null, "triage_session"), undefined);
});

function request(headers: Record<string, string>) {
  return new Request("https://ci.vllm.ai/api/triage/actions", { method: "POST", headers });
}

test("same-origin requires a matching Origin host", () => {
  assert.equal(isSameOrigin(request({ host: "ci.vllm.ai", origin: "https://ci.vllm.ai" })), true);
  assert.equal(isSameOrigin(request({ host: "ci.vllm.ai", origin: "https://evil.example" })), false);
  assert.equal(isSameOrigin(request({ host: "ci.vllm.ai", origin: "null" })), false);
  assert.equal(
    isSameOrigin(request({ host: "internal", "x-forwarded-host": "ci.vllm.ai", origin: "https://ci.vllm.ai" })),
    true,
  );
});

test("without Origin only Sec-Fetch-Site: same-origin passes", () => {
  assert.equal(isSameOrigin(request({ host: "ci.vllm.ai" })), false);
  assert.equal(isSameOrigin(request({ host: "ci.vllm.ai", "sec-fetch-site": "same-origin" })), true);
  assert.equal(isSameOrigin(request({ host: "ci.vllm.ai", "sec-fetch-site": "cross-site" })), false);
});

test("post-sign-in redirects stay under /triage", () => {
  assert.equal(safeNextPath("/triage/me"), "/triage/me");
  assert.equal(safeNextPath("/triage?item=a"), "/triage?item=a");
  assert.equal(safeNextPath("/triagex"), "/triage");
  assert.equal(safeNextPath("https://evil.example/triage"), "/triage");
  assert.equal(safeNextPath("//evil.example"), "/triage");
  assert.equal(safeNextPath("/triage/\\evil"), "/triage");
  assert.equal(safeNextPath(null), "/triage");
});

test("OAuth state round-trips and compares in constant time", () => {
  const cookie = encodeOAuthStateCookie("abc", "/triage/rules");
  assert.deepEqual(decodeOAuthStateCookie(cookie), { state: "abc", next: "/triage/rules" });
  assert.equal(decodeOAuthStateCookie("garbage"), null);
  assert.equal(statesMatch("abc", "abc"), true);
  assert.equal(statesMatch("abc", "abd"), false);
  assert.equal(statesMatch("abc", null), false);
});

test("allowlist and team settings parse", () => {
  assert.deepEqual([...allowedLogins({ TRIAGE_ALLOWED_LOGINS: " Alice, bob ,," })], ["alice", "bob"]);
  assert.deepEqual(maintainerTeam({ TRIAGE_MAINTAINER_TEAM: "vllm-project/committers" }), {
    org: "vllm-project",
    team: "committers",
  });
  assert.equal(maintainerTeam({ TRIAGE_MAINTAINER_TEAM: "nope" }), null);
});
