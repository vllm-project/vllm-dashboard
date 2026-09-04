import { timingSafeEqual } from "node:crypto";

export const DEFAULT_GPU_REPORT_MAX_BYTES = 256 * 1024;
const ABSOLUTE_GPU_REPORT_MAX_BYTES = 4 * 1024 * 1024;

const MAX_HOSTNAME_LENGTH = 253;
const MAX_GPU_COUNT = 64;
const MAX_DISK_COUNT = 64;
const MAX_NAME_LENGTH = 256;
const MAX_PATH_LENGTH = 1024;
const MAX_ERROR_LENGTH = 2048;
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
    ["hostname", "gpus", "host", "reporter_status", "last_error", "node_conditions"],
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
