import assert from "node:assert/strict";
import test from "node:test";
import {
  INFRA_ALERT_TYPE_LABELS,
  summarizeInfraEpisode,
  viewInfraAlerts,
  type InfraAlertEpisode,
  type InfraRetiredHost,
} from "./alerts-infra";

const CUTOFF = new Date("2026-08-27T00:00:00.000Z");

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
    subjectKey: "gpu-worker-1",
    lastReportedAt: "2026-08-20T09:30:00.000Z",
    retiredAt: "2026-08-27T09:30:00.000Z",
    ...overrides,
  };
}

test("every alert type has a display label", () => {
  assert.equal(INFRA_ALERT_TYPE_LABELS.unreporting, "Stopped reporting");
  assert.equal(INFRA_ALERT_TYPE_LABELS.disk_usage, "Disk");
  assert.equal(INFRA_ALERT_TYPE_LABELS.gpu_temperature, "GPU temperature");
});

test("open episodes stay visible regardless of age; resolved history obeys the window", () => {
  const view = viewInfraAlerts(
    [
      episode({ alertId: "old-open", openedAt: "2026-08-01T10:00:00.000Z" }),
      episode({
        alertId: "recent-resolved",
        status: "resolved",
        openedAt: "2026-08-26T10:00:00.000Z",
        resolvedAt: "2026-08-27T12:00:00.000Z",
        details: { resolution: "reporting" },
      }),
      episode({
        alertId: "stale-resolved",
        status: "resolved",
        openedAt: "2026-08-01T10:00:00.000Z",
        resolvedAt: "2026-08-02T12:00:00.000Z",
        details: { resolution: "reporting" },
      }),
    ],
    [],
    CUTOFF,
  );

  assert.deepEqual(
    view.open.map((entry) => entry.alertId),
    ["old-open"],
  );
  assert.deepEqual(
    view.resolved.map((entry) => entry.alertId),
    ["recent-resolved"],
  );
});

test("open episodes sort newest first, resolved by resolvedAt descending", () => {
  const view = viewInfraAlerts(
    [
      episode({ alertId: "open-old", openedAt: "2026-08-20T10:00:00.000Z" }),
      episode({
        alertId: "open-new",
        subjectKey: "gpu-worker-2",
        openedAt: "2026-08-28T10:00:00.000Z",
      }),
      episode({
        alertId: "resolved-old",
        status: "resolved",
        resolvedAt: "2026-08-27T10:00:00.000Z",
        details: { resolution: "reporting" },
      }),
      episode({
        alertId: "resolved-new",
        status: "resolved",
        resolvedAt: "2026-08-28T10:00:00.000Z",
        details: { resolution: "reporting" },
      }),
    ],
    [],
    CUTOFF,
  );

  assert.deepEqual(
    view.open.map((entry) => entry.alertId),
    ["open-new", "open-old"],
  );
  assert.deepEqual(
    view.resolved.map((entry) => entry.alertId),
    ["resolved-new", "resolved-old"],
  );
});

test("episodes whose host was auto-retired are marked; other types are not", () => {
  const view = viewInfraAlerts(
    [
      episode({ alertId: "unreporting" }),
      episode({
        alertId: "disk",
        alertType: "disk_usage",
        subjectKey: "disk:nfs4:nas:/share",
        details: {},
      }),
    ],
    [
      retiredHost(),
      retiredHost({
        subjectKey: "disk:nfs4:nas:/share",
      }),
    ],
    CUTOFF,
  );

  assert.equal(view.open[0].retired, true);
  assert.equal(view.open[1].retired, false);
});

test("retired hosts sort newest retirement first", () => {
  const view = viewInfraAlerts(
    [],
    [
      retiredHost({ subjectKey: "host-a", retiredAt: "2026-08-25T09:30:00.000Z" }),
      retiredHost({ subjectKey: "host-b", retiredAt: "2026-08-28T09:30:00.000Z" }),
    ],
    CUTOFF,
  );

  assert.deepEqual(
    view.retiredHosts.map((host) => host.subjectKey),
    ["host-b", "host-a"],
  );
});

test("an open unreporting episode says the host stopped reporting, never that a machine is down", () => {
  const summary = summarizeInfraEpisode(episode());

  assert.match(summary, /No successful report for over 30 minutes/);
  assert.match(summary, /3 consecutive scans/);
  assert.match(summary, /Last report/);
  assert.doesNotMatch(summary, /machine is down/i);
});

test("an unreporting episode with no report ever received says so", () => {
  const summary = summarizeInfraEpisode(
    episode({ details: { threshold_minutes: 30, last_reported_at: null } }),
  );

  assert.match(summary, /No report has ever been received/);
});

test("a resolved unreporting episode reads as reporting again or retired", () => {
  const reporting = summarizeInfraEpisode(
    episode({
      status: "resolved",
      resolvedAt: "2026-08-28T11:00:00.000Z",
      details: { resolution: "reporting" },
    }),
  );
  const retired = summarizeInfraEpisode(
    episode({
      status: "resolved",
      resolvedAt: "2026-08-28T11:00:00.000Z",
      details: { resolution: "retired" },
    }),
  );

  assert.match(reporting, /reporting again/);
  assert.match(retired, /Auto-retired/);
  assert.match(retired, /no longer alerts/);
});

test("an open disk episode reads as percent used against its threshold", () => {
  const summary = summarizeInfraEpisode(
    episode({
      alertType: "disk_usage",
      subjectKey: "disk:nfs4:nas:/share",
      details: {
        device: "nas:/share",
        fstype: "nfs4",
        max_used_percent: 94.5,
        threshold_percent: 90,
        consecutive_scans: 3,
        mounts: [
          { hostname: "gpu-worker-1", mount_point: "/data", used_percent: 94.5 },
        ],
      },
    }),
  );

  assert.match(summary, /nas:\/share \(nfs4\) at 94\.5% used \(threshold 90%\)/);
  assert.match(summary, /Breaching mounts: gpu-worker-1:\/data \(94\.5%\)/);
});

test("a resolved disk episode reads as back below its threshold", () => {
  const summary = summarizeInfraEpisode(
    episode({
      alertType: "disk_usage",
      subjectKey: "disk:nfs4:nas:/share",
      status: "resolved",
      resolvedAt: "2026-08-28T11:00:00.000Z",
      details: {
        device: "nas:/share",
        fstype: "nfs4",
        threshold_percent: 90,
        max_used_percent: 81.2,
        resolution: "below_threshold",
      },
    }),
  );

  assert.match(summary, /back below 90% used \(now 81\.2%\)/);
});

test("an open GPU temperature episode reads as degrees against its threshold", () => {
  const summary = summarizeInfraEpisode(
    episode({
      alertType: "gpu_temperature",
      subjectKey: "gpu:gpu-worker-1:3",
      details: {
        hostname: "gpu-worker-1",
        gpu_index: 3,
        temperature_c: 87,
        threshold_celsius: 85,
        consecutive_scans: 2,
      },
    }),
  );

  assert.match(summary, /GPU 3 at 87°C \(threshold 85°C\)/);
  assert.match(summary, /2 consecutive scans/);
});

test("a resolved GPU temperature episode reads as back below its threshold", () => {
  const summary = summarizeInfraEpisode(
    episode({
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
  );

  assert.match(summary, /GPU 3 back below 85°C \(now 71°C\)/);
});
