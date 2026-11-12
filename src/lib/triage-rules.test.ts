import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_RULES,
  fnmatchToRegExp,
  matchRules,
  normalizeRules,
  validateMaintainerSettings,
  type RuleMatchInput,
} from "./triage-rules";
import type { TriageRules } from "./triage-types";

function rules(patch: Partial<TriageRules>): TriageRules {
  return { ...EMPTY_RULES, ...patch, exclude: { ...EMPTY_RULES.exclude, ...(patch.exclude ?? {}) } };
}

const ITEM: RuleMatchInput = {
  title: "DeepSeek-V3 crashes with expert parallel on B200",
  facets: {
    type: "bug",
    summary: "EP all2all hangs",
    areas: ["moe"],
    hardware: ["B200"],
    models: [{ name: "DeepSeek-V3", family: "deepseek" }],
  },
  prepass: { areas: ["kernels"], hardware_hints: ["GB200"], model_hints: ["Kimi-K2"] },
  files: [{ path: "vllm/model_executor/layers/fused_moe/layer.py" }, { path: "csrc/moe/topk.cu" }],
};

test("fnmatch semantics: * crosses /, ? is one char, [] classes", () => {
  assert.ok(fnmatchToRegExp("vllm/*").test("vllm/a/b/c.py"));
  assert.ok(fnmatchToRegExp("a?c").test("abc"));
  assert.ok(!fnmatchToRegExp("a?c").test("ac"));
  assert.ok(fnmatchToRegExp("[ab]x").test("bx"));
  assert.ok(!fnmatchToRegExp("[!ab]x").test("ax"));
  assert.ok(fnmatchToRegExp("a.b").test("a.b"));
  assert.ok(!fnmatchToRegExp("a.b").test("axb"));
  assert.ok(fnmatchToRegExp("[x").test("[x"));
});

test("every criterion reports in order: areas, hardware, models, paths, keywords", () => {
  const result = matchRules(
    rules({
      areas: ["kernels", "moe", "lora"],
      hardware: ["GB200", "B200"],
      models: ["deepseek-*", "kimi*", "llama*"],
      paths: ["vllm/model_executor/layers/fused_moe/**", "csrc/moe", "docs/*"],
      keywords: ["Expert Parallel", "lora"],
    }),
    ITEM,
  );
  assert.deepEqual(result?.matched, [
    "area:kernels",
    "area:moe",
    "hardware:GB200",
    "hardware:B200",
    "model:deepseek-*",
    "model:kimi*",
    "path:vllm/model_executor/layers/fused_moe/**",
    "path:csrc/moe",
    "keyword:Expert Parallel",
  ]);
});

test("model globs are case-insensitive and also see the family", () => {
  assert.deepEqual(matchRules(rules({ models: ["DEEPSEEK"] }), ITEM)?.matched, ["model:DEEPSEEK"]);
});

test("paths are case-sensitive", () => {
  assert.equal(matchRules(rules({ paths: ["CSRC/*"] }), ITEM), null);
});

test("types is a filter, not a criterion", () => {
  assert.equal(matchRules(rules({ types: ["bug"] }), ITEM), null);
  assert.equal(matchRules(rules({ types: ["feature"], areas: ["moe"] }), ITEM), null);
  assert.deepEqual(matchRules(rules({ types: ["bug"], areas: ["moe"] }), ITEM)?.matched, ["area:moe"]);
  const untyped = { ...ITEM, facets: { ...ITEM.facets, type: undefined } };
  assert.equal(matchRules(rules({ types: ["bug"], areas: ["moe"] }), untyped), null);
});

test("any exclude vetoes the match", () => {
  assert.equal(matchRules(rules({ areas: ["moe"], exclude: { types: ["bug"], areas: [], hardware: [] } }), ITEM), null);
  assert.equal(matchRules(rules({ areas: ["moe"], exclude: { types: [], areas: ["kernels"], hardware: [] } }), ITEM), null);
  assert.equal(matchRules(rules({ areas: ["moe"], exclude: { types: [], areas: [], hardware: ["GB200"] } }), ITEM), null);
});

test("empty rules and missing facets never match", () => {
  assert.equal(matchRules(EMPTY_RULES, ITEM), null);
  assert.equal(
    matchRules(rules({ areas: ["moe"] }), { title: "x", facets: null, prepass: null, files: [] }),
    null,
  );
});

test("normalizeRules tolerates junk", () => {
  assert.deepEqual(normalizeRules({ areas: ["moe", 3], exclude: "x" }), {
    ...EMPTY_RULES,
    areas: ["moe"],
  });
  assert.deepEqual(normalizeRules(null), EMPTY_RULES);
});

test("settings validation accepts a full body and rejects bad values", () => {
  const good = validateMaintainerSettings({
    rules: { areas: ["moe", "moe"], hardware: ["B200"], models: [" DeepSeek-* "], exclude: { types: ["docs"] } },
    minScore: 50,
    capacityPerWeek: 8,
    notifyMode: "immediate",
    slackUserId: "U0123ABCD",
    away: [{ start: "2026-12-20", end: "2027-01-03" }],
  });
  assert.ok(good.ok);
  if (good.ok) {
    assert.deepEqual(good.value.rules.areas, ["moe"]);
    assert.deepEqual(good.value.rules.models, ["DeepSeek-*"]);
    assert.deepEqual(good.value.rules.exclude.types, ["docs"]);
  }
  for (const bad of [
    { rules: { areas: ["nope"] } },
    { rules: { hardware: ["H9000"] } },
    { minScore: -1 },
    { capacityPerWeek: 1.5 },
    { notifyMode: "sms" },
    { slackUserId: "bob" },
    { away: [{ start: "2027-01-03", end: "2026-12-20" }] },
    { away: [{ start: "tomorrow", end: "2026-12-20" }] },
    "string",
  ]) {
    assert.equal(validateMaintainerSettings(bad).ok, false, JSON.stringify(bad));
  }
});
