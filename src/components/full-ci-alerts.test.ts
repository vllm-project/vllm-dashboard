import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FullCIAlerts } from "./full-ci-alerts";
import {
  toFullCiComparisons,
  viewFullCiComparisons,
  type FullCiComparisonRow,
  type FullCiConditionRow,
} from "../lib/alerts-full-ci";

function comparisonRow(
  overrides: Partial<FullCiComparisonRow> = {},
): FullCiComparisonRow {
  return {
    current_build_id: "build-2",
    current_build_number: 9002,
    current_scheduled_at: new Date("2026-08-27T21:00:00.000Z"),
    current_commit_sha: "bbbbbbb0000000000000000000000000000000000",
    current_message: "Second run",
    current_state: "failed",
    current_commit_pr_number: null,
    current_commit_pr_url: null,
    current_commit_pr_title: null,
    previous_build_id: "build-1",
    previous_build_number: 9001,
    previous_scheduled_at: new Date("2026-08-27T06:00:00.000Z"),
    previous_commit_sha: "aaaaaaa0000000000000000000000000000000000",
    previous_message: "First run",
    previous_state: "failed",
    previous_commit_pr_number: null,
    previous_commit_pr_url: null,
    previous_commit_pr_title: null,
    analyzed_at: new Date("2026-08-27T22:00:00.000Z"),
    notification_status: "delivered",
    ...overrides,
  };
}

function conditionRow(
  overrides: Partial<FullCiConditionRow> = {},
): FullCiConditionRow {
  return {
    current_build_id: "build-2",
    job_name: "Async engine test",
    lifecycle: "new",
    cause: "code",
    summary: "assertion failure in the async output processor",
    culprit_pr_number: 1234,
    culprit_pr_url: "https://github.com/vllm-project/vllm/pull/1234",
    culprit_pr_title: "Rework async output processing",
    fixing_pr_number: null,
    fixing_pr_url: null,
    fixing_pr_title: null,
    previous_state: "passed",
    previous_soft_failed: false,
    current_state: "failed",
    current_soft_failed: false,
    ...overrides,
  };
}

function render(
  comparisons: readonly FullCiComparisonRow[],
  conditions: readonly FullCiConditionRow[],
): string {
  return renderToStaticMarkup(
    createElement(FullCIAlerts, {
      comparisons: viewFullCiComparisons(
        toFullCiComparisons(comparisons, conditions),
      ),
    }),
  );
}

test("no comparisons says so rather than rendering an empty card", () => {
  const markup = render([], []);
  assert.match(markup, /No Full CI comparisons/);
});

test("only the newest comparison reads as current CI state", () => {
  const markup = render(
    [
      comparisonRow({
        current_build_id: "old",
        current_scheduled_at: new Date("2026-08-26T21:00:00.000Z"),
      }),
      comparisonRow({ current_build_id: "new" }),
    ],
    [],
  );

  assert.equal(markup.match(/Latest comparison/g)?.length, 1);
  assert.match(markup, /Ongoing at this comparison/);
});

test("ongoing conditions render separately from fixed conditions", () => {
  const markup = render(
    [comparisonRow()],
    [
      conditionRow({ job_name: "Still broken job", lifecycle: "recurring" }),
      conditionRow({
        job_name: "Recovered job",
        lifecycle: "fixed",
        current_state: "passed",
      }),
      conditionRow({ job_name: "Newly broken job", lifecycle: "new" }),
    ],
  );

  const fixedHeadingAt = markup.indexOf("Fixed in this comparison");
  const ongoingHeadingAt = markup.indexOf("Ongoing");
  assert.ok(ongoingHeadingAt >= 0 && fixedHeadingAt > ongoingHeadingAt);

  const ongoingSection = markup.slice(ongoingHeadingAt, fixedHeadingAt);
  const fixedSection = markup.slice(fixedHeadingAt);

  assert.match(ongoingSection, /Newly broken job/);
  assert.match(ongoingSection, /Still broken job/);
  assert.equal(ongoingSection.includes("Recovered job"), false);
  assert.match(fixedSection, /Recovered job/);
  assert.equal(fixedSection.includes("Newly broken job"), false);
});

