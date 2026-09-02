import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MainCIAlerts, MainCiAlertRow } from "./main-ci-alerts";
import type { MainCiJobAlert, MainCiJobAnalysis } from "../lib/alerts-main-ci";

function analysis(overrides: Partial<MainCiJobAnalysis> = {}): MainCiJobAnalysis {
  return {
    analyzedFailureJobId: "job-2",
    classification: "infra",
    confidence: "high",
    summary: "The runner lost its GPU agent before tests started.",
    evidenceUrls: ["https://buildkite.com/vllm/ci/builds/101#job-2"],
    recommendedAction: "Re-run the job on a fresh agent.",
    suspectedFixPrs: [
      {
        number: 123,
        url: "https://github.com/vllm-project/vllm/pull/123",
        title: "Guard against agent loss",
      },
    ],
    modelVersion: "moonshotai/Kimi-K3",
    analyzedAt: "2026-08-29T09:05:00.000Z",
    stale: false,
    ...overrides,
  };
}

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
    resolutionKind: null,
    analysis: null,
    ...overrides,
  };
}

test("empty lifecycle history renders an explicit empty state", () => {
  const markup = renderToStaticMarkup(createElement(MainCIAlerts, { alerts: [] }));
  assert.match(markup, /No Main CI job alerts/);
});

test("status filter chips carry per-status counts and default to open", () => {
  const markup = renderToStaticMarkup(
    createElement(MainCIAlerts, {
      alerts: [
        alert(),
        alert({
          alertId: "2",
          status: "resolved",
          resolvedAt: "2026-08-29T09:30:00.000Z",
        }),
      ],
    }),
  );

  assert.match(markup, /Open<span[^>]*>1<\/span>/);
  assert.match(markup, /Resolved<span[^>]*>1<\/span>/);
  assert.match(markup, /All<span[^>]*>2<\/span>/);
  // The default Open filter hides the resolved row.
  assert.equal(markup.match(/GPU test/g)?.length, 1);
});

test("open alert renders first and latest exact failure evidence", () => {
  const markup = renderToStaticMarkup(
    createElement(MainCIAlerts, { alerts: [alert()] }),
  );

  // Open is the default state, so the row carries no status mark of its own.
  assert.doesNotMatch(markup, />Resolved<\/span>/);
  assert.match(markup, /2 failed runs/);
  assert.match(markup, /First failure/);
  assert.match(markup, /Latest failure/);
  assert.match(markup, /opened/);
  assert.match(markup, /https:\/\/buildkite\.com\/vllm\/ci\/builds\/101/);
});

test("analyzed alert renders classification and the analysis panel", () => {
  const markup = renderToStaticMarkup(
    createElement(MainCIAlerts, { alerts: [alert({ analysis: analysis() })] }),
  );

  assert.match(markup, /infra/);
  assert.match(markup, /· high/);
  assert.match(markup, /The runner lost its GPU agent/);
  assert.match(markup, /Re-run the job on a fresh agent/);
  assert.match(markup, /PR #123 — Guard against agent loss/);
  assert.match(markup, /moonshotai\/Kimi-K3/);
  // The reason dropdown appears once analysis data exists.
  assert.match(markup, /<option value="unanalyzed"/);
});

test("stale analysis carries a visible warning", () => {
  const markup = renderToStaticMarkup(
    createElement(MainCIAlerts, {
      alerts: [
        alert({
          analysis: analysis({
            analyzedFailureJobId: "job-1",
            stale: true,
          }),
        }),
      ],
    }),
  );

  assert.match(markup, /Analysis stale — a newer failure was observed/);
  assert.match(markup, />stale</);
});

test("unanalyzed alert renders a subtle placeholder and no reason dropdown", () => {
  const markup = renderToStaticMarkup(
    createElement(MainCIAlerts, { alerts: [alert()] }),
  );

  assert.match(markup, /No analysis yet\./);
  assert.doesNotMatch(markup, /<option value="unanalyzed"/);
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
  // The list defaults to the Open filter, so render the row directly.
  const markup = renderToStaticMarkup(
    createElement(MainCiAlertRow, {
      alert: alert({
        status: "resolved",
        resolvedAt: passed.finishedAt,
        resolution: passed,
      }),
    }),
  );

  assert.match(markup, /Resolved<\/span>/);
  assert.match(markup, /Passed again/);
  assert.match(markup, /https:\/\/buildkite\.com\/vllm\/ci\/builds\/102/);
});

test("open rows offer a resolve button when a handler is provided", () => {
  const markup = renderToStaticMarkup(
    createElement(MainCIAlerts, {
      alerts: [alert()],
      onResolve: async () => {},
    }),
  );

  assert.match(markup, />Resolve</);
});

test("no resolve button without a handler or on resolved rows", () => {
  const withoutHandler = renderToStaticMarkup(
    createElement(MainCIAlerts, { alerts: [alert()] }),
  );
  assert.doesNotMatch(withoutHandler, />Resolve</);

  const resolved = renderToStaticMarkup(
    createElement(MainCiAlertRow, {
      alert: alert({ status: "resolved", resolvedAt: "2026-08-29T09:30:00.000Z" }),
      onResolve: async () => {},
    }),
  );
  assert.doesNotMatch(resolved, />Resolve</);
});

test("manual resolution is labeled and does not claim a passing run", () => {
  const markup = renderToStaticMarkup(
    createElement(MainCiAlertRow, {
      alert: alert({
        status: "resolved",
        resolvedAt: "2026-08-29T09:30:00.000Z",
        resolution: alert().lastFailure,
        resolutionKind: "manual",
      }),
    }),
  );

  assert.match(markup, /Resolved manually/);
  assert.match(markup, /no passing run was observed/);
  assert.doesNotMatch(markup, /Passed again/);
});

test("hide options filter matching job names out of the list", () => {
  const alerts = [
    alert({ alertId: "1", jobName: "GPU test" }),
    alert({ alertId: "2", jobName: "AMD: MI300X Test" }),
    alert({ alertId: "3", jobName: "Lint (soft-fail)" }),
    alert({ alertId: "4", jobName: "Optional check" }),
  ];

  const visible = renderToStaticMarkup(
    createElement(MainCIAlerts, { alerts }),
  );
  assert.match(visible, /AMD: MI300X Test/);
  assert.match(visible, /Lint \(soft-fail\)/);
  assert.match(visible, /Optional check/);

  const hidden = renderToStaticMarkup(
    createElement(MainCIAlerts, {
      alerts,
      hideAmd: true,
      hideSoftFail: true,
      hideOptional: true,
    }),
  );
  assert.match(hidden, /GPU test/);
  assert.doesNotMatch(hidden, /AMD: MI300X Test/);
  assert.doesNotMatch(hidden, /Lint \(soft-fail\)/);
  assert.doesNotMatch(hidden, /Optional check/);
});
