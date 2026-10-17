import { timingSafeEqual } from "node:crypto";

export const DEFAULT_GPU_REPORT_MAX_BYTES = 256 * 1024;
const ABSOLUTE_GPU_REPORT_MAX_BYTES = 4 * 1024 * 1024;

const MAX_HOSTNAME_LENGTH = 253;
const MAX_GPU_COUNT = 64;
const MAX_DISK_COUNT = 64;
const MAX_NAME_LENGTH = 256;
const MAX_PATH_LENGTH = 1024;
const MAX_ERROR_LENGTH = 2048;
const MAX_XID_COUNT = 500;
const MAX_XID_MESSAGE_LENGTH = 1024;
const MAX_ROOT_OWNED_SLOTS = 256;
const MAX_NETWORK_PROBES = 8;
const MAX_BYTES_VALUE = Number.MAX_SAFE_INTEGER;

export type ReporterStatus = "ok" | "degraded";
export type DiskRole = "workspace" | "images" | "data" | "system" | "other";

export interface NormalizedGpuMetric {
  index: number;
  name: string | null;
  gpu_util: number;
  mem_used_mb: number;
  mem_total_mb: number;
  temperature_c: number | null;
  power_draw_w: number | null;
  power_limit_w: number | null;
  dead_proc_mem_mb: number | null;
  recovery_action: string | null;
  remapped_rows_failure: boolean | null;
  ecc_uncorrected: number | null;
}

export interface NormalizedXidEvent {
  bus_id: string;
  xid: number;
  at: Date;
  message: string;
}

export interface NormalizedNetworkProbe {
  target: string;
  ok: boolean;
  /** Error kind (timeout, dns, tls, connect, other); null when ok. */
  error: string | null;
  latency_ms: number | null;
}

export interface NormalizedDiskMetric {
  mount_point: string | null;
  device: string | null;
  fstype: string;
  role: DiskRole;
  used_bytes: number | null;
  total_bytes: number | null;
  error: string | null;
}

export interface NormalizedHostMetrics {
  cpu_util: number | null;
  cpu_count: number | null;
  ram_used_bytes: number | null;
  ram_total_bytes: number | null;
  ram_available_bytes: number | null;
  disks: NormalizedDiskMetric[] | null;
}

export interface NormalizedNodeConditions {
  ready: boolean | null;
  disk_pressure: boolean | null;
  memory_pressure: boolean | null;
  pid_pressure: boolean | null;
  unschedulable: boolean;
}

export interface NormalizedGpuReport {
  hostname: string;
  gpus: NormalizedGpuMetric[];
  host: NormalizedHostMetrics | null;
  reporter_status: ReporterStatus;
  last_error: string | null;
  node_conditions: NormalizedNodeConditions | null;
  /** null = could not read; [] = read, nothing new. */
  xids: NormalizedXidEvent[] | null;
  mig_slices: number | null;
  root_owned_slots: string[] | null;
  allocatable_gpus: number | null;
  capacity_gpus: number | null;
  /** true = nvidia-smi errored or hung; null = not checked. */
  gpu_query_hung: boolean | null;
  gpu_query_error: string | null;
  // H200: whether Docker can start a container, and why not.
  docker_ok: boolean | null;
  docker_error: string | null;
  network_probes: NormalizedNetworkProbe[] | null;
}

export class GpuReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpuReportValidationError";
  }
}

type JsonObject = Record<string, unknown>;

function invalid(path: string, expectation: string): never {
  throw new GpuReportValidationError(`${path} ${expectation}`);
}

function objectValue(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(path, "must be an object");
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: readonly string[], path: string) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    invalid(path, `contains unsupported field '${unexpected[0]}'`);
  }
}