test("both runs in the comparison are shown so the baseline is auditable", () => {
  const markup = render([comparisonRow()], [conditionRow()]);

  assert.match(markup, /https:\/\/buildkite\.com\/vllm\/ci\/builds\/9002/);
  assert.match(markup, /https:\/\/buildkite\.com\/vllm\/ci\/builds\/9001/);
  assert.match(
    markup,
    /https:\/\/github\.com\/vllm-project\/vllm\/commit\/bbbbbbb0/,
  );
  assert.match(
    markup,
    /https:\/\/github\.com\/vllm-project\/vllm\/commit\/aaaaaaa0/,
  );
  assert.match(markup, /baseline/i);
});

test("a fixed condition exposes its cause, summary, and fixing PR", () => {
  const markup = render(
    [comparisonRow()],
    [
      conditionRow({
        lifecycle: "fixed",
        cause: "code",
        summary: "reverted by the author",
        current_state: "passed",
        fixing_pr_number: 5678,
        fixing_pr_url: "https://github.com/vllm-project/vllm/pull/5678",
        fixing_pr_title: "Revert async output processing",
      }),
    ],
  );

  assert.match(markup, /reverted by the author/);
  assert.match(markup, /Code/);
  assert.match(markup, /https:\/\/github\.com\/vllm-project\/vllm\/pull\/5678/);
  assert.match(markup, /Revert async output processing/);
});

test("a condition shows its outcome in each compared run", () => {
  const markup = render(
    [comparisonRow()],
    [conditionRow({ previous_state: "passed", current_state: "failed" })],
  );

  assert.match(markup, /passed/);
  assert.match(markup, /failed/);
});

test("a job absent from a run reads as absent rather than passing", () => {
  const markup = render(
    [comparisonRow()],
    [conditionRow({ previous_state: null, previous_soft_failed: null })],
  );

  assert.match(markup, /not run/i);
});

test("a condition with no verified attribution renders no pull request link", () => {
  const markup = render(
    [comparisonRow()],
    [
      conditionRow({
        cause: "infrastructure",
        summary: "runner lost its GPU",
        culprit_pr_number: null,
        culprit_pr_url: null,
        culprit_pr_title: null,
      }),
    ],
  );

  assert.equal(markup.includes("/pull/"), false);
});

test("a comparison shows how far its Slack notification got", () => {
  const markup = render(
    [comparisonRow({ notification_status: "dead_letter" })],
    [conditionRow()],
  );

  assert.match(markup, /Slack dead-lettered/);
});

test("the commit subject links the pull request it merged", () => {
  const markup = render(
    [
      comparisonRow({
        current_message: "[Bugfix] Bound cache_salt length (#54353)",
      }),
    ],
    [conditionRow()],
  );

  assert.match(
    markup,
    /href="https:\/\/github\.com\/vllm-project\/vllm\/pull\/54353"/,
  );
  assert.match(markup, /Bound cache_salt length/);
});

test("a comparison header counts each lifecycle it classified", () => {
  const markup = render(
    [comparisonRow()],
    [
      conditionRow({ job_name: "New job", lifecycle: "new" }),
      conditionRow({ job_name: "Old job", lifecycle: "recurring" }),
      conditionRow({ job_name: "Other old job", lifecycle: "recurring" }),
      conditionRow({ job_name: "Recovered job", lifecycle: "fixed" }),
    ],
  );

  assert.match(markup, /1 new/);
  assert.match(markup, /2 recurring/);
  assert.match(markup, /1 fixed/);
});

test("a failed run is marked as failed rather than described in passing text", () => {
  const markup = render([comparisonRow()], [conditionRow()]);

  assert.match(markup, /text-red-600[^"]*"><svg/);
});

test("a run names the change it carried from the pull request the analyzer recorded", () => {
  const markup = render(
    [
      comparisonRow({
        current_message: "Full CI run - nightly",
        current_commit_pr_number: 54353,
        current_commit_pr_url:
          "https://github.com/vllm-project/vllm/pull/54353",
        current_commit_pr_title:
          "[Bugfix] Bound cache_salt length to prevent DoS",
      }),
    ],
    [conditionRow()],
  );

  assert.match(
    markup,
    /href="https:\/\/github\.com\/vllm-project\/vllm\/pull\/54353"/,
  );
  assert.match(markup, /#54353/);
  assert.match(markup, /Bound cache_salt length to prevent DoS/);
  assert.doesNotMatch(markup, /Full CI run - nightly/);
});
