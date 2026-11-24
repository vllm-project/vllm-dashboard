import assert from "node:assert/strict";
import test from "node:test";
import {
  inPlateView, matchesPlateFilters, overdueAck, parsePlateFilters,
  plateFilterParams, plateNextAction, plateStatus, plateStatusLabel, readyForMerge, readyForReview,
  type PlateEntryLike,
} from "./triage-my-list";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const entry = (overrides: Partial<PlateEntryLike> = {}): PlateEntryLike => ({
  kind: "pr", state: "open", draft: false, waitingOn: "reviewer",
  assignment: { status: "acked", role: "primary", assignedAt: "2026-11-16T12:00:00Z" },
  ...overrides,
});

test("accepting work does not hide acknowledged issues or reviewable PRs", () => {
  const issue = entry({ kind: "issue", waitingOn: null });
  assert.equal(plateNextAction(issue, NOW), "Follow up");
  assert.equal(inPlateView(issue, "attention"), true);
  assert.equal(plateNextAction(entry(), NOW), "Ready for review");
  assert.equal(inPlateView(entry(), "attention"), true);
  const unknown = entry({ waitingOn: null });
  assert.equal(plateNextAction(unknown, NOW), "Check PR status");
  assert.equal(inPlateView(unknown, "attention"), true);
});

test("acknowledgement comes first, then author-blocked work leaves Needs attention", () => {
  const blocked = entry({ waitingOn: "author", assignment: { status: "open" } });
  assert.equal(plateNextAction(blocked, NOW), "Needs your ack");
  assert.equal(inPlateView(blocked, "attention"), true);
  assert.equal(inPlateView(blocked, "waiting"), true);
  const accepted = { ...blocked, assignment: { status: "acked" } };
  assert.equal(plateNextAction(accepted, NOW), "Waiting on author");
  assert.equal(inPlateView(accepted, "attention"), false);
  assert.equal(inPlateView(accepted, "waiting"), true);
  assert.equal(inPlateView(entry({ draft: true }), "waiting"), true);
  assert.equal(inPlateView(entry({ state: "merged" }), "attention"), false);
});

test("approved PRs are never labelled ready for review and stale readiness is not ready to merge", () => {
  const approved = entry({ reviewDecision: "APPROVED", mergeReady: true, mergeCheckedAt: new Date(NOW - 1000).toISOString() });
  assert.equal(readyForReview(approved), false);
  assert.equal(inPlateView(approved, "review"), false);
  assert.equal(plateNextAction(approved, NOW), "Ready to merge");
  for (const override of [
    { mergeCheckedAt: new Date(NOW - 3600_000).toISOString() },
    { mergeCheckedAt: "invalid" }, { mergeCheckedAt: null }, { mergeReady: false },
    { draft: true }, { waitingOn: "author" as const }, { state: "merged" },
  ]) assert.equal(readyForMerge({ ...approved, ...override }, NOW), false);
  assert.equal(plateNextAction({ ...approved, mergeReady: false }, NOW), "Check PR status");
});

test("overdue means unacknowledged assignment older than three days, not issue age", () => {
  assert.equal(overdueAck(entry({ assignment: { status: "open", assignedAt: new Date(NOW - 3 * 86400_000 - 1).toISOString() } }), NOW), true);
  for (const assignment of [
    { status: "open", assignedAt: new Date(NOW - 3 * 86400_000).toISOString() },
    { status: "open", assignedAt: "invalid" },
    { status: "acked", assignedAt: "2026-10-01T00:00:00Z" },
  ]) assert.equal(overdueAck(entry({ assignment }), NOW), false);
});

test("old bookmarks map to visible filters and preserve their selection", () => {
  for (const [view, expected] of [
    ["needs-ack", { status: "open" }], ["acked", { status: "acked" }],
    ["review", { readiness: "review" }], ["issues", { kind: "issue" }],
  ] as const) {
    const filters = parsePlateFilters(new URLSearchParams({ view }));
    assert.equal(filters.view, "all");
    for (const [key, value] of Object.entries(expected)) assert.equal(filters[key as keyof typeof filters], value);
    assert.deepEqual(parsePlateFilters(plateFilterParams(filters, "repo#1")), filters);
    assert.equal(plateFilterParams(filters, "repo#1").get("item"), "repo#1");
  }
  assert.equal(parsePlateFilters(new URLSearchParams()).view, "attention");
  assert.equal(parsePlateFilters(new URLSearchParams("view=garbage&kind=no&role=no")).kind, null);
});

test("view counts and results apply the same role, type, and acknowledgement filters", () => {
  const filters = parsePlateFilters(new URLSearchParams("view=all&kind=pr&role=backup&status=open"));
  assert.equal(matchesPlateFilters(entry({ assignment: { status: "open", role: "backup" } }), filters, NOW), true);
  assert.equal(matchesPlateFilters(entry(), filters, NOW), false);
  assert.equal(matchesPlateFilters(entry({ kind: "issue", assignment: { status: "open", role: "backup" } }), filters, NOW), false);
});

test("status line: needs ack, overdue, backup, and the assigned age in the tooltip", () => {
  const fresh = entry({ assignment: { status: "open", role: "primary", assignedAt: "2026-11-19T12:00:00Z" } });
  const status = plateStatus(fresh, NOW);
  assert.equal(plateStatusLabel(status), "Needs your ack");
  assert.equal(status.title, "Assigned 24h ago");

  const late = plateStatus(entry({ assignment: { status: "open", role: "backup", assignedAt: "2026-11-16T12:00:00Z" } }), NOW);
  assert.equal(plateStatusLabel(late), "Needs your ack · ack overdue · Backup");
  assert.equal(late.text, "Needs your ack");
  assert.match(late.title, /^Assigned 4d ago/);
});

test("status line: acked items say what's next, never 'Primary'", () => {
  const issue = plateStatus(entry({ kind: "issue", waitingOn: null }), NOW);
  assert.equal(plateStatusLabel(issue), "✓ Acked · follow up");
  assert.equal(plateStatusLabel(plateStatus(entry(), NOW)), "✓ Acked · ready for review");
  assert.equal(plateStatusLabel(plateStatus(entry({ waitingOn: "author" }), NOW)), "✓ Acked · waiting on author");
  const viaGithub = plateStatus(entry({ assignment: { status: "acked", role: "primary", assignedAt: "2026-11-16T12:00:00Z", reason: { acked_by: "github_comment" } } }), NOW);
  assert.match(viaGithub.title, /commented on GitHub/);
  assert.doesNotMatch(plateStatusLabel(viaGithub), /Primary/);
});

test("status line: closed assignments; drop and slop both read as hidden", () => {
  const closed = (status: string, reason: Record<string, unknown> = {}) =>
    plateStatusLabel(plateStatus(entry({ assignment: { status, role: "primary", reason } }), NOW));
  assert.equal(closed("done"), "Done");
  assert.equal(closed("done", { closed_by: "github", item_state: "merged" }), "Closed on GitHub (merged)");
  assert.equal(closed("dropped"), "Hidden for everyone");
  assert.equal(closed("slop"), "Hidden for everyone");
  assert.equal(closed("not_mine"), "Not mine");
});
