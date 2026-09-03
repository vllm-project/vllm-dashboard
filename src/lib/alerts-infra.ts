/**
 * Presentation logic for the Infra view of the alerts tab.
 *
 * Infra alerts are per-subject breach episodes written by the alerting worker:
 * a host that stopped reporting, a shared (fstype, device) disk group over its
 * usage threshold, or one GPU on one host over its temperature threshold.
 * Unlike Main CI there is nothing to resolve by hand — an episode closes when
 * the worker observes the breach clear, and a host absent from every expected
 * source for seven days is auto-retired instead. Unreporting wording always
 * says a host "stopped reporting"; the view never claims a machine is down.
 */

import { formatAlertDateTime, withinAlertWindow } from "./alerts-shared";

export type InfraAlertType = "unreporting" | "disk_usage" | "gpu_temperature";

export type InfraAlertStatus = "open" | "resolved";

/** One breach episode as the infra alerts API returns it. */
export interface InfraAlertEpisode {
  alertId: string;
  alertType: InfraAlertType;
  subjectKey: string;
  status: InfraAlertStatus;
  openedAt: string;
  resolvedAt: string | null;
  details: Record<string, unknown>;
}

/** A host the worker auto-retired after seven days absent and silent. */
export interface InfraRetiredHost {
  subjectKey: string;
  lastReportedAt: string | null;
  retiredAt: string;
}

export const INFRA_ALERT_TYPE_LABELS: Record<InfraAlertType, string> = {
  unreporting: "Stopped reporting",
  disk_usage: "Disk",
  gpu_temperature: "GPU temperature",
};

export interface InfraAlertEpisodeView extends InfraAlertEpisode {
  typeLabel: string;
  /** The episode's one-line reading of its details payload. */
  summary: string;
  /** True when the episode's host has been auto-retired. */
  retired: boolean;
}

/** The Infra tab's open and recently resolved episodes plus retired hosts. */
export interface InfraAlertView {
  open: InfraAlertEpisodeView[];
  resolved: InfraAlertEpisodeView[];
  retiredHosts: InfraRetiredHost[];
}

function numberDetail(
  details: Record<string, unknown>,
  key: string,
): number | null {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringDetail(
  details: Record<string, unknown>,
  key: string,
): string | null {
  const value = details[key];
  return typeof value === "string" && value ? value : null;
}

function scansSuffix(details: Record<string, unknown>): string {
  const scans = numberDetail(details, "consecutive_scans");
  return scans === null ? "" : ` (${scans} consecutive scans)`;
}

function summarizeUnreporting(episode: InfraAlertEpisode): string {
  const { details } = episode;
  if (episode.status === "resolved") {
    return details.resolution === "retired"
      ? "Auto-retired after 7 days absent from every expected source; it no longer alerts."
      : "The host is reporting again.";
  }
  const minutes = numberDetail(details, "threshold_minutes");
  const silence =
    minutes === null
      ? "No successful report within the configured threshold"
      : `No successful report for over ${minutes} minutes`;
  const lastReportedAt = stringDetail(details, "last_reported_at");
  const seen = lastReportedAt
    ? `Last report ${formatAlertDateTime(lastReportedAt)}.`
    : "No report has ever been received.";
  return `${silence}${scansSuffix(details)}. ${seen}`;
}

function summarizeDiskUsage(episode: InfraAlertEpisode): string {
  const { details } = episode;
  const device = stringDetail(details, "device");
  const fstype = stringDetail(details, "fstype");
  const disk = device && fstype ? `${device} (${fstype})` : episode.subjectKey;
  const threshold = numberDetail(details, "threshold_percent");
  const percent = numberDetail(details, "max_used_percent");
  if (episode.status === "resolved") {
    const now =
      percent === null ? "" : ` (now ${percent}%)`;
    return `${disk} back below ${threshold ?? "?"}% used${now}.`;
  }
  const usage =
    percent === null
      ? `${disk} over its usage threshold`
      : `${disk} at ${percent}% used`;
  const limit = threshold === null ? "" : ` (threshold ${threshold}%)`;
  const mounts = Array.isArray(details.mounts) ? details.mounts : [];
  const breaching = mounts
    .filter(
      (mount): mount is Record<string, unknown> =>
        typeof mount === "object" && mount !== null,
    )
    .map((mount) => {
      const hostname = stringDetail(mount, "hostname");
      const mountPoint = stringDetail(mount, "mount_point");
      const used = numberDetail(mount, "used_percent");
      return hostname && mountPoint && used !== null
        ? `${hostname}:${mountPoint} (${used}%)`
        : null;
    })
    .filter((entry): entry is string => entry !== null);
  const mountLine = breaching.length
    ? ` Breaching mounts: ${breaching.join(", ")}.`
    : "";
  return `${usage}${limit}${scansSuffix(details)}.${mountLine}`;
}

function summarizeGpuTemperature(episode: InfraAlertEpisode): string {
  const { details } = episode;
  const gpuIndex = numberDetail(details, "gpu_index");
  const gpu = gpuIndex === null ? "GPU" : `GPU ${gpuIndex}`;
  const threshold = numberDetail(details, "threshold_celsius");
  const temperature = numberDetail(details, "temperature_c");
  if (episode.status === "resolved") {
    const now = temperature === null ? "" : ` (now ${temperature}°C)`;
    return `${gpu} back below ${threshold ?? "?"}°C${now}.`;
  }
  const heat =
    temperature === null
      ? `${gpu} over its temperature threshold`
      : `${gpu} at ${temperature}°C`;
  const limit = threshold === null ? "" : ` (threshold ${threshold}°C)`;
  return `${heat}${limit}${scansSuffix(details)}.`;
}

/** The one-line reading of an episode's details, per alert type and status. */
export function summarizeInfraEpisode(episode: InfraAlertEpisode): string {
  if (episode.alertType === "unreporting") return summarizeUnreporting(episode);
  if (episode.alertType === "disk_usage") return summarizeDiskUsage(episode);
  return summarizeGpuTemperature(episode);
}

/**
 * Shape episodes for display: open episodes stay visible regardless of age,
 * resolved history obeys the window (matching the Main CI view), and episodes
 * whose host the worker has auto-retired are marked so the list can say so.
 */
export function viewInfraAlerts(
  episodes: readonly InfraAlertEpisode[],
  retiredHosts: readonly InfraRetiredHost[],
  cutoff: Date,
): InfraAlertView {
  const retiredKeys = new Set(retiredHosts.map((host) => host.subjectKey));
  const views: InfraAlertEpisodeView[] = episodes.map((episode) => ({
    ...episode,
    typeLabel: INFRA_ALERT_TYPE_LABELS[episode.alertType],
    summary: summarizeInfraEpisode(episode),
    retired:
      episode.alertType === "unreporting" && retiredKeys.has(episode.subjectKey),
  }));

  const open = views
    .filter((episode) => episode.status === "open")
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  const resolved = views
    .filter(
      (episode) =>
        episode.status === "resolved" &&
        episode.resolvedAt !== null &&
        withinAlertWindow(episode.resolvedAt, cutoff),
    )
    .sort((a, b) =>
      (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""),
    );

  return {
    open,
    resolved,
    retiredHosts: [...retiredHosts].sort((a, b) =>
      b.retiredAt.localeCompare(a.retiredAt),
    ),
  };
}
