import assert from "node:assert/strict";
import test from "node:test";
import {
  BAND_ORDER,
  BAND_STYLES,
  avatarUrl,
  bandKey,
  chipStyle,
  flagStyle,
  hardwareVendor,
  isUnrouted,
  scoreFillPercent,
  severityFlags,
  typeLabel,
} from "./triage-style";

test("unknown or missing bands fall back to unscored", () => {
  assert.equal(bandKey("page"), "page");
  assert.equal(bandKey(null), "unscored");
  assert.equal(bandKey("weird"), "unscored");
  for (const band of BAND_ORDER) assert.ok(BAND_STYLES[band].fill.length > 0);
});

test("score bar fill clamps to 0–100", () => {
  assert.equal(scoreFillPercent(58), 58);
  assert.equal(scoreFillPercent(142), 100);
  assert.equal(scoreFillPercent(-5), 0);
  assert.equal(scoreFillPercent(null), 0);
  assert.equal(scoreFillPercent(Number.NaN), 0);
});

test("severity flags are worst-first, labelled, and only from true values", () => {
  const flags = severityFlags({
    type: "regression",
    severity: {
      serving_broken: true,
      crash: true,
      wrong_output: false,
      hang: true,
      perf_regression_pct: -23.6,
      memory_regression: true,
      security: true,
    },
  });
  assert.deepEqual(
    flags.map((flag) => flag.label),
    ["serving broken", "crash", "security", "regression", "hang", "perf −24%", "memory"],
  );
  assert.deepEqual(severityFlags({ type: "perf_regression", severity: {} }).map((f) => f.label), ["perf regression"]);
  assert.deepEqual(severityFlags({ type: "bug", severity: { perf_regression_pct: 0.4 } }), []);
  assert.deepEqual(severityFlags(null), []);
});

test("only serving broken is solid red; security is purple", () => {
  const [broken, crash] = severityFlags({ severity: { serving_broken: true, crash: true } });
  assert.match(flagStyle(broken), /bg-red-600/);
  assert.doesNotMatch(flagStyle(crash), /bg-red-600/);
  const [security] = severityFlags({ severity: { security: true } });
  assert.match(flagStyle(security), /purple/);
});

test("hardware chips are colored by vendor", () => {
  for (const hw of ["H100", "H200", "B200", "B300", "GB200", "GB300", "A100", "L40S", "L4", "RTX", "other_nvidia"]) {
    assert.equal(hardwareVendor(hw), "nvidia", hw);
  }
  for (const hw of ["MI300X", "MI325X", "MI355X", "other_amd"]) assert.equal(hardwareVendor(hw), "amd", hw);
  assert.equal(hardwareVendor("TPU"), "google");
  assert.equal(hardwareVendor("Gaudi"), "intel_gaudi");
  assert.equal(hardwareVendor("XPU"), "intel_xpu");
  assert.equal(hardwareVendor("CPU_x86"), "cpu");
  assert.equal(hardwareVendor("Apple"), "cpu");
  assert.equal(hardwareVendor("other"), "other");
  assert.match(chipStyle("hardware", "B200"), /green/);
  assert.match(chipStyle("hardware", "MI300X"), /red/);
  assert.match(chipStyle("model", "x"), /teal/);
  assert.match(chipStyle("area", "x"), /violet/);
});

test("unrouted means page/route with nobody on it", () => {
  assert.equal(isUnrouted("page", 0), true);
  assert.equal(isUnrouted("route", 0), true);
  assert.equal(isUnrouted("route", 1), false);
  assert.equal(isUnrouted("watch", 0), false);
  assert.equal(isUnrouted(null, 0), false);
});

test("avatar URL and type label", () => {
  assert.equal(avatarUrl("khluu"), "https://github.com/khluu.png?size=40");
  assert.equal(typeLabel("perf_regression"), "perf regression");
});

