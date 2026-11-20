import assert from "node:assert/strict";
import test from "node:test";
import type { TriageCi } from "./triage-ci";
import { nestGroups, rowOrder } from "./triage-groups";
import {
  activityNote,
  cleanupReasons,
  contextText,
  fixLabelText,
  fixTargets,
  listBlocks,
  impactBadge,
  fixPrStatus,
  kindHeading,
  kindTag,
  prEffortText,
  priorityCell,
  linkText,
  listRows,
  rowCiChip,
  scoreParts,
  unownedHint,
  worstSymptom,
} from "./triage-rows";
import type { TriageLinkedItem, TriageQueueItem } from "./triage-types";

const ci = (overrides: Partial<TriageCi>): TriageCi => ({
  head_sha: "abc",
  state: "passed",
  build_number: 1,
  build_url: null,
  build_state: null,
  jobs_total: 10,
  jobs_passed: 10,
  jobs_running: 0,
  jobs_failed: 0,
  jobs_failed_on_main: 0,
  jobs_failed_recent_on_main: 0,
  jobs_failed_pr_only: 0,
  main_known: true,
  failed_jobs: [],
  checked_at: null,
  ...overrides,
});

const link = (n: number, kind: "issue" | "pr" = "issue"): TriageLinkedItem => ({
  itemKey: `vllm-project/vllm#${n}`,
  number: n,
  kind,
  title: `t${n}`,
  state: "open",
  htmlUrl: `https://github.com/vllm-project/vllm/issues/${n}`,
  score: 50,
  band: "route",
  owner: null,
});

const item = (n: number, overrides: Partial<TriageQueueItem> = {}): TriageQueueItem => ({
  itemKey: `vllm-project/vllm#${n}`,
  repo: "vllm-project/vllm",
  number: n,
  kind: "issue",
  title: `item ${n}`,
  htmlUrl: `https://github.com/vllm-project/vllm/issues/${n}`,
  author: "a",
  state: "open",
  draft: false,
  ghCreatedAt: "2026-11-20T00:00:00Z",
  ghUpdatedAt: "2026-11-20T00:00:00Z",
  score: 50,
  band: "route",
  summary: null,
  type: "bug",
  areas: [],
  models: [],
  hardware: [],
  serving: [],
  severity: null,
  assignments: [],
  fixes: [],
  fixedBy: [],
  ...overrides,
});

test("one impact badge: the single worst symptom, the rest in its tooltip", () => {
  const all = { serving_broken: true, crash: true, wrong_output: true, hang: true };
  assert.equal(worstSymptom({ severity: all, type: "regression" })!.flag.key, "serving_broken");
  assert.equal(worstSymptom({ severity: { hang: true, crash: true } })!.flag.key, "crash");
  assert.equal(worstSymptom({ severity: { hang: true, wrong_output: true } })!.flag.key, "wrong_output");
  assert.equal(worstSymptom({ severity: { hang: true }, type: "regression" })!.flag.key, "hang");
  assert.equal(worstSymptom({ type: "regression" })!.flag.key, "regression");
  assert.equal(worstSymptom({ severity: { perf_regression_pct: -20, memory_regression: true } })!.flag.key, "perf");
  assert.equal(worstSymptom({ severity: {} }), null);
  // The type alone ("bug") is never a badge.
  assert.equal(impactBadge(item(1, { type: "bug" })), null);
  const badge = impactBadge(item(1, { severity: { crash: true, hang: true }, type: "regression" }))!;
  assert.equal(badge.label, "crash");
  assert.equal(badge.title, "crash; also hang, regression");
});

