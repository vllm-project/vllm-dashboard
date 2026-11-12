import assert from "node:assert/strict";
import test from "node:test";
import yaml from "js-yaml";
import {
  EMPTY_RULES,
  maintainerFileCreateUrl,
  maintainerFileEditUrl,
  maintainerFilePath,
  maintainerFileYaml,
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

test("rules file: exact format, key order, quoting", () => {
  const text = maintainerFileYaml("gau-nernst", {
    slackUserId: "U0123456789",
    minScore: 45,
    capacityPerWeek: 8,
    notifyMode: "digest",
    away: [{ start: "2026-12-20", end: "2027-01-03" }],
    rules: {
      areas: ["moe", "kernels"],
      hardware: ["B200"],
      models: ["qwen4*", "kimi-k3*"],
      paths: ["vllm/models/qwen4_exp/**"],
      keywords: ["deepgemm"],
      types: ["bug", "regression"],
      exclude: { types: ["question"], areas: [], hardware: ["MI300X"] },
      natural_language: "free text",
    },
  });
  assert.equal(
    text,
    [
      "github_login: gau-nernst",
      "slack_user_id: U0123456789",
      "min_score: 45",
      "capacity_per_week: 8",
      "notify_mode: digest",
      "away:",
      "  - {start: 2026-12-20, end: 2027-01-03}",
      "rules:",
      "  areas: [moe, kernels]",
      "  hardware: [B200]",
      '  models: ["qwen4*", "kimi-k3*"]',
      '  paths: ["vllm/models/qwen4_exp/**"]',
      '  keywords: ["deepgemm"]',
      "  types: [bug, regression]",
      "  exclude: {types: [question], hardware: [MI300X]}",
      '  natural_language: "free text"',
      "",
    ].join("\n"),
  );
});

test("the coordinator's example file is reproduced exactly", () => {
  assert.equal(
    maintainerFileYaml("gau-nernst", {
      slackUserId: null,
      minScore: 40,
      capacityPerWeek: 8,
      notifyMode: "digest",
      away: [],
      rules: {
        ...EMPTY_RULES,
        models: ["qwen4*", "kimi-k3*"],
        paths: ["vllm/models/qwen4_exp/**"],
        keywords: ["deepgemm"],
        exclude: { types: ["question"], areas: [], hardware: ["MI300X"] },
      },
    }),
    `github_login: gau-nernst
min_score: 40
capacity_per_week: 8
notify_mode: digest
rules:
  models: ["qwen4*", "kimi-k3*"]
  paths: ["vllm/models/qwen4_exp/**"]
  keywords: ["deepgemm"]
  exclude: {types: [question], hardware: [MI300X]}
`,
  );
});

test("an empty draft keeps only github_login and the scalar settings", () => {
  assert.equal(
    maintainerFileYaml("newbie", {
      slackUserId: null,
      minScore: 40,
      capacityPerWeek: 10,
      notifyMode: "digest",
      away: [],
      rules: EMPTY_RULES,
    }),
    "github_login: newbie\nmin_score: 40\ncapacity_per_week: 10\nnotify_mode: digest\n",
  );
});

test("the file parses back to the same values, including awkward strings", () => {
  const rules = {
    ...EMPTY_RULES,
    areas: ["moe"],
    models: ["Qwen/Qwen3-*", "a: b", 'say "hi"'],
    keywords: ["#tag", "yes", "multi\nline"],
    exclude: { types: ["docs"], areas: [], hardware: ["MI300X"] },
    natural_language: "colons: here, and 'quotes' \\ backslash",
  };
  const parsed = yaml.load(
    maintainerFileYaml("true", {
      slackUserId: "U01",
      minScore: 0,
      capacityPerWeek: 0,
      notifyMode: "off",
      away: [{ start: "2026-12-20", end: "2027-01-03" }],
      rules,
    }),
    { schema: yaml.JSON_SCHEMA },
  ) as {
    github_login: unknown;
    slack_user_id: unknown;
    min_score: unknown;
    notify_mode: unknown;
    away: unknown;
    rules: Record<string, unknown>;
  };
  assert.equal(parsed.github_login, "true");
  assert.equal(parsed.slack_user_id, "U01");
  assert.equal(parsed.min_score, 0);
  assert.equal(parsed.notify_mode, "off");
  assert.deepEqual(parsed.away, [{ start: "2026-12-20", end: "2027-01-03" }]);
  assert.deepEqual(parsed.rules.areas, ["moe"]);
  assert.deepEqual(parsed.rules.models, rules.models);
  assert.deepEqual(parsed.rules.keywords, rules.keywords);
  assert.deepEqual(parsed.rules.exclude, { types: ["docs"], hardware: ["MI300X"] });
  assert.equal(parsed.rules.natural_language, rules.natural_language);
});

test("rules file paths and GitHub links", () => {
  assert.equal(maintainerFilePath("gau-nernst"), "triage/config/maintainers/gau-nernst.yaml");
  assert.equal(
    maintainerFileEditUrl("gau-nernst"),
    "https://github.com/vllm-project/vllm-dashboard/edit/main/triage/config/maintainers/gau-nernst.yaml",
  );
  const content = 'github_login: gau-nernst\nrules:\n  models: ["qwen4*"]\n';
  const url = new URL(maintainerFileCreateUrl("gau-nernst", content));
  assert.equal(url.origin + url.pathname, "https://github.com/vllm-project/vllm-dashboard/new/main/triage/config/maintainers");
  assert.equal(url.searchParams.get("filename"), "gau-nernst.yaml");
  assert.equal(url.searchParams.get("value"), content);
});
