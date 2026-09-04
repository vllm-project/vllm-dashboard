"use client";

import { Fragment, useMemo, useState } from "react";
import type { GpuHostAgent, HostLatest } from "@/lib/gpu-types";
import type {
  NormalizedDiskMetric,
  NormalizedNodeConditions,
} from "@/lib/gpu-report";
import {
  DESCENDING_FIRST_SORT_KEYS,
  hostReportStatus,
  indexHostsByName,
  isContainerPlumbingMount,
  isRamBackedMount,
  sortHostRows,
  worstAlertableDisk,
  type HostReportStatus,
  type HostRow,
  type HostSortKey,
  type SortDirection,
} from "@/lib/gpu-host-view";

const COLUMN_COUNT = 9;

const SORTABLE_COLUMNS: { key: HostSortKey; label: string }[] = [
  { key: "host", label: "Host" },
  { key: "gpuType", label: "GPU Type" },
  { key: "gpuUtil", label: "GPU Utilization" },
  { key: "gpuTemp", label: "GPU Temp" },
  { key: "gpuMemory", label: "Per-GPU Memory" },
  { key: "cpu", label: "CPU" },
  { key: "ram", label: "RAM" },
  { key: "disk", label: "Disk (worst)" },
  { key: "lastSeen", label: "Last Seen" },
];

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function formatTemperature(celsius: number | null): string {
  return celsius == null ? "—" : `${Math.round(celsius)}°C`;
}

