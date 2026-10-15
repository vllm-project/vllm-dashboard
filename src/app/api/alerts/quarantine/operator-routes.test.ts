import assert from "node:assert/strict";
import test from "node:test";
import { POST as closeIncident } from "../incidents/[id]/close/route";
import { POST as confirmIncident } from "../incidents/[id]/confirm/route";
import { POST as resolveHost } from "./[host]/resolve/route";

type Handler = (
  request: Request,
  context: { params: Promise<never> },
) => Promise<Response>;

const routes: { name: string; post: Handler; params: object; valid: object }[] = [
  {
    name: "resolve",
    post: resolveHost as unknown as Handler,
    params: { host: "h200-1" },
    valid: { by: "oncall", reason: "rebooted" },
  },
  {
    name: "confirm",
    post: confirmIncident as unknown as Handler,
    params: { id: "1" },
    valid: { by: "oncall", cause: "token expired", match: "401 Client Error" },
  },
  {
    name: "close",
    post: closeIncident as unknown as Handler,
    params: { id: "1" },
    valid: { by: "oncall" },
  },
];

function call(
  route: (typeof routes)[number],
  body: string,
  headers: Record<string, string> = {},
  params: object = route.params,
) {
  return route.post(
    new Request("http://localhost/api/alerts/x", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    }),
    { params: Promise.resolve(params as never) },
  );
}

async function withToken(token: string | undefined, fn: () => Promise<void>) {
  const previous = process.env.ALERT_OPERATOR_TOKEN;
  if (token === undefined) delete process.env.ALERT_OPERATOR_TOKEN;
  else process.env.ALERT_OPERATOR_TOKEN = token;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.ALERT_OPERATOR_TOKEN;
    else process.env.ALERT_OPERATOR_TOKEN = previous;
  }
}

for (const route of routes) {
  test(`${route.name}: 503 when the operator token is not configured`, async () => {
    await withToken(undefined, async () => {
      const response = await call(route, "not-json");
      assert.equal(response.status, 503);
    });
  });

  test(`${route.name}: 401 for a missing or wrong token, before reading the body`, async () => {
    await withToken("secret", async () => {
      assert.equal((await call(route, "not-json")).status, 401);
      const wrong = await call(route, "not-json", { authorization: "Bearer nope" });
      assert.equal(wrong.status, 401);
    });
  });

  test(`${route.name}: 400 for non-JSON and non-object bodies`, async () => {
    await withToken("secret", async () => {
      const auth = { authorization: "Bearer secret" };
      assert.equal((await call(route, "not-json", auth)).status, 400);
      assert.equal((await call(route, "[]", auth)).status, 400);
    });
  });

  test(`${route.name}: 400 for missing or oversized fields, without a DB call`, async () => {
    await withToken("secret", async () => {
      const auth = { authorization: "Bearer secret" };
      assert.equal((await call(route, "{}", auth)).status, 400);
      for (const key of Object.keys(route.valid)) {
        const tooLong = { ...route.valid, [key]: "x".repeat(501) };
        const blank = { ...route.valid, [key]: "   " };
        assert.equal((await call(route, JSON.stringify(tooLong), auth)).status, 400, key);
        assert.equal((await call(route, JSON.stringify(blank), auth)).status, 400, key);
      }
    });
  });
}

test("incident routes reject a non-numeric id; resolve rejects a bad host", async () => {
  await withToken("secret", async () => {
    const auth = { authorization: "Bearer secret" };
    for (const route of routes.slice(1)) {
      const body = JSON.stringify(route.valid);
      assert.equal((await call(route, body, auth, { id: "abc" })).status, 400);
      assert.equal((await call(route, body, auth, { id: "0" })).status, 400);
    }
    const body = JSON.stringify(routes[0].valid);
    assert.equal((await call(routes[0], body, auth, { host: "bad host!" })).status, 400);
    // force is optional but must be a boolean; checked before any DB call.
    for (const force of ["true", 1, null]) {
      const forced = JSON.stringify({ ...routes[0].valid, force });
      assert.equal((await call(routes[0], forced, auth)).status, 400, String(force));
    }
  });
});
