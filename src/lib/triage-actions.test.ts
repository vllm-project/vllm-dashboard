import assert from "node:assert/strict";
import test from "node:test";
import {
  UNDO_WINDOW_SECONDS,
  checkUndo,
  memberRequest,
  parseActionRequest,
  parseUndoRequest,
  planTriageAction,
  planUndo,
  type ActionRequest,
  type AssignmentState,
  type UndoActionRow,
  type UndoAssignmentState,
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

test("group follow-up: the same action on a fix PR held by the same person", () => {
  const issue = "vllm-project/vllm#65385";
  const pr = "vllm-project/vllm#67812";
  const prOpen = [assignment({ id: 7, maintainer: "Alice" })];
  for (const action of ["ack", "not_mine", "done"] as const) {
    const follow = memberRequest(req({ itemKey: issue, action }), "alice", pr, prOpen);
    assert.deepEqual(follow, { itemKey: pr, action, assignmentId: 7, target: null, note: "with #65385" });
    assert.equal(planTriageAction(follow!, "alice", prOpen, ACTIVE).ok, true);
  }
  // Reassign follows the person it was taken from to the same target.
  const moved = memberRequest(req({ itemKey: issue, action: "reassign", target: "bob", note: "on leave" }), "alice", pr, prOpen);
  assert.deepEqual(moved, { itemKey: pr, action: "reassign", assignmentId: 7, target: "bob", note: "with #65385: on leave" });
  assert.equal(planTriageAction(moved!, "carol", prOpen, ACTIVE).ok, true);
});

test("group follow-up skips what doesn't apply", () => {
  const issue = "vllm-project/vllm#65385";
  const pr = "vllm-project/vllm#67812";
  // Someone else holds the PR, it's closed, or already in that state.
  assert.equal(memberRequest(req({ itemKey: issue }), "alice", pr, [assignment({ maintainer: "bob" })]), null);
  assert.equal(memberRequest(req({ itemKey: issue }), "alice", pr, [assignment({ status: "done" })]), null);
  assert.equal(memberRequest(req({ itemKey: issue }), "alice", pr, [assignment({ status: "acked" })]), null);
  assert.equal(
    memberRequest(req({ itemKey: issue, action: "reassign", target: "bob" }), "alice", pr,
      [assignment({}), assignment({ id: 2, maintainer: "bob", role: "backup" })]),
    null,
  );
  // Drop, slop and reopen stay on the item clicked.
  for (const action of ["drop", "slop", "reopen"] as const) {
    assert.equal(memberRequest(req({ itemKey: issue, action }), "alice", pr, [assignment({})]), null);
  }
});

// --- undo --------------------------------------------------------------------

const undoRow = (overrides: Partial<UndoActionRow> = {}): UndoActionRow => ({
  id: 10,
  itemKey: "vllm-project/vllm#1",
  assignmentId: 1,
  actor: "Alice",
  action: "drop",
  target: null,
  source: "dashboard",
  ageSeconds: 3,
  ...overrides,
});

const undoAssignment = (overrides: Partial<UndoAssignmentState> = {}): UndoAssignmentState => ({
  id: 1,
  maintainer: "alice",
  role: "primary",
  status: "dropped",
  closedAt: "2026-11-20T00:00:00Z",
  assignedAt: "2026-11-19T00:00:00Z",
  assignedBy: "router",
  createdByAction: false,
  notifiedAt: null,
  wasAcked: false,
  ...overrides,
});

test("parseUndoRequest needs a positive integer actionId", () => {
  assert.deepEqual(parseUndoRequest({ actionId: 5 }), { ok: true, actionId: 5 });
  assert.deepEqual(parseUndoRequest({ actionId: "7" }), { ok: true, actionId: 7 });
  for (const body of [undefined, null, {}, { actionId: 0 }, { actionId: 1.5 }, { actionId: "x" }]) {
    assert.equal(parseUndoRequest(body).ok, false);
  }
});

test("checkUndo: own dashboard terminal action, within the window", () => {
  assert.ok(checkUndo("alice", undoRow()).ok);
  const fail = (row: UndoActionRow | undefined, login = "alice") => {
    const result = checkUndo(login, row);
    assert.equal(result.ok, false);
    return result.ok ? 0 : result.status;
  };
  assert.equal(fail(undefined), 404);
  assert.equal(fail(undoRow(), "mallory"), 403);
  assert.equal(fail(undoRow({ source: "slack" })), 403);
  assert.equal(fail(undoRow({ action: "ack" })), 400);
  assert.equal(fail(undoRow({ action: "reopen" })), 400);
  assert.equal(fail(undoRow({ ageSeconds: UNDO_WINDOW_SECONDS + 1 })), 409);
  assert.equal(fail(undoRow({ ageSeconds: Number.NaN })), 409);
  for (const action of ["not_mine", "drop", "slop", "done", "reassign"] as const) {
    assert.ok(checkUndo("ALICE", undoRow({ action })).ok, action);
  }
});

test("planUndo: drop/slop/done/not_mine reopen the assignment as it was", () => {
  assert.deepEqual(planUndo(undoRow(), [undoAssignment()], 0), {
    ok: true,
    value: [{ kind: "restore", assignmentId: 1, status: "open" }],
  });
  assert.deepEqual(
    planUndo(undoRow({ action: "done" }), [undoAssignment({ status: "done", wasAcked: true })], 0),
    { ok: true, value: [{ kind: "restore", assignmentId: 1, status: "acked" }] },
  );
  // Status moved on, someone acted since, or the role was refilled: refuse.
  assert.equal(planUndo(undoRow({ action: "slop" }), [undoAssignment()], 0).ok, false);
  assert.equal(planUndo(undoRow(), [undoAssignment()], 1).ok, false);
  const rerouted = planUndo(
    undoRow({ action: "not_mine" }),
    [undoAssignment({ status: "not_mine" }), undoAssignment({ id: 2, maintainer: "bob", status: "open" })],
    0,
  );
  assert.equal(rerouted.ok, false);
  assert.equal(planUndo(undoRow({ assignmentId: 99 }), [undoAssignment()], 0).ok, false);
});

test("planUndo: reassign deletes the new row and restores the old one", () => {
  const row = undoRow({ action: "reassign", target: "bob" });
  const old = undoAssignment({ status: "reassigned", wasAcked: true });
  const created = undoAssignment({ id: 2, maintainer: "bob", status: "open", assignedBy: "Alice", createdByAction: true, closedAt: null });
  assert.deepEqual(planUndo(row, [old, created], 0), {
    ok: true,
    value: [
      { kind: "delete", assignmentId: 2 },
      { kind: "restore", assignmentId: 1, status: "acked" },
    ],
  });
  assert.equal(planUndo(row, [old, { ...created, status: "acked" }], 0).ok, false);
  assert.equal(planUndo(row, [old, { ...created, notifiedAt: "2026-11-20T00:00:01Z" }], 0).ok, false);
  assert.equal(planUndo(row, [old], 0).ok, false);
});

test("planUndo: reassign of an unowned item just deletes the new row", () => {
  const row = undoRow({ action: "reassign", target: "bob", assignmentId: 2 });
  const created = undoAssignment({ id: 2, maintainer: "bob", status: "open", assignedBy: "Alice", createdByAction: true, closedAt: null });
  assert.deepEqual(planUndo(row, [created], 0), { ok: true, value: [{ kind: "delete", assignmentId: 2 }] });
});
