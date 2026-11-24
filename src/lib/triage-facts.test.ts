import assert from "node:assert/strict";
import test from "node:test";
import { llmFacts, visibleFacts } from "./triage-facts";

const keys = (facts: { key: string }[]) => facts.map((fact) => fact.key);

test("only positive / non-empty facts are visible by default", () => {
  const facts = llmFacts({
    type: "bug",
    models: [{ name: "Qwen3-235B" }, {}],
    hardware: [],
    serving: ["tp"],
    severity: { crash: true, hang: false, serving_broken: false, perf_regression_pct: null, security: false },
    default_config: null,
    versions: { good: null, bad: null, affects_main: true, affects_latest_release: false },
    has_repro: false,
    slop_signals: [],
    notes: "  ",
    confidence: 0.8,
  });
  assert.deepEqual(keys(visibleFacts(facts, false)), ["type", "models", "serving", "crash", "versions"]);
  const versions = facts.find((fact) => fact.key === "versions")!;
  assert.equal(versions.text, "affects main");
  assert.deepEqual(facts.find((fact) => fact.key === "models")!.chips!.values, ["Qwen3-235B"]);
});

test("show all keeps every field, with its no / none / not stated", () => {
  const facts = llmFacts({ type: "question" });
  const all = visibleFacts(facts, true);
  assert.equal(all.length, facts.length);
  assert.ok(all.length > 10);
  assert.equal(all.find((fact) => fact.key === "crash")!.text, "unknown");
  assert.equal(all.find((fact) => fact.key === "slop_signals")!.text, "none");
  assert.match(all.find((fact) => fact.key === "versions")!.text!, /^not stated/);
  assert.deepEqual(keys(visibleFacts(facts, false)), ["type"]);
});

test("nothing positive: no visible facts", () => {
  assert.deepEqual(visibleFacts(llmFacts({}), false), []);
  assert.deepEqual(visibleFacts(llmFacts(null), false), []);
  assert.deepEqual(
    visibleFacts(llmFacts({ severity: { crash: false, wrong_output: false }, has_repro: false, hardware: [] }), false),
    [],
  );
});

test("PR facts: only the positive parts, the full line behind show all", () => {
  const withTests = llmFacts({ pr: { fixes_issues: [12], has_tests: true, hot_path: false } }).find((f) => f.key === "pr")!;
  assert.equal(withTests.present, true);
  assert.equal(withTests.text, "fixes #12 · has tests");
  const bare = llmFacts({ pr: { fixes_issues: [], has_tests: false } }).find((f) => f.key === "pr")!;
  assert.equal(bare.present, false);
  assert.equal(bare.fullText, "no linked issue · no tests");
  const mixed = llmFacts({ pr: { size: "s", has_tests: false, low_effort: true } }).find((f) => f.key === "pr")!;
  assert.equal(mixed.text, "small PR · looks low-effort");
  assert.equal(mixed.fullText, "no linked issue · small PR · no tests · looks low-effort");
});

test("a slowdown and slop signals count as positive", () => {
  const facts = llmFacts({ severity: { perf_regression_pct: -12 }, slop_signals: ["no_testing"] });
  const shown = visibleFacts(facts, false);
  assert.deepEqual(keys(shown), ["perf_regression_pct", "slop_signals"]);
  assert.equal(shown[0].text, "12% slower");
});