test("CI only when actionable", () => {
  assert.equal(rowCiChip(null), null);
  assert.equal(rowCiChip(ci({ state: "not_started", jobs_passed: 0 })), null);
  assert.equal(rowCiChip(ci({ state: "canceled" })), null);
  assert.deepEqual(
    [rowCiChip(ci({}))!.label, rowCiChip(ci({}))!.tone],
    ["CI ✓", "pass"],
  );
  const failed = rowCiChip(ci({ state: "failed", jobs_failed: 2, jobs_failed_pr_only: 2 }))!;
  assert.deepEqual([failed.label, failed.tone], ["2 CI failed", "fail"]);
  const mainOnly = rowCiChip(ci({ state: "failed", jobs_failed: 3, jobs_failed_pr_only: 0 }))!;
  assert.deepEqual([mainOnly.label, mainOnly.tone], ["3 CI failed (main)", "main"]);
  const running = rowCiChip(ci({ state: "running", jobs_running: 4 }))!;
  assert.deepEqual([running.label, running.tone], ["CI running", "running"]);
  const runningFailed = rowCiChip(ci({ state: "running", jobs_failed: 1, jobs_failed_pr_only: 1 }))!;
  assert.deepEqual([runningFailed.label, runningFailed.tone], ["1 CI failed", "fail"]);
  assert.match(failed.title, /^CI: /);
});

test("context is one plain line: hardware · model · area, then +N", () => {
  const line = contextText({ hardware: ["CPU_x86"], models: ["DeepSeek-V4-Flash"], areas: ["cpu"] });
  assert.deepEqual(line, { text: "CPU x86 · DeepSeek-V4-Flash · cpu", more: 0, hidden: [] });
  const long = contextText({ hardware: ["B200", "H100"], models: ["Qwen3-235B"], areas: ["moe", "kv_cache"] });
  assert.equal(long.text, "B200 · H100 · Qwen3-235B");
  assert.equal(long.more, 2);
  assert.deepEqual(long.hidden, ["moe", "kv cache"]);
  assert.equal(contextText({ hardware: [], models: [], areas: ["moe", "MoE"] }).text, "moe");
  assert.equal(contextText({ hardware: [], models: [], areas: [] }).text, "");
});

test("kind tag: ISSUE vs outlined PR, and a fix PR names its issues", () => {
  assert.deepEqual(kindTag({ kind: "issue" }), { word: "Issue", style: "issue", fixFor: null, label: "Issue" });
  assert.deepEqual(kindTag({ kind: "pr" }), { word: "PR", style: "pr", fixFor: null, label: "Pull request" });
  const fix = kindTag({ kind: "pr" }, [{ number: 65364 }]);
  assert.equal(fix.fixFor, "fix for #65364");
  assert.equal(fix.label, "Pull request, fix for #65364");
  assert.equal(kindTag({ kind: "pr" }, [{ number: 1 }, { number: 2 }]).fixFor, "fix for #1, #2");
  // An issue never reads as a fix, even if handed targets.
  assert.equal(kindTag({ kind: "issue" }, [{ number: 1 }]).fixFor, null);
  assert.equal(kindHeading("issue", 65364), "Issue #65364");
  assert.equal(kindHeading("pr", "65365"), "Pull request #65365");
});

test("one score per card: the issue row only, with the group band when a fix PR is more urgent", () => {
  // Standalone rows keep their own band and score.
  assert.deepEqual(priorityCell({ band: "route", score: 58 }), { show: true, band: "route", score: 58, tooltip: null });
  // Same band: the issue's own pill and score, no tooltip.
  assert.deepEqual(
    priorityCell({ band: "page", score: 79 }, { band: "page", lead: true, memberScores: [105] }),
    { show: true, band: "page", score: 79, tooltip: null },
  );
  // P1 issue + P0 fix PR: the group's P0 pill with the issue's own points, explained.
  assert.deepEqual(
    priorityCell({ band: "route", score: 55 }, { band: "page", lead: true, memberScores: [75] }),
    { show: true, band: "page", score: 55, tooltip: "Group priority; this issue scores 55, its fix PR 75" },
  );
  assert.equal(
    priorityCell({ band: "route", score: 55 }, { band: "page", lead: true, memberScores: [75, null] }).tooltip,
    "Group priority; this issue scores 55, its fix PRs 75, —",
  );
  // Fix PR rows in a card show no pill and no points.
  assert.deepEqual(priorityCell({ band: "page", score: 105 }, { band: "page", lead: false, memberScores: [] }).show, false);
});