test("bands display as priorities; storage values are untouched", async () => {
  const { priorityLabel, BAND_STYLES: styles } = await import("./triage-style");
  assert.equal(priorityLabel("page"), "P0");
  assert.equal(priorityLabel("route"), "P1");
  assert.equal(priorityLabel("watch"), "P2");
  assert.equal(priorityLabel("ignore"), "P3");
  assert.equal(priorityLabel(null), "Unscored");
  assert.equal(priorityLabel("bogus"), "Unscored");
  assert.deepEqual(Object.keys(styles), ["page", "route", "watch", "ignore", "unscored"]);
  // Only P0/P1 carry a stripe; P2/P3 stay quiet.
  assert.ok(styles.page.stripe && styles.route.stripe);
  assert.equal(styles.watch.stripe, "");
  assert.equal(styles.ignore.stripe, "");
});

test("groupByPriority keeps order within a group and sections in P order", async () => {
  const { groupByPriority } = await import("./triage-style");
  const items = [
    { id: 1, band: "route" },
    { id: 2, band: "page" },
    { id: 3, band: "route" },
    { id: 4, band: null },
    { id: 5, band: "ignore" },
  ];
  assert.deepEqual(
    groupByPriority(items, (i) => i.band).map((g) => [g.band, g.items.map((i) => i.id)]),
    [["page", [2]], ["route", [1, 3]], ["ignore", [5]], ["unscored", [4]]],
  );
  assert.deepEqual(groupByPriority([], () => "page"), []);
});

test("search box: model:xxx becomes the model filter", async () => {
  const { parseSearchInput, formatSearchInput } = await import("./triage-style");
  assert.deepEqual(parseSearchInput("allreduce hang model:kimi-k3"), { q: "allreduce hang", model: "kimi-k3" });
  assert.deepEqual(parseSearchInput('model:"Qwen3 235B" fp8'), { q: "fp8", model: "Qwen3 235B" });
  assert.deepEqual(parseSearchInput("  #61201 "), { q: "#61201", model: null });
  assert.deepEqual(parseSearchInput(""), { q: null, model: null });
  assert.equal(formatSearchInput("fp8", "Qwen3 235B"), 'fp8 model:"Qwen3 235B"');
  assert.equal(formatSearchInput(null, "kimi"), "model:kimi");
  assert.deepEqual(parseSearchInput("mnnvl owner:gau-nernst"), { q: "mnnvl", model: null, owner: "gau-nernst" });
  assert.deepEqual(parseSearchInput("owner:@khluu model:kimi"), { q: null, model: "kimi", owner: "khluu" });
  assert.deepEqual(parseSearchInput("owner:none crash"), { q: "crash", model: null, owner: "none" });
  assert.deepEqual(parseSearchInput("owner:Unowned"), { q: null, model: null, owner: "none" });
  assert.deepEqual(parseSearchInput("owner:"), { q: null, model: null, owner: null });
  assert.equal("owner" in parseSearchInput("no owner here"), false);
  assert.equal("owner" in parseSearchInput("owner:bad_login!"), false);
  for (const text of ["fp8 model:kimi", 'x model:"a b"', "plain"]) {
    const parsed = parseSearchInput(text);
    assert.deepEqual(parseSearchInput(formatSearchInput(parsed.q, parsed.model)), parsed);
  }
});

test("context line: hardware, then model, then area; capped with the rest hidden", async () => {
  const { contextChips } = await import("./triage-style");
  const { shown, hidden } = contextChips({
    hardware: ["B200", "GB200", "H100"],
    models: ["Kimi-K3", "DeepSeek-V3"],
    areas: ["moe", "kernels"],
  });
  assert.deepEqual(shown.map((c) => c.value), ["B200", "GB200", "Kimi-K3"]);
  assert.deepEqual(hidden.map((c) => c.value), ["moe", "H100", "DeepSeek-V3", "kernels"]);
  assert.deepEqual(contextChips({ hardware: [], models: [], areas: ["docs"] }).shown, [{ kind: "area", value: "docs" }]);
});
