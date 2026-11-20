import assert from "node:assert/strict";
import test from "node:test";
import type { TriageCi } from "./triage-ci";
import { nestGroups, rowOrder } from "./triage-groups";
import {
  contextText,
  impactBadge,
  kindLabel,
  linkText,
  listRows,
  rowCiChip,
  scoreParts,
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

test("line 1 kind label", () => {
  assert.equal(kindLabel({ kind: "issue" }, false), "Issue");
  assert.equal(kindLabel({ kind: "pr" }, false), "PR");
  assert.equal(kindLabel({ kind: "pr" }, true), "Fix PR");
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
