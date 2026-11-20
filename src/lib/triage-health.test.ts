import assert from "node:assert/strict";
import test from "node:test";
import { agoText, pipelineHealth, worst } from "./triage-health";
import type { TriagePipelineHealth } from "./triage-types";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function health(patch: Partial<TriagePipelineHealth> = {}): TriagePipelineHealth {
  return {
    lastLabelledAt: minutesAgo(4),
    lastJudgedAt: minutesAgo(6),
    waitingForLabel: 3,
    labelWaitSince: minutesAgo(8),
    waitingForJudgement: 2,
    judgementWaitSince: minutesAgo(9),
    labelFailures24h: 0,
    labelGaveUp: 0,
    lastLabelError: null,
    loginExpiresOn: null,
    ...patch,
  };
}

const tone = (h: TriagePipelineHealth, key: string) => pipelineHealth(h, NOW).signals.find((s) => s.key === key)?.tone;

test("healthy when both steps ran recently", () => {
  const view = pipelineHealth(health(), NOW);
  assert.equal(view.tone, "ok");
  assert.deepEqual(
    view.signals.map((s) => s.text),
    ["Labelled 4m ago · 3 waiting", "Judged 6m ago · 2 P0/P1 waiting", "0 failed · 24h"],
  );
});

test("labelling: amber after 25 minutes, red after an hour, only while items wait", () => {
  const waitedLong = { labelWaitSince: minutesAgo(600) };
  assert.equal(tone(health({ ...waitedLong, lastLabelledAt: minutesAgo(30) }), "labels"), "warn");
  assert.equal(tone(health({ ...waitedLong, lastLabelledAt: minutesAgo(61) }), "labels"), "bad");
  assert.equal(tone(health({ ...waitedLong, lastLabelledAt: null }), "labels"), "bad");
  assert.equal(tone(health({ labelWaitSince: null, lastLabelledAt: null }), "labels"), "bad");
  assert.equal(tone(health({ lastLabelledAt: minutesAgo(600), waitingForLabel: 0 }), "labels"), "ok");
  assert.equal(pipelineHealth(health({ ...waitedLong, lastLabelledAt: minutesAgo(90) }), NOW).tone, "bad");
});

test("after a quiet spell, a new item isn't an alarm until it has waited", () => {
  // Nothing to label for 4 hours, then an item arrived 5 minutes ago.
  const quiet = { lastLabelledAt: minutesAgo(240), labelWaitSince: minutesAgo(5) };
  assert.equal(tone(health(quiet), "labels"), "ok");
  assert.equal(tone(health({ ...quiet, labelWaitSince: minutesAgo(40) }), "labels"), "warn");
  assert.equal(tone(health({ lastJudgedAt: minutesAgo(300), judgementWaitSince: minutesAgo(3) }), "judgements"), "ok");
  assert.equal(tone(health({ lastJudgedAt: minutesAgo(300), judgementWaitSince: minutesAgo(70) }), "judgements"), "bad");
});

test("relevance: the same thresholds on unowned P0/P1 waiting for judgements", () => {
  const waitedLong = { judgementWaitSince: minutesAgo(600) };
  assert.equal(tone(health({ ...waitedLong, lastJudgedAt: minutesAgo(40) }), "judgements"), "warn");
  assert.equal(tone(health({ ...waitedLong, lastJudgedAt: minutesAgo(70) }), "judgements"), "bad");
  assert.equal(tone(health({ lastJudgedAt: minutesAgo(70), waitingForJudgement: 0 }), "judgements"), "ok");
  assert.equal(
    pipelineHealth(health({ waitingForJudgement: 0 }), NOW).signals[1].text,
    "Judged 6m ago · no P0/P1 waiting",
  );
});

test("failures: amber from 3 or any item that gave up, red from 10", () => {
  assert.equal(tone(health({ labelFailures24h: 2 }), "failures"), "ok");
  assert.equal(tone(health({ labelFailures24h: 3 }), "failures"), "warn");
  assert.equal(tone(health({ labelGaveUp: 1 }), "failures"), "warn");
  assert.equal(tone(health({ labelFailures24h: 10 }), "failures"), "bad");
  const view = pipelineHealth(health({ labelFailures24h: 4, labelGaveUp: 2, lastLabelError: "claude exited 1" }), NOW);
  assert.equal(view.signals[2].text, "4 failed · 24h · 2 gave up");
  assert.match(view.signals[2].detail, /Latest error: claude exited 1/);
});

test("login expiry shows only in the last week", () => {
  assert.equal(pipelineHealth(health({ loginExpiresOn: "2026-12-07" }), NOW).signals.length, 3);
  const soon = pipelineHealth(health({ loginExpiresOn: "2026-11-21" }), NOW);
  assert.equal(soon.signals[3].text, "Claude login expires in 3 days");
  assert.equal(soon.tone, "warn");
  const gone = pipelineHealth(health({ loginExpiresOn: "2026-11-18" }), NOW);
  assert.equal(gone.signals[3].text, "Claude login expired");
  assert.equal(gone.tone, "bad");
  assert.equal(pipelineHealth(health({ loginExpiresOn: "soon" }), NOW).signals.length, 3);
});

test("worker warnings show up when runs logged warnings in 24h", () => {
  assert.equal(tone(health({ workerWarnings24h: 0 }), "warnings"), undefined);
  const view = pipelineHealth(
    health({ workerWarnings24h: 2, latestWorkerWarning: "maintainer file(s) rejected (1): broken.yaml" }),
    NOW,
  );
  const sig = view.signals.find((s) => s.key === "warnings");
  assert.ok(sig);
  assert.equal(sig.tone, "warn");
  assert.equal(sig.text, "2 worker warnings · 24h");
  assert.match(sig.detail, /broken\.yaml/);
  assert.equal(view.tone, "warn");
});

test("helpers", () => {
  assert.equal(agoText(null, NOW), "never");
  assert.equal(agoText(minutesAgo(0.5), NOW), "just now");
  assert.equal(agoText(minutesAgo(125), NOW), "2h ago");
  assert.equal(agoText(minutesAgo(60 * 72), NOW), "3d ago");
  assert.equal(worst(["ok", "bad", "warn"]), "bad");
  assert.equal(worst([]), "ok");
});
