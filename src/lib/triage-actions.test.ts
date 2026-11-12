import assert from "node:assert/strict";
import test from "node:test";
import {
  parseActionRequest,
  planTriageAction,
  type ActionRequest,
  type AssignmentState,
} from "./triage-actions";

const ACTIVE = new Set(["alice", "bob", "carol"]);

function req(patch: Partial<ActionRequest>): ActionRequest {
  return { itemKey: "vllm-project/vllm#1", action: "ack", assignmentId: null, target: null, note: null, ...patch };
}

function assignment(patch: Partial<AssignmentState>): AssignmentState {
  return {
    id: 1,
    maintainer: "alice",
    role: "primary",
    status: "open",
    closedAt: null,
    assignedAt: "2026-11-10T00:00:00.000Z",
    ...patch,
  };
}

test("ack moves the actor's open assignment to acked", () => {
  const result = planTriageAction(req({ action: "ack" }), "alice", [assignment({})], ACTIVE);
  assert.deepEqual(result, {
    ok: true,
    plan: { assignmentId: 1, update: { id: 1, status: "acked", closedAt: "keep" }, insert: null },
  });
});

test("ack twice is a conflict", () => {
  const result = planTriageAction(req({ action: "ack" }), "alice", [assignment({ status: "acked" })], ACTIVE);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 409);
});

test("closing actions map to their statuses and close the row", () => {
  for (const [action, status] of [
    ["not_mine", "not_mine"],
    ["drop", "dropped"],
    ["slop", "slop"],
    ["done", "done"],
  ] as const) {
    const result = planTriageAction(req({ action }), "alice", [assignment({ status: "acked" })], ACTIVE);
    assert.ok(result.ok);
    assert.deepEqual(result.ok && result.plan.update, { id: 1, status, closedAt: "close" });
  }
});

test("someone else's assignment cannot be acted on", () => {
  const result = planTriageAction(req({ action: "done", assignmentId: 1 }), "bob", [assignment({})], ACTIVE);
  assert.equal(!result.ok && result.status, 403);
  const implicit = planTriageAction(req({ action: "done" }), "bob", [assignment({})], ACTIVE);
  assert.equal(!implicit.ok && implicit.status, 403);
});

test("ack on an unassigned item takes it as an acked primary", () => {
  const result = planTriageAction(req({ action: "ack" }), "bob", [], ACTIVE);
  assert.deepEqual(result, {
    ok: true,
    plan: { assignmentId: null, update: null, insert: { maintainer: "bob", role: "primary", status: "acked" } },
  });
  const taken = planTriageAction(req({ action: "ack" }), "bob", [assignment({})], ACTIVE);
  assert.equal(taken.ok, false);
});

test("reassign closes the current row and opens one for the target, same role", () => {
  const result = planTriageAction(
    req({ action: "reassign", target: "carol" }),
    "bob",
    [assignment({ role: "backup", id: 7 })],
    ACTIVE,
  );
  assert.deepEqual(result, {
    ok: true,
    plan: {
      assignmentId: 7,
      update: { id: 7, status: "reassigned", closedAt: "close" },
      insert: { maintainer: "carol", role: "backup", status: "open" },
    },
  });
});

test("reassign needs an active target different from the assignee", () => {
  assert.equal(planTriageAction(req({ action: "reassign", target: "zed" }), "alice", [assignment({})], ACTIVE).ok, false);
  assert.equal(planTriageAction(req({ action: "reassign", target: "Alice" }), "alice", [assignment({})], ACTIVE).ok, false);
});

test("reassign of an unassigned item creates a primary for the target", () => {
  const result = planTriageAction(req({ action: "reassign", target: "carol" }), "bob", [], ACTIVE);
  assert.ok(result.ok);
  assert.deepEqual(result.ok && result.plan.insert, { maintainer: "carol", role: "primary", status: "open" });
  assert.equal(result.ok && result.plan.update, null);
});

test("reopen restores the actor's latest closed row unless the role is taken", () => {
  const closed = [
    assignment({ id: 1, status: "not_mine", closedAt: "2026-11-01T00:00:00.000Z" }),
    assignment({ id: 2, status: "done", closedAt: "2026-11-05T00:00:00.000Z" }),
  ];
  const result = planTriageAction(req({ action: "reopen" }), "alice", closed, ACTIVE);
  assert.deepEqual(result.ok && result.plan.update, { id: 2, status: "open", closedAt: "reopen" });
  const blocked = planTriageAction(
    req({ action: "reopen" }),
    "alice",
    [...closed, assignment({ id: 3, maintainer: "bob" })],
    ACTIVE,
  );
  assert.equal(!blocked.ok && blocked.status, 409);
  assert.equal(planTriageAction(req({ action: "reopen" }), "bob", closed, ACTIVE).ok, false);
});

test("parseActionRequest validates shape", () => {
  assert.ok(parseActionRequest({ itemKey: "vllm-project/vllm#12", action: "ack" }).ok);
  assert.ok(parseActionRequest({ itemKey: "vllm-project/vllm#12", action: "reassign", target: "bob" }).ok);
  for (const bad of [
    { itemKey: "vllm#12", action: "ack" },
    { itemKey: "vllm-project/vllm#12", action: "close" },
    { itemKey: "vllm-project/vllm#12", action: "reassign" },
    { itemKey: "vllm-project/vllm#12", action: "ack", target: "bob" },
    { itemKey: "vllm-project/vllm#12", action: "ack", assignmentId: -1 },
    { itemKey: "vllm-project/vllm#12", action: "ack", note: "x".repeat(2001) },
    null,
  ]) {
    assert.equal(parseActionRequest(bad).ok, false, JSON.stringify(bad));
  }
});