test("a fix PR's line 2 is what's actionable: CI when informative, and whose move", () => {
  const base = { ci: null, waitingOn: null, draft: false, state: "open" } as const;
  assert.deepEqual(fixPrStatus(base), { ci: null, move: null });
  assert.deepEqual(fixPrStatus({ ...base, waitingOn: "reviewer" }).move, { text: "ready for review", tone: "ready" });
  assert.deepEqual(fixPrStatus({ ...base, waitingOn: "author" }).move, { text: "waiting on author", tone: "muted" });
  assert.deepEqual(fixPrStatus({ ...base, draft: true, waitingOn: "reviewer" }).move, { text: "draft", tone: "muted" });
  assert.deepEqual(fixPrStatus({ ...base, state: "merged" }).move, { text: "merged", tone: "muted" });
  assert.equal(fixPrStatus({ ...base, ci: ci({ state: "failed", jobs_failed: 2, jobs_failed_pr_only: 2 }) }).ci!.label, "2 CI failed");
  assert.equal(fixPrStatus({ ...base, ci: ci({}) }).ci!.label, "CI ✓");
  assert.equal(fixPrStatus({ ...base, ci: ci({ state: "not_started" }) }).ci, null);
});

test("score reads as points, uncapped", () => {
  assert.deepEqual(scoreParts(79), { value: "79", unit: "pts" });
  assert.deepEqual(scoreParts(105), { value: "105", unit: "pts" });
  assert.deepEqual(scoreParts(42.6), { value: "43", unit: "pts" });
  assert.deepEqual(scoreParts(null), { value: "—", unit: "" });
});

test("groups: every row keeps its own place; fix PRs nest only in the item column, in j/k order", () => {
  const issue = item(65364, { score: 79, band: "page", fixedBy: [link(65365, "pr")] });
  const fix = item(65365, { kind: "pr", score: 105, band: "page", fixes: [link(65364)] });
  const fix2 = item(65366, { kind: "pr", score: 40, band: "route", fixes: [link(65364)] });
  const lone = item(65664, { kind: "pr", score: 60, band: "route", fixes: [link(65568)] });
  const rows = listRows(nestGroups([issue, lone, fix, fix2]));
  assert.deepEqual(
    rows.map((row) => [row.item.number, row.nested, row.connectsDown]),
    [
      [65364, false, true],
      [65365, true, true],
      [65366, true, false],
      [65664, false, false],
    ],
  );
  // Each row keeps its own priority and score (no merged cell).
  assert.deepEqual(rows.map((row) => [row.item.band, row.item.score]), [["page", 79], ["page", 105], ["route", 40], ["route", 60]]);
  // j/k walks the same order the rows are drawn.
  assert.deepEqual(rowOrder(nestGroups([issue, lone, fix, fix2])), rows.map((row) => row.item.itemKey));
  // "Fixes #N" only for links not on screen.
  assert.equal(linkText(rows[1].item, rows[1].shownLinks), null);
  assert.equal(linkText(rows[0].item, rows[0].shownLinks), null);
  const fixes = linkText(rows[3].item, rows[3].shownLinks)!;
  assert.deepEqual([fixes.verb, fixes.links.map((l) => l.number)], ["Fixes", [65568]]);
});

test("group cards: issue + fix PRs become one block; standalone items stay rows", () => {
  const issue = item(68705, { score: 64, band: "route", fixedBy: [link(68822, "pr")] });
  const fix = item(68822, { kind: "pr", score: 101, band: "page", fixes: [link(68705)] });
  const issue2 = item(67454, { score: 75, band: "page", fixedBy: [link(67460, "pr"), link(67461, "pr")] });
  const fixA = item(67460, { kind: "pr", score: 72, band: "page", fixes: [link(67454), link(67401)] });
  const fixB = item(67461, { kind: "pr", score: 70, band: "page", fixes: [link(67454)] });
  const lonePr = item(66920, { kind: "pr", score: 58, band: "route" });
  const loneIssue = item(64584, { score: 52, band: "route" });
  const nested = nestGroups([fix, issue, issue2, fixA, fixB, lonePr, loneIssue]);
  const blocks = listBlocks(nested);
  assert.deepEqual(blocks.map((b) => b.kind), ["group", "group", "single", "single"]);
  const [mixed, pair] = blocks as Extract<(typeof blocks)[number], { kind: "group" }>[];
  // One stripe per card: the most urgent member's band (P0 fix PR under a P1 issue).
  assert.equal(mixed.band, "page");
  assert.equal(mixed.label, "Issue #68705 and its fix PR #68822");
  assert.equal(pair.label, "Issue #67454 and its fix PRs #67460 and #67461");
  // Members keep their own priority and score.
  assert.deepEqual(mixed.rows.map((r) => [r.item.band, r.item.score, r.nested]), [["route", 64, false], ["page", 101, true]]);
  // Card rows plus standalone rows, in order, equal the j/k order.
  const drawn = blocks.flatMap((b) => (b.kind === "group" ? b.rows : [b.row]).map((r) => r.item.itemKey));
  assert.deepEqual(drawn, rowOrder(nested));
});

