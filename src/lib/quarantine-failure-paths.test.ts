import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "./quarantine-actions";
import {
  actuatorCall,
  desiredQuarantines,
  operatorPost,
  recordActuatorState,
  resolveQuarantine,
} from "./quarantine-actions";

/**
 * A fake tagged-template DB that answers each query with the next row set and
 * keeps each query's text and interpolated values. `json` stands in for
 * postgres.js' db.json, which recordActuatorState uses for the observation.
 */
function recordingDb(...answers: Record<string, unknown>[][]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
      return answers.shift() ?? [];
    },
    { json: (value: unknown) => ({ json: value }) },
  ) as unknown as Db;
  return { db, calls };
}

const ok = { status: 200, body: { ok: true } };

test("a report from an older episode of the host is a 409 and writes nothing", async () => {
  // The host's open quarantine is alert 9; the actuator still holds alert 7's id.
  const { db, calls } = recordingDb([], [{ alert_id: "9" }]);
  const result = await recordActuatorState(db, "n1", 7, "drained", { ciPods: 0 });
  assert.equal(result.status, 409);
  assert.match(String(result.body.error), /not this host's open quarantine/);
  assert.equal(calls.length, 2);
  // The write is scoped to the one episode the report names, still open.
  assert.match(calls[0].sql, /status = 'open' AND alert_id = \?/);
  assert.ok(calls[0].values.includes(7) && calls[0].values.includes("n1"));
  // The follow-up looks only at this host's open episode, to tell 404 from 409.
  assert.match(calls[1].sql, /subject_key = \? AND status = 'open'/);
  assert.deepEqual(calls[1].values, ["n1"]);
  // The observation is stored as given.
  assert.deepEqual(calls[0].values.at(-3), { json: { ciPods: 0 } });
});

test("a late report after the host returned is a 404, not a write", async () => {
  // The worker closed the episode before the actuator's last post arrived.
  const { db } = recordingDb([], []);
  const result = await recordActuatorState(db, "n1", 7, "returned", {});
  assert.deepEqual(result, {
    status: 404,
    body: { error: "This host has no open quarantine." },
  });
});

test("a report is recorded without moving the stage", async () => {
  const { db, calls } = recordingDb([{ alert_id: "7" }]);
  assert.deepEqual(await recordActuatorState(db, "n1", 7, "out", null), ok);
  assert.equal(calls.length, 1);
  // The worker alone moves stages; a report only merges its own keys.
  assert.doesNotMatch(calls[0].sql, /'stage'/);
  assert.match(calls[0].sql, /'actuator_state', \?::text/);
  assert.match(calls[0].sql, /'actuator_state_at', now\(\)/);
  // No observation is stored as SQL null, not as the JSON text "null".
  assert.equal(calls[0].values.includes(null), true);
});

test("a resolve for a host with no episode at all says it was never quarantined", async () => {
  const result = await resolveQuarantine(recordingDb([], []).db, "n9", "oncall", "fixed");
  assert.deepEqual(result, {
    status: 404,
    body: { error: "This host has never been quarantined." },
  });
});

test("a database error during a report reaches the caller, never a 200", async () => {
  const db = (async () => {
    throw new Error("connection terminated");
  }) as unknown as Db;
  await assert.rejects(recordActuatorState(db, "n1", 7, "out", null), /connection terminated/);
});

test("a second resolve after a first is a 409; forcing it goes through", async () => {
  // First: waiting for a reading. Second (no force): nothing to update.
  const first = recordingDb([{ alert_id: "7" }]);
  assert.equal((await resolveQuarantine(first.db, "n1", "a", "fixed")).status, 200);
  const second = recordingDb([], [{ stage: "resolve_requested" }]);
  const refused = await resolveQuarantine(second.db, "n1", "b", "fixed");
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /skip the check/);
  // A forced one may take a waiting resolve straight to resolving.
  const forced = recordingDb([{ alert_id: "7" }]);
  assert.equal((await resolveQuarantine(forced.db, "n1", "b", "fixed", true)).status, 200);
  assert.deepEqual(forced.calls[0].values.slice(0, 2), [true, true]);
});

test("a resolve that loses the race to the return is a 409 and never reopens it", async () => {
  // The worker closed the episode between the person's click and the write.
  const { db, calls } = recordingDb([], [{ stage: "resolved" }]);
  const result = await resolveQuarantine(db, "n1", "oncall", "fixed", true);
  // The follow-up reads the host's latest episode, whichever way it ended.
  assert.match(calls[1].sql, /subject_key = \? ORDER BY opened_at DESC LIMIT 1/);
  assert.deepEqual(calls[1].values, ["n1"]);
  assert.equal(result.status, 409);
  assert.match(String(result.body.error), /already resolved/);
  // Even forced, only a held, applied or waiting episode can be resolved.
  assert.match(calls[0].sql, /status = 'open'/);
  assert.match(calls[0].sql, /stage' IN \('held', 'quarantining', 'quarantined'\)/);
});

test("the desired set lists only open episodes, so a returned host drops out", async () => {
  const { db, calls } = recordingDb([], []);
  const result = await desiredQuarantines(db, "h100");
  assert.deepEqual(result, { status: 200, body: { nodes: [] } });
  assert.match(calls[1].sql, /status = 'open'/);
  assert.ok(calls[1].values.includes("h100"));
});

const goodAuth = { authorization: "Bearer secret" };

const logged: unknown[][] = [];

async function withEnv(name: string, value: string, fn: () => Promise<void>) {
  const previous = process.env[name];
  process.env[name] = value;
  const log = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    await fn();
  } finally {
    console.error = log;
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const post = () =>
  new Request("http://localhost/x", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json", ...goodAuth },
  });

test("an unexpected database failure is a generic 500 that leaks nothing", async () => {
  await withEnv("GPU_REPORT_SECRET", "secret", async () => {
    const res = await actuatorCall(post(), "Recording a quarantine action", async () => {
      throw new Error('password authentication failed for user "postgres"');
    });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = JSON.stringify(await res.json());
    assert.match(text, /Recording a quarantine action failed/);
    assert.doesNotMatch(text, /password|postgres/);
    // The detail goes to the server log, under the call's name.
    assert.equal(logged.at(-1)?.[0], "Recording a quarantine action failed:");
  });
});

test("an unmigrated database is a 503, not a 500", async () => {
  await withEnv("ALERT_OPERATOR_TOKEN", "secret", async () => {
    const res = await operatorPost(post(), "Resolving a quarantine", async () => {
      throw Object.assign(new Error('relation "alerting_infra_alerts" does not exist'), {
        code: "42P01",
      });
    });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not deployed yet/);
  });
});

test("a missing database url fails the call before anything is written", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  await withEnv("GPU_REPORT_SECRET", "secret", async () => {
    try {
      const res = await actuatorCall(post(), "Reading desired quarantines", async (_b, db) =>
        desiredQuarantines(db(), "h100"),
      );
      assert.equal(res.status, 500);
    } finally {
      if (previous !== undefined) process.env.DATABASE_URL = previous;
    }
  });
});
