import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "./quarantine-actions";
import {
  closeIncident,
  confirmIncident,
  desiredQuarantines,
  resolveQuarantine,
} from "./quarantine-actions";

/** A fake tagged-template DB that answers each query with the next row set. */
function fakeDb(...answers: Record<string, unknown>[][]) {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    queries.push(strings.join("?").replace(/\s+/g, " ").trim());
    return answers.shift() ?? [];
  }) as unknown as Db;
  return { db, queries };
}

/** A fake DB that also records each query's interpolated values. */
function recordingDb(...answers: Record<string, unknown>[][]) {
  const values: unknown[][] = [];
  const db = (async (_strings: TemplateStringsArray, ...args: unknown[]) => {
    values.push(args);
    return answers.shift() ?? [];
  }) as unknown as Db;
  return { db, values };
}

test("resolving waits for a clean reading unless forced or held", async () => {
  const waits = recordingDb([{ alert_id: "7" }]);
  await resolveQuarantine(waits.db, "h200-1", "oncall", "rebooted");
  assert.deepEqual(waits.values[0].slice(0, 2), [false, false]);
  const forced = recordingDb([{ alert_id: "7" }]);
  await resolveQuarantine(forced.db, "h200-1", "oncall", "rebooted", true);
  assert.deepEqual(forced.values[0].slice(0, 2), [true, true]);
  // A held host never went out; waiting on a reading would take it out.
  const { db, queries } = fakeDb([{ alert_id: "7" }]);
  await resolveQuarantine(db, "h200-1", "oncall", "rebooted");
  assert.match(
    queries[0],
    /'stage', CASE WHEN \?::boolean OR details->>'stage' = 'held' THEN 'resolving' ELSE 'resolve_requested' END,/,
  );
});

test("resolving moves an open, applied or held quarantine on", async () => {
  const { db, queries } = fakeDb([{ alert_id: "7" }]);
  const result = await resolveQuarantine(db, "h200-1", "oncall", "rebooted");
  assert.deepEqual(result, { status: 200, body: { ok: true, alertId: 7 } });
  assert.equal(queries.length, 1);
  assert.match(queries[0], /'resolve_forced', \?::boolean/);
  assert.match(queries[0], /alert_type = 'quarantine'/);
  assert.match(queries[0], /status = 'open'/);
  assert.match(
    queries[0],
    /IN \('held', 'quarantining', 'quarantined'\) OR \(\?::boolean AND details->>'stage' = 'resolve_requested'\)/,
  );
  // A return check that failed before must not bounce this resolve.
  assert.match(queries[0], /'actuator_state', NULL::text/);
  assert.match(queries[0], /'verify_note', NULL::text/);
  assert.match(queries[0], /'verify_check', NULL::text/);
  // A forced resolve's stuck timer runs from this request, not an old hand-over.
  assert.match(queries[0], /'resolving_at', NULL::text/);
  // The H200 pauser returns a host it never took out without a check.
  assert.match(queries[0], /'resolved_while_held', \(details->>'stage' = 'held'\)/);
});

test("the desired set carries each host's last actuator report", async () => {
  // The first answer goes to the stage-list fragment, db(ACTUATED_STAGES).
  const { db } = fakeDb([], [
    {
      host: "n1",
      alert_id: "7",
      stage: "resolving",
      reason: "Xid 79",
      actuator_state: "verify_failed",
      resolved_while_held: "true",
    },
  ]);
  const result = await desiredQuarantines(db, "h100");
  // The actuator keeps a node out while its resolve waits on a reading.
  // db(ACTUATED_STAGES) is a fragment call: the list is its first argument.
  const firstArgs: unknown[] = [];
  const stagesDb = (async (first: unknown) => {
    firstArgs.push(first);
    return [];
  }) as unknown as Db;
  await desiredQuarantines(stagesDb, "h100");
  assert.deepEqual(firstArgs[0], [
    "would",
    "quarantining",
    "quarantined",
    "resolve_requested",
    "resolving",
  ]);
  assert.deepEqual(result.body.nodes, [
    {
      host: "n1",
      alertId: 7,
      stage: "resolving",
      reason: "Xid 79",
      actuatorState: "verify_failed",
      resolvedWhileHeld: true,
    },
  ]);
  const notHeld = fakeDb([], [{ host: "n1", alert_id: "7", resolved_while_held: null }]);
  const plain = await desiredQuarantines(notHeld.db, "h100");
  const [node] = (plain.body as { nodes: { resolvedWhileHeld: boolean }[] }).nodes;
  assert.equal(node.resolvedWhileHeld, false);
});

test("resolving a dry-run quarantine is a 409 that says nothing was applied", async () => {
  const result = await resolveQuarantine(fakeDb([], [{ stage: "would" }]).db, "h", "k", "r");
  assert.equal(result.status, 409);
  assert.match(String(result.body.error), /dry-run/);
});

test("resolving twice, or after the host is back, is a 409", async () => {
  for (const [stage, expected] of [
    ["resolve_requested", /already waiting for a clean reading; skip the check/],
    ["resolving", /already being resolved/],
    ["resolved", /already resolved/],
  ] as const) {
    const { db } = fakeDb([], [{ stage }]);
    const result = await resolveQuarantine(db, "h", "k", "r");
    assert.equal(result.status, 409, stage);
    assert.match(String(result.body.error), expected, stage);
  }
});

test("resolving a host never quarantined is a 404", async () => {
  assert.equal((await resolveQuarantine(fakeDb([], []).db, "nope", "k", "r")).status, 404);
});

test("confirming a suspected incident succeeds", async () => {
  const { db, queries } = fakeDb([{ incident_id: "3" }]);
  const result = await confirmIncident(db, 3, "oncall", "token expired", "401");
  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.match(queries[0], /state = 'suspected'/);
});

test("confirming a closed or already confirmed incident is a 409", async () => {
  for (const state of ["closed", "self_closed", "confirmed"]) {
    const { db } = fakeDb([], [{ state }]);
    assert.equal((await confirmIncident(db, 3, "k", "c", "m")).status, 409, state);
  }
});

test("confirming an unknown incident is a 404", async () => {
  const { db } = fakeDb([], []);
  assert.equal((await confirmIncident(db, 99, "k", "c", "m")).status, 404);
});

test("closing a confirmed incident ends its window", async () => {
  const { db, queries } = fakeDb([{ incident_id: "3" }]);
  assert.equal((await closeIncident(db, 3, "oncall")).status, 200);
  assert.match(queries[0], /window_end = now\(\)/);
  assert.match(queries[0], /state = 'confirmed'/);
});

test("closing a suspected incident is a 409 that says to confirm first", async () => {
  const { db } = fakeDb([], [{ state: "suspected" }]);
  const result = await closeIncident(db, 3, "k");
  assert.equal(result.status, 409);
  assert.match(String(result.body.error), /Confirm it first/);
});

test("closing an already closed incident is a 409; unknown is a 404", async () => {
  assert.equal((await closeIncident(fakeDb([], [{ state: "closed" }]).db, 3, "k")).status, 409);
  assert.equal((await closeIncident(fakeDb([], []).db, 3, "k")).status, 404);
});