test("a fix PR's label names its issues, the one it sits under first", () => {
  const fixA = item(67460, { kind: "pr", fixes: [link(67401), link(67454)] });
  const targets = fixTargets(fixA, "vllm-project/vllm#67454", 67454);
  assert.deepEqual(targets.map((t) => t.number), [67454, 67401]);
  assert.equal(fixLabelText(targets), "PR · fix for #67454, #67401");
  assert.equal(fixLabelText(fixTargets(item(65365, { kind: "pr", fixes: [link(65364)] }), "vllm-project/vllm#65364", 65364)), "PR · fix for #65364");
});

test("cleanupReasons explains competing PRs, low effort, and slop signals", () => {
  assert.deepEqual(cleanupReasons(null), []);
  const reasons = cleanupReasons({
    lowEffort: true,
    slopSignals: ["ai_boilerplate", "no_tests"],
    competesWith: [
      {
        issueNumber: 68833,
        prs: [{ itemKey: "vllm-project/vllm#68924", number: 68924, htmlUrl: "https://github.com/vllm-project/vllm/pull/68924" }],
      },
    ],
  });
  assert.equal(reasons.length, 3);
  assert.equal(reasons[0].label, "Competes on #68833:");
  assert.deepEqual(reasons[0].peers?.map((p) => p.number), [68924]);
  assert.equal(reasons[1].label, "Low effort");
  assert.equal(reasons[2].label, "Slop: AI boilerplate +1");
  assert.match(reasons[2].title, /no tests/);
});

test("prEffortText summarizes PR size, tests, and author trust cleanly", () => {
  assert.equal(prEffortText({ kind: "issue", prSize: "s", hasTests: true }), null);
  assert.deepEqual(prEffortText({ kind: "pr", prSize: "s", hasTests: true, isMaintainer: true }), {
    text: "small PR · has tests · by a maintainer",
    title: "Small PR. Size by lines changed: tiny <10, small <50, medium <250, large <1,000, very large 1,000+\nThe diff adds or changes tests\nThe author is a vLLM maintainer",
  });
  assert.deepEqual(prEffortText({ kind: "pr", prSize: "xl", hasTests: false, firstTime: true }), {
    text: "very large PR · no tests · first-time contributor",
    title: "Very large PR. Size by lines changed: tiny <10, small <50, medium <250, large <1,000, very large 1,000+\nNo tests in the diff (shown for medium or larger PRs)\nThe author's first PR to vLLM",
  });
  assert.equal(prEffortText({ kind: "pr", prSize: "s", hasTests: false })?.text, "small PR");
});

test("unownedHint distills verbose router summaries into 2-word hints", () => {
  assert.equal(unownedHint(null), null);
  assert.equal(unownedHint("Nobody is a match: everyone judged is low or none.")?.label, "no match");
  assert.equal(unownedHint("Its only match can't take it right now.")?.label, "at capacity");
  assert.equal(unownedHint("Assigned on GitHub to alice, who is not in the list.")?.label, "assigned on GitHub");
});

test("activityNote flags fresh updates on older items only", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  // Old item updated 2h ago → show activity note
  assert.equal(activityNote("2026-11-10T12:00:00Z", "2026-11-20T10:00:00Z", now)?.label, "updated 2h ago");
  // Brand new item updated 1h ago → redundant, omit
  assert.equal(activityNote("2026-11-20T09:00:00Z", "2026-11-20T11:00:00Z", now), null);
  // Old item not updated recently → omit
  assert.equal(activityNote("2026-11-10T12:00:00Z", "2026-11-15T12:00:00Z", now), null);
});
