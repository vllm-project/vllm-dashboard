import assert from "node:assert/strict";
import test from "node:test";
import { cleanCode, describeFactor, humanizeTag, parseSeverityDetail } from "./triage-factors";

const D = (factor: string, detail?: string | null, points = 1) => describeFactor(factor, detail, points);

test("severity: every flag, with the multipliers in words", () => {
  assert.deepEqual(D("severity.serving_broken", "50 base; model tier1 x1; hw tier1 x1; config default x1.15", 57), {
    category: "severity",
    title: "Serving is broken",
    detail: "50 pts × 1.15 (popular model, top-tier GPU, default settings)",
  });
  assert.deepEqual(D("severity.wrong_output", "42 base; model tier2 x0.8; hw tier2 x0.8; config exotic x0.55; pr x0.5", 7), {
    category: "severity",
    title: "Wrong output",
    detail: "42 pts × 0.18 (common model, common hardware, unusual settings, half weight for a PR)",
  });
  assert.equal(D("severity.crash", "36 base; model unknown x0.75; hw other x0.55; config unknown x0.9").detail,
    "36 pts × 0.37 (model unknown, niche hardware, settings unclear)");
  assert.equal(D("severity.crash").title, "Crashes");
  assert.equal(D("severity.hang").title, "Hangs");
  assert.equal(D("severity.memory_regression").title, "Uses more memory than before");
  assert.deepEqual(D("severity.security", "50 base", 50), {
    category: "severity",
    title: "Security problem",
    detail: "50 pts, not scaled by model or GPU",
  });
  const perf = D("severity.perf_regression", "25% slower; 22.5 base; model tier1 x1; hw tier1 x1; config default x1.15");
  assert.equal(perf.title, "Speed regression (25% slower)");
  assert.equal(perf.detail, "22.5 pts × 1.15 (popular model, top-tier GPU, default settings)");
  // A multiplier of exactly 1 isn't shown.
  assert.equal(D("severity.hang", "32 base; model tier1 x1; hw tier1 x1; config default x1").detail,
    "32 pts (popular model, top-tier GPU, default settings)");
});

test("type: every kind of item", () => {
  const titles: Record<string, string> = {
    regression: "Regression: it used to work",
    perf_regression: "Speed regression",
    bug: "Bug",
    ci: "CI problem",
    performance: "Performance",
    feature: "Feature request",
    spam: "Spam",
    question: "Question",
    usage: "Usage question",
    docs: "Docs",
    refactor: "Refactor",
    other: "Other",
  };
  for (const [code, title] of Object.entries(titles)) {
    assert.equal(D(`type.${code}`).title, title, code);
  }
  assert.equal(D("type.regression", null, 12).category, "severity");
  assert.equal(D("type.spam", null, -100).category, "penalty");
});

test("popularity, recency, evidence, community", () => {
  assert.deepEqual(D("popularity.model.tier1", "qwen3.5-122b", 6), {
    category: "reach",
    title: "Popular model (top tier): qwen3.5-122b",
    detail: null,
  });
  assert.equal(D("popularity.model.tier2", "phi-4").title, "Common model: phi-4");
  assert.equal(D("popularity.model.other").title, "Niche model");
  assert.equal(D("popularity.hardware.tier1", "B200").title, "Top-tier GPU: B200");
  assert.equal(D("popularity.hardware.tier2", "A100").title, "Common hardware: A100");
  assert.equal(D("popularity.hardware.other", "RTX").title, "Niche hardware: RTX");
  assert.deepEqual(D("recency.affects_latest_release", "0.27.1", 10), {
    category: "recency",
    title: "Affects the latest release (0.27.1)",
    detail: null,
  });
  assert.equal(D("recency.affects_main").title, "Affects main (nightly)");
  assert.equal(D("evidence.has_repro", null, 4).title, "Has steps to reproduce");
  assert.equal(D("evidence.has_repro", null, 4).category, "evidence");
  assert.deepEqual(D("evidence.low_confidence", null, -6), {
    category: "penalty",
    title: "The LLM wasn't sure about this read",
    detail: null,
  });
  assert.deepEqual(D("social", "12 reactions, 7 comments", 9), {
    category: "community",
    title: "Community interest: 12 reactions, 7 comments",
    detail: null,
  });
});

test("PR signals", () => {
  assert.deepEqual(D("pr.fixes_issue", "#61201 scored 83", 50), {
    category: "pr",
    title: "Fixes #61201, an issue that scored 83",
    detail: null,
  });
  assert.equal(D("pr.hot_path").title, "Touches code on every request");
  assert.equal(D("pr.has_tests").title, "Includes tests");
  assert.equal(D("pr.size.xs").title, "Tiny change");
  assert.equal(D("pr.size.s").title, "Small change");
  assert.equal(D("pr.size.m").title, "Medium-sized change");
  assert.equal(D("pr.size.l", null, -2).title, "Large change");
  assert.equal(D("pr.size.xl", null, -4).title, "Very large change");
  assert.equal(D("pr.size.xl", null, -4).category, "penalty");
  assert.deepEqual(D("pr.low_effort", null, -25), { category: "penalty", title: "Looks low-effort", detail: null });
  assert.equal(D("pr.draft", null, -15).title, "Draft PR");
});

test("slop, floor, pending, and unknown codes", () => {
  assert.deepEqual(D("slop", "generic_ai_description, no_testing", -20), {
    category: "penalty",
    title: "Low-quality signals: generic AI-written description, no testing",
    detail: null,
  });
  assert.deepEqual(D("floor", null, 40), { category: "floor", title: "Score can't go below 0", detail: null });
  assert.equal(D("pending_extraction").title, "Waiting for the LLM to read it");
  assert.deepEqual(D("brand_new.factor_code", "x", 3), { category: "other", title: "Brand new factor code", detail: "x" });
  assert.equal(D("brand_new.thing", null, -3).category, "penalty");
});

test("helpers", () => {
  assert.equal(humanizeTag("unrelated_changes"), "unrelated changes");
  assert.equal(humanizeTag("copied-from_ai"), "copied from AI");
  assert.equal(cleanCode("severity.some_flag"), "Severity some flag");
  assert.equal(cleanCode(""), "Unknown factor");
  assert.deepEqual(parseSeverityDetail("50 base; pr x0.5"), {
    slower: null,
    base: 50,
    multiplier: 0.5,
    words: ["half weight for a PR"],
  });
  assert.deepEqual(parseSeverityDetail(null), { slower: null, base: null, multiplier: 1, words: [] });
});