function stringValue(
  value: unknown,
  path: string,
  options: { maxLength: number; nullable: true },
): string | null;
function stringValue(
  value: unknown,
  path: string,
  options: { maxLength: number; nullable?: false },
): string;
function stringValue(
  value: unknown,
  path: string,
  { maxLength, nullable = false }: { maxLength: number; nullable?: boolean },
): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string") return invalid(path, "must be a string");
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    return invalid(path, `must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function optionalString(
  value: unknown,
  path: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  return stringValue(value, path, { maxLength });
}

function numberValue(
  value: unknown,
  path: string,
  { min, max, integer = false }: { min: number; max: number; integer?: boolean },
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  ) {
    return invalid(
      path,
      `must be a finite ${integer ? "integer" : "number"} between ${min} and ${max}`,
    );
  }
  return value;
}

function optionalNumber(
  value: unknown,
  path: string,
  options: { min: number; max: number; integer?: boolean },
): number | null {
  if (value === undefined || value === null) return null;
  return numberValue(value, path, options);
}

function optionalBoolean(value: unknown, path: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") return invalid(path, "must be a boolean or null");
  return value;
}

function xidEvent(value: unknown, index: number): NormalizedXidEvent {
  const path = `xids[${index}]`;
  const event = objectValue(value, path);
  exactKeys(event, ["bus_id", "xid", "at", "message"], path);
  if (typeof event.message !== "string" || event.message.length > MAX_XID_MESSAGE_LENGTH) {
    invalid(`${path}.message`, `must be a string of at most ${MAX_XID_MESSAGE_LENGTH} characters`);
  }
  // The k8s reporter can't always tie an Xid to a GPU and sends "".
  if (typeof event.bus_id !== "string" || event.bus_id.length > 64) {
    invalid(`${path}.bus_id`, "must be a string of at most 64 characters");
  }
  const busId = event.bus_id.trim();
  if (typeof event.at !== "string") invalid(`${path}.at`, "must be an ISO-8601 string");
  const at = new Date(event.at);
  if (Number.isNaN(at.getTime())) invalid(`${path}.at`, "must be an ISO-8601 string");
  return {
    bus_id: busId,
    xid: numberValue(event.xid, `${path}.xid`, { min: 0, max: 65_535, integer: true }),
    at,
    message: event.message,
  };
}

function networkProbe(value: unknown, index: number): NormalizedNetworkProbe {
  const path = `network_probes[${index}]`;
  const probe = objectValue(value, path);
  exactKeys(probe, ["target", "ok", "error", "latency_ms"], path);
  if (typeof probe.ok !== "boolean") invalid(`${path}.ok`, "must be a boolean");
  return {
    target: stringValue(probe.target, `${path}.target`, { maxLength: 64 }),
    ok: probe.ok,
    error: optionalString(probe.error, `${path}.error`, 64),
    latency_ms: optionalNumber(probe.latency_ms, `${path}.latency_ms`, {
      min: 0,
      max: 600_000,
    }),
  };
}

function gpuMetric(value: unknown, index: number): NormalizedGpuMetric {
  const path = `gpus[${index}]`;
  const gpu = objectValue(value, path);
  exactKeys(
    gpu,
    [
      "index",
      "name",
      "gpu_util",
      "mem_used_mb",
      "mem_total_mb",
      "temperature_c",
      "power_draw_w",
      "power_limit_w",
      "dead_proc_mem_mb",
      "recovery_action",
      "remapped_rows_failure",
      "ecc_uncorrected",
    ],
    path,
  );
  const memUsed = numberValue(gpu.mem_used_mb, `${path}.mem_used_mb`, {
    min: 0,
    max: 1_000_000_000,
  });
  const memTotal = numberValue(gpu.mem_total_mb, `${path}.mem_total_mb`, {
    min: 0,
    max: 1_000_000_000,
  });
  if (memUsed > memTotal && memTotal > 0) {
    invalid(`${path}.mem_used_mb`, "must not exceed mem_total_mb");
  }
  return {
    index: numberValue(gpu.index, `${path}.index`, {
      min: 0,
      max: 1023,
      integer: true,
    }),
    name: optionalString(gpu.name, `${path}.name`, MAX_NAME_LENGTH),
    gpu_util: numberValue(gpu.gpu_util, `${path}.gpu_util`, { min: 0, max: 100 }),
    mem_used_mb: memUsed,
    mem_total_mb: memTotal,
    temperature_c: optionalNumber(gpu.temperature_c, `${path}.temperature_c`, {
      min: -50,
      max: 200,
    }),
    power_draw_w: optionalNumber(gpu.power_draw_w, `${path}.power_draw_w`, {
      min: 0,
      max: 100_000,
    }),
    power_limit_w: optionalNumber(gpu.power_limit_w, `${path}.power_limit_w`, {
      min: 0,
      max: 100_000,
    }),
    dead_proc_mem_mb: optionalNumber(gpu.dead_proc_mem_mb, `${path}.dead_proc_mem_mb`, {
      min: 0,
      max: 1_000_000_000,
    }),
    recovery_action: optionalString(
      gpu.recovery_action,
      `${path}.recovery_action`,
      MAX_NAME_LENGTH,
    ),
    remapped_rows_failure: optionalBoolean(
      gpu.remapped_rows_failure,
      `${path}.remapped_rows_failure`,
    ),
    ecc_uncorrected: optionalNumber(gpu.ecc_uncorrected, `${path}.ecc_uncorrected`, {
      min: 0,
      max: MAX_BYTES_VALUE,
      integer: true,
    }),
  };
}

function diskMetric(value: unknown, index: number): NormalizedDiskMetric {
  const path = `host.disks[${index}]`;
  const disk = objectValue(value, path);
  exactKeys(
    disk,
    ["mount_point", "device", "fstype", "role", "used_bytes", "total_bytes", "error"],
    path,
  );
  const mountPoint = optionalString(disk.mount_point, `${path}.mount_point`, MAX_PATH_LENGTH);
  const device = optionalString(disk.device, `${path}.device`, MAX_PATH_LENGTH);
  if (mountPoint === null && device === null) {
    invalid(path, "must identify a mount_point or device");
  }
  const fstype = stringValue(disk.fstype, `${path}.fstype`, {
    maxLength: 64,
  });
  const roles: readonly DiskRole[] = ["workspace", "images", "data", "system", "other"];
  if (typeof disk.role !== "string" || !roles.includes(disk.role as DiskRole)) {
    invalid(`${path}.role`, `must be one of ${roles.join(", ")}`);
  }
  const usedBytes = optionalNumber(disk.used_bytes, `${path}.used_bytes`, {
    min: 0,
    max: MAX_BYTES_VALUE,
    integer: true,
  });
  const totalBytes = optionalNumber(disk.total_bytes, `${path}.total_bytes`, {
    min: 1,
    max: MAX_BYTES_VALUE,
    integer: true,
  });
  const error = optionalString(disk.error, `${path}.error`, MAX_ERROR_LENGTH);
  if ((usedBytes === null) !== (totalBytes === null)) {
    invalid(path, "must provide used_bytes and total_bytes together");
  }
  if (usedBytes !== null && totalBytes !== null && usedBytes > totalBytes) {
    invalid(`${path}.used_bytes`, "must not exceed total_bytes");
  }
  if (usedBytes === null && error === null) {
    invalid(path, "must provide usage values or an error");
  }
  return {
    mount_point: mountPoint,
    device,
    fstype,
    role: disk.role as DiskRole,
    used_bytes: usedBytes,
    total_bytes: totalBytes,
    error,
  };
}

function hostMetrics(value: unknown): NormalizedHostMetrics {
  const host = objectValue(value, "host");
  exactKeys(
    host,
    [
      "cpu_util",
      "cpu_count",
      "ram_used_bytes",
      "ram_total_bytes",
      "ram_available_bytes",
      "disks",
    ],
    "host",
  );
  if (Object.keys(host).length === 0) invalid("host", "must not be empty");

  const ramUsed = optionalNumber(host.ram_used_bytes, "host.ram_used_bytes", {
    min: 0,
    max: MAX_BYTES_VALUE,
    integer: true,
  });
  const ramTotal = optionalNumber(host.ram_total_bytes, "host.ram_total_bytes", {
    min: 1,
    max: MAX_BYTES_VALUE,
    integer: true,
  });
  const ramAvailable = optionalNumber(
    host.ram_available_bytes,
    "host.ram_available_bytes",
    { min: 0, max: MAX_BYTES_VALUE, integer: true },
  );
  const ramFields = [ramUsed, ramTotal, ramAvailable];
  if (ramFields.some((field) => field !== null) && ramFields.some((field) => field === null)) {
    invalid("host", "must provide all RAM values together");
  }
  if (ramUsed !== null && ramTotal !== null && ramUsed > ramTotal) {
    invalid("host.ram_used_bytes", "must not exceed ram_total_bytes");
  }
  if (ramAvailable !== null && ramTotal !== null && ramAvailable > ramTotal) {
    invalid("host.ram_available_bytes", "must not exceed ram_total_bytes");
  }

  let disks: NormalizedDiskMetric[] | null = null;
  if (host.disks !== undefined && host.disks !== null) {
    if (!Array.isArray(host.disks) || host.disks.length > MAX_DISK_COUNT) {
      invalid("host.disks", `must be an array with at most ${MAX_DISK_COUNT} entries`);
    }
    disks = host.disks.map(diskMetric);
  }
  return {
    cpu_util: optionalNumber(host.cpu_util, "host.cpu_util", { min: 0, max: 100 }),
    cpu_count: optionalNumber(host.cpu_count, "host.cpu_count", {
      min: 1,
      max: 65_536,
      integer: true,
    }),
    ram_used_bytes: ramUsed,
    ram_total_bytes: ramTotal,
    ram_available_bytes: ramAvailable,
    disks,
  };
}

function nodeConditions(value: unknown): NormalizedNodeConditions {
  const conditions = objectValue(value, "node_conditions");
  const fields = [
    "ready",
    "disk_pressure",
    "memory_pressure",
    "pid_pressure",
    "unschedulable",
  ] as const;
  exactKeys(conditions, fields, "node_conditions");
  for (const field of fields.slice(0, -1)) {
    const condition = conditions[field];
    if (condition !== null && typeof condition !== "boolean") {
      invalid(`node_conditions.${field}`, "must be a boolean or null");
    }
  }
  if (typeof conditions.unschedulable !== "boolean") {
    invalid("node_conditions.unschedulable", "must be a boolean");
  }
  return {
    ready: conditions.ready as boolean | null,
    disk_pressure: conditions.disk_pressure as boolean | null,
    memory_pressure: conditions.memory_pressure as boolean | null,
    pid_pressure: conditions.pid_pressure as boolean | null,
    unschedulable: conditions.unschedulable,
  };
}

export function parseGpuReportPayload(value: unknown): NormalizedGpuReport {
  const report = objectValue(value, "payload");
  exactKeys(
    report,
    [
      "hostname",
      "gpus",
      "host",
      "reporter_status",
      "last_error",
      "node_conditions",
      "xids",
      "mig_slices",
      "root_owned_slots",
      "allocatable_gpus",
      "capacity_gpus",
      "gpu_query_hung",
      "gpu_query_error",
      "network_probes",
      "docker_ok",
      "docker_error",
    ],
    "payload",
  );
  const rawHostname = stringValue(report.hostname, "hostname", {
    maxLength: MAX_HOSTNAME_LENGTH,
  });
  const hostname = rawHostname.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)) {
    invalid("hostname", "must contain only DNS hostname characters");
  }
  if (!Array.isArray(report.gpus) || report.gpus.length > MAX_GPU_COUNT) {
    invalid("gpus", `must be an array with at most ${MAX_GPU_COUNT} entries`);
  }
  const gpus = report.gpus.map(gpuMetric);
  if (new Set(gpus.map((gpu) => gpu.index)).size !== gpus.length) {
    invalid("gpus", "must not contain duplicate GPU indexes");
  }
  const reporterStatus = report.reporter_status ?? "ok";
  if (reporterStatus !== "ok" && reporterStatus !== "degraded") {
    invalid("reporter_status", "must be 'ok' or 'degraded'");
  }
  let xids: NormalizedXidEvent[] | null = null;
  if (report.xids !== undefined && report.xids !== null) {
    if (!Array.isArray(report.xids) || report.xids.length > MAX_XID_COUNT) {
      invalid("xids", `must be an array with at most ${MAX_XID_COUNT} entries`);
    }
    xids = report.xids.map(xidEvent);
  }
  let rootOwnedSlots: string[] | null = null;
  if (report.root_owned_slots !== undefined && report.root_owned_slots !== null) {
    if (
      !Array.isArray(report.root_owned_slots) ||
      report.root_owned_slots.length > MAX_ROOT_OWNED_SLOTS
    ) {
      invalid(
        "root_owned_slots",
        `must be an array with at most ${MAX_ROOT_OWNED_SLOTS} entries`,
      );
    }
    rootOwnedSlots = report.root_owned_slots.map((slot, index) =>
      stringValue(slot, `root_owned_slots[${index}]`, { maxLength: MAX_PATH_LENGTH }),
    );
  }
  let networkProbes: NormalizedNetworkProbe[] | null = null;
  if (report.network_probes !== undefined && report.network_probes !== null) {
    if (
      !Array.isArray(report.network_probes) ||
      report.network_probes.length > MAX_NETWORK_PROBES
    ) {
      invalid("network_probes", `must be an array with at most ${MAX_NETWORK_PROBES} entries`);
    }
    networkProbes = report.network_probes.map(networkProbe);
  }
  const gpuCount = { min: 0, max: 65_536, integer: true };
  const lastError = optionalString(report.last_error, "last_error", MAX_ERROR_LENGTH);
  if (reporterStatus === "degraded" && lastError === null) {
    invalid("last_error", "is required when reporter_status is 'degraded'");
  }
  if (gpus.length === 0 && reporterStatus !== "degraded") {
    invalid("gpus", "must contain at least one GPU unless the reporter is degraded");
  }
  return {
    hostname,
    gpus,
    host: report.host === undefined || report.host === null ? null : hostMetrics(report.host),
    reporter_status: reporterStatus,
    last_error: lastError,
    node_conditions:
      report.node_conditions === undefined || report.node_conditions === null
        ? null
        : nodeConditions(report.node_conditions),
    xids,
    mig_slices: optionalNumber(report.mig_slices, "mig_slices", gpuCount),
    root_owned_slots: rootOwnedSlots,
    allocatable_gpus: optionalNumber(report.allocatable_gpus, "allocatable_gpus", gpuCount),
    capacity_gpus: optionalNumber(report.capacity_gpus, "capacity_gpus", gpuCount),
    gpu_query_hung: optionalBoolean(report.gpu_query_hung, "gpu_query_hung"),
    gpu_query_error: optionalString(report.gpu_query_error, "gpu_query_error", MAX_ERROR_LENGTH),
    network_probes: networkProbes,
    docker_ok: optionalBoolean(report.docker_ok, "docker_ok"),
    docker_error: optionalString(report.docker_error, "docker_error", MAX_ERROR_LENGTH),
  };
}

export function parseGpuReportJson(payload: Uint8Array): NormalizedGpuReport {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    invalid("payload", "must be valid JSON");
  }
  return parseGpuReportPayload(value);
}

export type GpuReportAuthResult = "authorized" | "not-configured" | "unauthorized";

export function gpuReportAuthResult(
  configuredSecret: string | undefined,
  authorization: string | null,
): GpuReportAuthResult {
  if (!configuredSecret) return "not-configured";
  if (!authorization?.startsWith("Bearer ")) return "unauthorized";
  const expected = Buffer.from(configuredSecret);
  const received = Buffer.from(authorization.slice("Bearer ".length));
  return expected.length === received.length && timingSafeEqual(expected, received)
    ? "authorized"
    : "unauthorized";
}

export function gpuReportMaxBytes(configured: string | undefined): number {
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= ABSOLUTE_GPU_REPORT_MAX_BYTES
    ? parsed
    : DEFAULT_GPU_REPORT_MAX_BYTES;
}
