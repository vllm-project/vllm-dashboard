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
