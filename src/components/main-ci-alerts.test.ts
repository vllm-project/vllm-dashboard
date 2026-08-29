import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MainCIAlerts } from "./main-ci-alerts";
import type { MainCiJobAlert } from "../lib/alerts-main-ci";

function alert(overrides: Partial<MainCiJobAlert> = {}): MainCiJobAlert {
  return {
    alertId: "1",
    jobKey: "step:gpu|name:GPU test",
    jobName: "GPU test",
    status: "open",
    openedAt: "2026-08-29T08:00:00.000Z",
    firstFailure: {
      buildkiteJobId: "job-1",
      state: "failed",
      finishedAt: "2026-08-29T08:00:00.000Z",
      buildkiteBuildId: "build-100",
      buildNumber: 100,
      buildUrl: "https://buildkite.com/vllm/ci/builds/100",
      jobUrl: "https://example.test/job-1",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    lastFailure: {
      buildkiteJobId: "job-2",
      state: "failed",
      finishedAt: "2026-08-29T09:00:00.000Z",
      buildkiteBuildId: "build-101",
      buildNumber: 101,
      buildUrl: "https://buildkite.com/vllm/ci/builds/101",
      jobUrl: "https://example.test/job-2",
      commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    failureCount: 2,
    resolvedAt: null,
    resolution: null,
    ...overrides,
  };
}

test("empty lifecycle history renders an explicit empty state", () => {
  const markup = renderToStaticMarkup(createElement(MainCIAlerts, { alerts: [] }));
  assert.match(markup, /No Main CI job alerts/);
});

test("open alert renders first and latest exact failure evidence", () => {
  const markup = renderToStaticMarkup(
    createElement(MainCIAlerts, { alerts: [alert()] }),
  );

  assert.match(markup, /Open/);
  assert.match(markup, /2 failed runs/);
  assert.match(markup, /First failure/);
  assert.match(markup, /Latest failure/);
  assert.match(markup, /https:\/\/buildkite\.com\/vllm\/ci\/builds\/101/);
});

test("resolved alert renders the exact pass that closed it", () => {
  const passed = {
    ...alert().lastFailure,
    buildkiteJobId: "job-3",
    state: "passed",
    finishedAt: "2026-08-29T09:30:00.000Z",
    buildkiteBuildId: "build-102",
    buildNumber: 102,
    buildUrl: "https://buildkite.com/vllm/ci/builds/102",
    jobUrl: "https://example.test/job-3",
    commitSha: "cccccccccccccccccccccccccccccccccccccccc",
  };
  const markup = renderToStaticMarkup(
    createElement(MainCIAlerts, {
      alerts: [
        alert({
          status: "resolved",
          resolvedAt: passed.finishedAt,
          resolution: passed,
        }),
      ],
    }),
  );

  assert.match(markup, /Resolved/);
  assert.match(markup, /Passed again/);
  assert.match(markup, /https:\/\/buildkite\.com\/vllm\/ci\/builds\/102/);
});

