import assert from "node:assert/strict";
import test from "node:test";
import { POST as applied } from "./[host]/applied/route";
import { GET as desired } from "./desired/route";

const valid = { alertId: 7, state: "drained", observed: { cordoned: true, ciPods: 0 } };

function post(body: string, headers: Record<string, string> = {}, host = "gpu-node-7") {
  return applied(
    new Request("http://localhost/api/alerts/quarantine/x/applied", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    }),
    { params: Promise.resolve({ host }) },
  );
}

function get(query: string, headers: Record<string, string> = {}) {
  return desired(
    new Request(`http://localhost/api/alerts/quarantine/desired${query}`, { headers }),
  );
}

async function withSecret(secret: string | undefined, fn: () => Promise<void>) {
  const previous = process.env.GPU_REPORT_SECRET;
  if (secret === undefined) delete process.env.GPU_REPORT_SECRET;
  else process.env.GPU_REPORT_SECRET = secret;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.GPU_REPORT_SECRET;
    else process.env.GPU_REPORT_SECRET = previous;
  }
}

const auth = { authorization: "Bearer secret" };

test("actuator routes: 503 when the reporter secret is not configured", async () => {
  await withSecret(undefined, async () => {
    assert.equal((await post(JSON.stringify(valid), auth)).status, 503);
    assert.equal((await get("?cluster=b200", auth)).status, 503);
  });
});

test("actuator routes: 401 for a missing or wrong token", async () => {
  await withSecret("secret", async () => {
    assert.equal((await post(JSON.stringify(valid))).status, 401);
    assert.equal((await post("not-json", { authorization: "Bearer nope" })).status, 401);
    assert.equal((await get("?cluster=b200")).status, 401);
    assert.equal((await get("?cluster=b200", { authorization: "Bearer nope" })).status, 401);
  });
});

test("desired: 400 for a missing or invalid cluster, without a DB call", async () => {
  await withSecret("secret", async () => {
    assert.equal((await get("", auth)).status, 400);
    assert.equal((await get("?cluster=", auth)).status, 400);
    assert.equal((await get("?cluster=B200%20x", auth)).status, 400);
  });
});

test("applied: 400 for bad bodies and fields, without a DB call", async () => {
  await withSecret("secret", async () => {
    assert.equal((await post("not-json", auth)).status, 400);
    assert.equal((await post("[]", auth)).status, 400);
    assert.equal((await post("{}", auth)).status, 400);
    const bad: Record<string, unknown>[] = [
      { ...valid, alertId: "7" },
      { ...valid, alertId: 0 },
      { ...valid, alertId: 1.5 },
      { ...valid, state: "quarantined" },
      { ...valid, state: undefined },
      { ...valid, observed: [] },
      { ...valid, observed: "cordoned" },
      { ...valid, observed: null },
      { ...valid, observed: { note: "x".repeat(5000) } },
    ];
    for (const body of bad) {
      assert.equal((await post(JSON.stringify(body), auth)).status, 400, JSON.stringify(body));
    }
    const body = JSON.stringify(valid);
    assert.equal((await post(body, auth, "bad host!")).status, 400);
  });
});

test("applied: the H200 host check's verified is an actuator state", async () => {
  await withSecret("secret", async () => {
    const res = await post(JSON.stringify({ ...valid, state: "nope" }), auth);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /\bverified\b/);
  });
});
