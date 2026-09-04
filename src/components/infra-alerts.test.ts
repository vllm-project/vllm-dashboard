import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InfraAlerts } from "./infra-alerts";
import {
  viewInfraAlerts,
  type InfraAlertEpisode,
  type InfraRetiredHost,
} from "../lib/alerts-infra";

const CUTOFF = new Date("2026-08-20T00:00:00.000Z");

function episode(overrides: Partial<InfraAlertEpisode> = {}): InfraAlertEpisode {
  return {
    alertId: "1",
    alertType: "unreporting",
    subjectKey: "gpu-worker-1",
    status: "open",
    openedAt: "2026-08-28T10:00:00.000Z",
    resolvedAt: null,
    details: {
      hostname: "gpu-worker-1",
      last_reported_at: "2026-08-28T09:30:00.000Z",
      threshold_minutes: 30,
      consecutive_scans: 3,
    },
    ...overrides,
  };
}

function retiredHost(
  overrides: Partial<InfraRetiredHost> = {},
): InfraRetiredHost {
  return {
    subjectKey: "gpu-worker-9",
    lastReportedAt: "2026-08-20T09:30:00.000Z",
    retiredAt: "2026-08-27T09:30:00.000Z",
    ...overrides,
  };
}

function render(
  episodes: InfraAlertEpisode[],
  retiredHosts: InfraRetiredHost[] = [],
): string {
  return renderToStaticMarkup(
    createElement(InfraAlerts, {
      view: viewInfraAlerts(episodes, retiredHosts, CUTOFF),
    }),
  );
}

test("Infra alerts offer no resolution controls", () => {
  const markup = render([
    episode({ alertId: "1" }),
    episode({
      alertId: "2",
      status: "resolved",
      resolvedAt: "2026-08-28T11:00:00.000Z",
      details: { resolution: "reporting" },
    }),
  ]);

  assert.doesNotMatch(markup, /<button|<form|<input|<select|<textarea/i);
});

test("every episode type renders with its subject, type, and status", () => {
  const markup = render([
    episode({ alertId: "1" }),
    episode({
      alertId: "2",
      alertType: "disk_usage",
      subjectKey: "disk:nfs4:nas:/share",
      details: {
        device: "nas:/share",
        fstype: "nfs4",
        max_used_percent: 94.5,
        threshold_percent: 90,
      },
    }),
    episode({
      alertId: "3",
      alertType: "gpu_temperature",
      subjectKey: "gpu:gpu-worker-1:3",
      status: "resolved",
      resolvedAt: "2026-08-28T11:00:00.000Z",
      details: {
        gpu_index: 3,
        temperature_c: 71,
        threshold_celsius: 85,
        resolution: "below_threshold",
      },
    }),
  ]);

  assert.match(markup, /gpu-worker-1/);
  assert.match(markup, /disk:nfs4:nas:\/share/);
  assert.match(markup, /gpu:gpu-worker-1:3/);
  assert.match(markup, /Stopped reporting/);
  assert.match(markup, /Disk/);
  assert.match(markup, /GPU temperature/);
  assert.match(markup, /Open/);
  assert.match(markup, /Resolved/);
  assert.match(markup, /94\.5% used \(threshold 90%\)/);
  assert.match(markup, /back below 85°C \(now 71°C\)/);
});

test("unreporting episodes say the host stopped reporting and never that a machine is down", () => {
  const markup = render([episode()], [retiredHost()]);

  assert.match(markup, /stopped reporting/i);
  assert.doesNotMatch(markup, /machine is down/i);
});

test("retired hosts are visibly marked, in the episode list and in their own section", () => {
  const markup = render(
    [episode({ alertId: "1" })],
    [retiredHost({ subjectKey: "gpu-worker-1" })],
  );

  assert.match(markup, /Retired/);
  assert.match(markup, /Retired hosts/);
  assert.match(markup, /no longer alerts/);
});

test("an empty window says so instead of rendering empty sections", () => {
  const markup = render([]);

  assert.match(markup, /No infra alerts were recorded in this window/);
  assert.doesNotMatch(markup, /<button|<form|<input/i);
});

test("open and resolved episodes render under their own sections", () => {
  const markup = render([
    episode({ alertId: "1" }),
    episode({
      alertId: "2",
      subjectKey: "gpu-worker-2",
      status: "resolved",
      resolvedAt: "2026-08-28T11:00:00.000Z",
      details: { resolution: "reporting" },
    }),
  ]);

  assert.match(markup, /Open/);
  assert.match(markup, /Recently resolved/);
  assert.match(markup, /reporting again/);
});
