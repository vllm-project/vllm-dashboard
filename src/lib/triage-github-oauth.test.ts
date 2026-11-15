import assert from "node:assert/strict";
import test from "node:test";
import { exchangeCode, authorizeUrl, callbackUrl, canonicalOrigin, isTriageMaintainer } from "./triage-github-oauth";

function fakeFetch(status: number, body: unknown, calls: string[] = []) {
  return (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

test("authorize URL asks only for read:org and carries state", () => {
  const url = new URL(authorizeUrl("cid", "https://ci.vllm.ai/api/triage/auth/callback", "s1", "chal"));
  assert.equal(url.searchParams.get("scope"), "read:org");
  assert.equal(url.searchParams.get("code_challenge"), "chal");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "s1");
  assert.equal(url.searchParams.get("client_id"), "cid");
});

test("allowlisted logins pass without a GitHub call", async () => {
  const calls: string[] = [];
  assert.equal(
    await isTriageMaintainer("Alice", "t", { TRIAGE_ALLOWED_LOGINS: "alice" }, fakeFetch(500, {}, calls)),
    true,
  );
  assert.equal(calls.length, 0);
});

test("team membership must be active", async () => {
  const env = { TRIAGE_MAINTAINER_TEAM: "vllm-project/committers" };
  const calls: string[] = [];
  assert.equal(await isTriageMaintainer("bob", "t", env, fakeFetch(200, { state: "active" }, calls)), true);
  assert.match(calls[0], /\/orgs\/vllm-project\/teams\/committers\/memberships\/bob$/);
  assert.equal(await isTriageMaintainer("bob", "t", env, fakeFetch(200, { state: "pending" })), false);
  assert.equal(await isTriageMaintainer("bob", "t", env, fakeFetch(404, {})), false);
});

test("with neither allowlist nor team, nobody is a maintainer", async () => {
  assert.equal(await isTriageMaintainer("bob", "t", {}, fakeFetch(200, { state: "active" })), false);
});

test("the callback URL comes from configuration, never the request", () => {
  assert.equal(callbackUrl({}), "https://ci.vllm.ai/api/triage/auth/callback");
  assert.equal(canonicalOrigin({ TRIAGE_CANONICAL_ORIGIN: "https://ci.vllm.ai/some/path" }), "https://ci.vllm.ai");
  assert.throws(() => canonicalOrigin({ TRIAGE_CANONICAL_ORIGIN: "http://ci.vllm.ai" }));
});

test("the token exchange sends the PKCE verifier", async () => {
  let sent: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
  }) as typeof fetch;
  const token = await exchangeCode("code", "https://ci.vllm.ai/api/triage/auth/callback",
    { clientId: "cid", clientSecret: "cs" }, "verifier-123", fetchImpl);
  assert.equal(token, "tok");
  assert.equal(sent.code_verifier, "verifier-123");
});