function formatPower(drawW: number | null, limitW: number | null): string {
  if (drawW == null) return "—";
  const draw = `${Math.round(drawW)} W`;
  return limitW == null ? draw : `${draw} / ${Math.round(limitW)} W`;
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)} TB`;
  if (gib >= 1) return `${Math.round(gib)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatAgo(minutes: number): string {
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function HealthDot({ status }: { status: HostReportStatus }) {
  const color =
    status === "unreporting"
      ? "bg-red-500"
      : status === "stale"
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${color}`}
      title={status}
      aria-label={`Status: ${status}`}
    />
  );
}

function Meter({
  value,
  barClass,
}: {
  value: number;
  barClass?: string;
}) {
  const pct = Math.min(Math.max(value, 0), 100);
  return (
    <div className="flex min-w-28 items-center gap-2">
      <span className="w-10 tabular-nums">{Math.round(pct)}%</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full ${barClass ?? "bg-emerald-500 dark:bg-emerald-400"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function EmptyMetric() {
  return <span className="text-zinc-400">—</span>;
}

function RamBackedBadge() {
  return (
    <span className="shrink-0 rounded bg-violet-100 px-1 py-0.5 text-[10px] font-medium whitespace-nowrap text-violet-700 dark:bg-violet-900/40 dark:text-violet-400">
      RAM-backed
    </span>
  );
}

function mountLabel(disk: NormalizedDiskMetric): string {
  return disk.mount_point ?? disk.device ?? "unknown";
}

function DiskCell({ host }: { host: HostLatest | undefined }) {
  const worst = worstAlertableDisk(host?.disks ?? null);
  if (!worst) return <EmptyMetric />;
  const { disk, usedPct } = worst;
  return (
    <div className="flex items-center gap-2">
      <Meter
        value={usedPct}
        barClass={
          usedPct > 90
            ? "bg-red-500 dark:bg-red-400"
            : "bg-blue-500 dark:bg-blue-400"
        }
      />
      <span className="font-mono text-xs whitespace-nowrap text-zinc-400">
        {mountLabel(disk)}
        {isRamBackedMount(disk) && <RamBackedBadge />}
      </span>
    </div>
  );
}

function NodeConditionChips({
  conditions,
}: {
  conditions: NormalizedNodeConditions;
}) {
  return (
    <>
      {conditions.ready === null ? (
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          Ready: unknown
        </span>
      ) : conditions.ready ? (
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
          Ready
        </span>
      ) : (
        <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">
          NotReady
        </span>
      )}
      {conditions.disk_pressure && (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
          DiskPressure
        </span>
      )}
      {conditions.memory_pressure && (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
          MemoryPressure
        </span>
      )}
      {conditions.pid_pressure && (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
          PIDPressure
        </span>
      )}
      {conditions.unschedulable && (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
          Cordoned
        </span>
      )}
    </>
  );
}

function DiskDetail({ disks }: { disks: NormalizedDiskMetric[] | null }) {
  const visible = disks?.filter((disk) => !isContainerPlumbingMount(disk)) ?? [];
  const hiddenCount = (disks?.length ?? 0) - visible.length;
  if (visible.length === 0) {
    return (
      <p className="mt-1 text-xs text-zinc-400">No disk metrics reported.</p>
    );
  }
  return (
    <div className="mt-1 space-y-1.5">
      {visible.map((disk, index) => {
        const usedPct =
          disk.used_bytes != null &&
          disk.total_bytes != null &&
          disk.total_bytes > 0
            ? (disk.used_bytes / disk.total_bytes) * 100
            : null;
        const detail = [disk.device, disk.fstype, disk.role]
          .filter(Boolean)
          .join(" · ");
        return (
          <div key={`${mountLabel(disk)}-${index}`}>
            <div className="flex items-center gap-2">
              <div className="flex w-44 shrink-0 items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="truncate font-mono" title={mountLabel(disk)}>
                  {mountLabel(disk)}
                </span>
                {isRamBackedMount(disk) && <RamBackedBadge />}
              </div>
              {usedPct == null ? (
                <span className="text-xs text-red-600 dark:text-red-400">
                  {disk.error ?? "no usage reported"}
                </span>
              ) : (
                <>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div
                      className={`h-full rounded-full ${
                        usedPct > 90
                          ? "bg-red-500 dark:bg-red-400"
                          : "bg-blue-500 dark:bg-blue-400"
                      }`}
                      style={{ width: `${Math.min(usedPct, 100)}%` }}
                    />
                  </div>
                  <span className="w-28 shrink-0 whitespace-nowrap tabular-nums text-xs text-zinc-500 dark:text-zinc-400">
                    {Math.round(usedPct)}% of {formatBytes(disk.total_bytes!)}
                  </span>
                </>
              )}
            </div>
            <div className="mt-0.5 break-all text-[11px] text-zinc-400">{detail}</div>
          </div>
        );
      })}
      {hiddenCount > 0 && (
        <p className="text-xs text-zinc-400">
          {hiddenCount} container/pod {hiddenCount === 1 ? "mount" : "mounts"} hidden
        </p>
      )}
    </div>
  );
}

function HostDrillDown({ row, host }: { row: HostRow; host: HostLatest | undefined }) {
  return (
    <tr className="border-b border-zinc-100 dark:border-zinc-800/50">
      <td
        colSpan={COLUMN_COUNT}
        className="bg-zinc-50 px-5 py-4 dark:bg-zinc-900/40 sm:px-6"
      >
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          {host ? (
            <>
              <span className="whitespace-nowrap font-medium tabular-nums text-zinc-700 dark:text-zinc-200">
                {host.cpu_count != null && `${host.cpu_count} CPUs`}
                {host.cpu_count != null &&
                  host.ram_total_bytes != null &&
                  " · "}
                {host.ram_used_bytes != null &&
                  host.ram_total_bytes != null &&
                  `RAM ${formatBytes(host.ram_used_bytes)} / ${formatBytes(host.ram_total_bytes)}`}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  host.reporter_status === "ok"
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                }`}
              >
                reporter: {host.reporter_status}
              </span>
              {host.last_error && (
                <span className="font-mono text-red-600 dark:text-red-400">
                  last error: {host.last_error}
                </span>
              )}
              {host.node_conditions && (
                <NodeConditionChips conditions={host.node_conditions} />
              )}
            </>
          ) : (
            <span className="text-zinc-500 dark:text-zinc-400">
              No host-level metrics reported yet — the host reporter may not
              have rolled out to this machine.
            </span>
          )}
        </div>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div>
            <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
              Disks
            </div>
            <DiskDetail disks={host?.disks ?? null} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  <th className="py-1.5 pr-4 font-medium">GPU</th>
                  <th className="py-1.5 pr-4 font-medium">Utilization</th>
                  <th className="py-1.5 pr-4 font-medium">Memory</th>
                  <th className="py-1.5 font-medium">Temp</th>
                </tr>
              </thead>
              <tbody>
                {row.gpus.map((gpu) => {
                  const pct =
                    gpu.memTotalMb > 0
                      ? Math.round((gpu.memUsedMb / gpu.memTotalMb) * 100)
                      : 0;
                  return (
                    <tr
                      key={gpu.index}
                      className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50"
                    >
                      <td className="py-1.5 pr-4 font-medium">GPU {gpu.index}</td>
                      <td className="py-1.5 pr-4 tabular-nums">
                        {Math.round(gpu.gpuUtil)}%
                      </td>
                      <td className="py-1.5 pr-4 tabular-nums">
                        {formatMemory(gpu.memUsedMb)} /{" "}
                        {formatMemory(gpu.memTotalMb)} ({pct}%)
                      </td>
                      <td
                        className={`py-1.5 tabular-nums ${
                          gpu.temperatureC != null && gpu.temperatureC >= 85
                            ? "font-medium text-red-600 dark:text-red-400"
                            : ""
                        }`}
                      >
                        {formatTemperature(gpu.temperatureC)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </td>
    </tr>
  );
}

interface GpuHostTableProps {
  hostRows: HostRow[];
  hosts: HostLatest[];
  now: number;
  /** Buildkite agent (queue + running job) per GPU hostname, when matched. */
  agents?: Map<string, GpuHostAgent>;
  /** Test hook: render with this hostname's drill-down already expanded. */
  defaultExpanded?: string | null;
}

export function GpuHostTable({
  hostRows,
  hosts,
  now,
  agents,
  defaultExpanded = null,
}: GpuHostTableProps) {
  const [expanded, setExpanded] = useState<string | null>(defaultExpanded);
  const [sort, setSort] = useState<{ key: HostSortKey; direction: SortDirection }>({
    key: "host",
    direction: "asc",
  });
  const hostsByName = useMemo(() => indexHostsByName(hosts), [hosts]);
  const sortedRows = useMemo(
    () => sortHostRows(hostRows, hostsByName, sort.key, sort.direction),
    [hostRows, hostsByName, sort],
  );

  function toggleSort(key: HostSortKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: DESCENDING_FIRST_SORT_KEYS.has(key) ? "desc" : "asc" },
    );
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-none">
      <div className="flex min-h-14 items-center justify-between gap-4 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800 sm:px-6">
        <h2 className="text-lg font-semibold tracking-[-0.02em]">Host Summary</h2>
        <span className="text-sm tabular-nums text-zinc-500 dark:text-zinc-400">
          {hostRows.length} hosts · click a row for details
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1200px] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              {SORTABLE_COLUMNS.map((column) => {
                const active = sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    aria-sort={
                      active
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="px-5 py-3 font-medium sm:px-6"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className="dashboard-control -mx-2 -my-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                      title={`Sort by ${column.label}`}
                    >
                      {column.label}
                      <span
                        aria-hidden="true"
                        className={`text-xs ${active ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500"}`}
                      >
                        {active ? (sort.direction === "asc" ? "▲" : "▼") : "⇅"}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((h) => {
              const host = hostsByName.get(h.hostname);
              const agent = agents?.get(h.hostname);
              const gpuUtil =
                h.gpuCount > 0 ? Math.round(h.gpuUtil / h.gpuCount) : 0;
              const ago =
                now > 0
                  ? Math.round((now - new Date(h.lastSeen).getTime()) / 60_000)
                  : 0;
              const status = now > 0 ? hostReportStatus(ago) : "fresh";
              const unreporting = status === "unreporting";
              const stale = status !== "fresh";
              const isOpen = expanded === h.hostname;
              const ramPct =
                host?.ram_used_bytes != null &&
                host.ram_total_bytes != null &&
                host.ram_total_bytes > 0
                  ? (host.ram_used_bytes / host.ram_total_bytes) * 100
                  : null;
              return (
                <Fragment key={h.hostname}>
                  <tr
                    onClick={() => setExpanded(isOpen ? null : h.hostname)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setExpanded(isOpen ? null : h.hostname);
                      }
                    }}
                    tabIndex={0}
                    aria-expanded={isOpen}
                    className={`cursor-pointer border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-900/50 ${stale ? "opacity-50" : ""} ${isOpen ? "bg-zinc-50 dark:bg-zinc-900/50" : ""}`}
                  >
                    <td className="whitespace-nowrap px-5 py-3.5 font-medium sm:px-6">
                      <span className="mr-2 inline-flex">
                        <HealthDot status={status} />
                      </span>
                      {h.hostname}
                      {unreporting ? (
                        <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">
                          Unreporting
                        </span>
                      ) : status === "stale" ? (
                        <span className="ml-2 rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400">
                          Stale
                        </span>
                      ) : null}
                      <span className="ml-2 inline-block w-4 text-center text-base leading-none text-zinc-500 dark:text-zinc-400">
                        {isOpen ? "▾" : "▸"}
                      </span>
                      {(agent?.queues[0] || agent?.currentJob) && (
                        <div className="mt-0.5 whitespace-normal text-xs font-normal text-zinc-500 dark:text-zinc-400">
                          {agent.queues[0] ?? ""}
                          {agent.queues[0] && agent.currentJob ? " · " : ""}
                          {agent.currentJob &&
                            (agent.currentJob.url ? (
                              <a
                                href={agent.currentJob.url}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:underline"
                                onClick={(event) => event.stopPropagation()}
                              >
                                {agent.currentJob.label ??
                                  (agent.currentJob.buildNumber != null
                                    ? `#${agent.currentJob.buildNumber}`
                                    : "running job")}
                              </a>
                            ) : (
                              (agent.currentJob.label ?? "running job")
                            ))}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3.5 sm:px-6">{h.gpuType}</td>
                    <td className="px-5 py-3.5 sm:px-6">
                      <Meter value={gpuUtil} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 tabular-nums sm:px-6">
                      <span
                        className={
                          h.maxTemperatureC != null && h.maxTemperatureC >= 85
                            ? "font-medium text-red-600 dark:text-red-400"
                            : h.maxTemperatureC != null && h.maxTemperatureC >= 75
                              ? "font-medium text-yellow-600 dark:text-yellow-400"
                              : ""
                        }
                      >
                        {formatTemperature(h.maxTemperatureC)}
                      </span>
                      {h.maxTemperatureC != null && (
                        <span className="ml-1 text-xs text-zinc-400">max</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 sm:px-6">
                      <div className="flex items-end gap-1.5" style={{ height: 40 }}>
                        {h.gpus.map((gpu) => {
                          const pct = gpu.memTotalMb > 0 ? Math.round((gpu.memUsedMb / gpu.memTotalMb) * 100) : 0;
                          const barColor = pct > 90
                            ? "bg-red-500 dark:bg-red-400"
                            : pct > 60
                            ? "bg-blue-500 dark:bg-blue-400"
                            : "bg-blue-400 dark:bg-blue-500";
                          return (
                            <div
                              key={gpu.index}
                              className="group relative flex flex-col items-center"
                            >
                              <div
                                className="relative w-3 rounded-sm bg-zinc-100 dark:bg-zinc-800"
                                style={{ height: 40 }}
                              >
                                <div
                                  className={`absolute bottom-0 w-full rounded-sm ${barColor}`}
                                  style={{ height: `${Math.max(pct, 2)}%` }}
                                />
                              </div>
                              <div className="pointer-events-none absolute -top-14 left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap rounded border border-zinc-200 bg-white px-2 py-1 text-xs shadow-lg group-hover:block dark:border-zinc-700 dark:bg-zinc-900">
                                <span className="font-medium">GPU {gpu.index}</span>
                                <span className="ml-1 text-zinc-400">
                                  {formatMemory(gpu.memUsedMb)} / {formatMemory(gpu.memTotalMb)} ({pct}%)
                                </span>
                                <span className="block text-zinc-400">
                                  GPU utilization: {Math.round(gpu.gpuUtil)}%
                                </span>
                                <span className="block text-zinc-400">
                                  Temp: {formatTemperature(gpu.temperatureC)}
                                  {" · "}
                                  Power: {formatPower(gpu.powerDrawW, gpu.powerLimitW)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 sm:px-6">
                      {host?.cpu_util == null ? (
                        <EmptyMetric />
                      ) : (
                        <Meter
                          value={host.cpu_util}
                          barClass={
                            host.cpu_util > 85
                              ? "bg-red-500 dark:bg-red-400"
                              : "bg-sky-500 dark:bg-sky-400"
                          }
                        />
                      )}
                    </td>
                    <td className="px-5 py-3.5 sm:px-6">
                      {ramPct == null ? (
                        <EmptyMetric />
                      ) : (
                        <Meter
                          value={ramPct}
                          barClass={
                            ramPct > 90
                              ? "bg-red-500 dark:bg-red-400"
                              : "bg-violet-500 dark:bg-violet-400"
                          }
                        />
                      )}
                    </td>
                    <td className="px-5 py-3.5 sm:px-6">
                      <DiskCell host={host} />
                    </td>
                    <td
                      className={`whitespace-nowrap px-5 py-3.5 sm:px-6 ${
                        unreporting
                          ? "text-red-600 dark:text-red-400"
                          : stale
                            ? "text-yellow-600 dark:text-yellow-400"
                            : "text-zinc-500 dark:text-zinc-400"
                      }`}
                    >
                      {stale ? formatAgo(ago) : "just now"}
                    </td>
                  </tr>
                  {isOpen && <HostDrillDown row={h} host={host} />}
                </Fragment>
              );
            })}
            {hostRows.length === 0 && (
              <tr>
                <td
                  colSpan={COLUMN_COUNT}
                  className="px-5 py-12 text-center text-zinc-400"
                >
                  No GPU data found. Deploy the reporting script to start collecting metrics.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
