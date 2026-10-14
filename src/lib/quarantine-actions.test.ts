import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "./quarantine-actions";
import {
  closeIncident,
  confirmIncident,
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

test("resolving moves an open, applied or held quarantine to resolving", async () => {
  const { db, queries } = fakeDb([{ alert_id: "7" }]);
  const result = await resolveQuarantine(db, "h200-1", "oncall", "rebooted");
  assert.deepEqual(result, { status: 200, body: { ok: true, alertId: 7 } });
  assert.equal(queries.length, 1);
  assert.match(queries[0], /'stage', 'resolving'/);
  assert.match(queries[0], /alert_type = 'quarantine'/);
  assert.match(queries[0], /status = 'open'/);
  assert.match(queries[0], /IN \('held', 'quarantining', 'quarantined'\)/);
});

test("resolving a dry-run quarantine is a 409 that says nothing was applied", async () => {
  const result = await resolveQuarantine(fakeDb([], [{ stage: "would" }]).db, "h", "k", "r");
  assert.equal(result.status, 409);
  assert.match(String(result.body.error), /dry-run/);
});

test("resolving twice, or after the host is back, is a 409", async () => {
  for (const stage of ["resolving", "resolved"]) {
    const { db } = fakeDb([], [{ stage }]);
    assert.equal((await resolveQuarantine(db, "h", "k", "r")).status, 409, stage);
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
