import assert from "node:assert/strict";
import test from "node:test";
import { GET as items } from "./items/route";
import { POST as actions } from "./actions/route";
import { PUT as putRules } from "./rules/route";
import { GET as login } from "./auth/login/route";
import { signSession } from "@/lib/triage-auth";

const SECRET = "s".repeat(40);

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ENABLED = {
  TRIAGE_ENABLED: "1",
  TRIAGE_SESSION_SECRET: SECRET,
  TRIAGE_DEV_LOGIN: undefined,
  GITHUB_OAUTH_CLIENT_ID: undefined,
  GITHUB_OAUTH_CLIENT_SECRET: undefined,
};

function session() {
  return `triage_session=${signSession({ login: "alice", exp: Math.floor(Date.now() / 1000) + 600 }, SECRET)}`;
}

test("every triage API 404s while TRIAGE_ENABLED is unset", async () => {
  await withEnv({ ...ENABLED, TRIAGE_ENABLED: undefined }, async () => {
    assert.equal((await items(new Request("https://ci.vllm.ai/api/triage/items"))).status, 404);
    assert.equal((await login(new Request("https://ci.vllm.ai/api/triage/auth/login"))).status, 404);
  });
});

test("no session is 401 and the response is not cacheable", async () => {
  await withEnv(ENABLED, async () => {
    const response = await items(new Request("https://ci.vllm.ai/api/triage/items"));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  });
});

test("a forged session is 401", async () => {
  await withEnv(ENABLED, async () => {
    const forged = signSession({ login: "alice", exp: Math.floor(Date.now() / 1000) + 600 }, "z".repeat(40));
    const response = await items(
      new Request("https://ci.vllm.ai/api/triage/items", { headers: { cookie: `triage_session=${forged}` } }),
    );
    assert.equal(response.status, 401);
  });
});

test("mutations refuse cross-origin requests even with a session", async () => {
  await withEnv(ENABLED, async () => {
    for (const [handler, method] of [
      [actions, "POST"],
      [putRules, "PUT"],
    ] as const) {
      const response = await handler(
        new Request("https://ci.vllm.ai/api/triage/x", {
          method,
          body: "{}",
          headers: { cookie: session(), host: "ci.vllm.ai", origin: "https://evil.example" },
        }),
      );
      assert.equal(response.status, 403);
    }
  });
});

test("same-origin mutations with a session reach validation (400 before any DB call)", async () => {
  await withEnv(ENABLED, async () => {
    const response = await actions(
      new Request("https://ci.vllm.ai/api/triage/actions", {
        method: "POST",
        body: JSON.stringify({ itemKey: "nope", action: "ack" }),
        headers: { cookie: session(), host: "ci.vllm.ai", origin: "https://ci.vllm.ai" },
      }),
    );
    assert.equal(response.status, 400);
  });
});

test("sign-in is 503 until the OAuth app is configured", async () => {
  await withEnv(ENABLED, async () => {
    assert.equal((await login(new Request("https://ci.vllm.ai/api/triage/auth/login"))).status, 503);
  });
  await withEnv({ ...ENABLED, GITHUB_OAUTH_CLIENT_ID: "cid", GITHUB_OAUTH_CLIENT_SECRET: "cs" }, async () => {
    const response = await login(new Request("https://ci.vllm.ai/api/triage/auth/login?next=/triage/me"));
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.host, "github.com");
    assert.equal(location.searchParams.get("redirect_uri"), "https://ci.vllm.ai/api/triage/auth/callback");
    assert.match(response.headers.get("set-cookie") ?? "", /triage_oauth=.*HttpOnly/i);
  });
});
