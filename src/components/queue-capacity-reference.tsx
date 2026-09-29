import {
  filterQueues,
  getQueueCapacity,
  QUEUE_CAPACITY,
  type QueueFamily,
  type QueueGroup,
} from "@/lib/queue-capacity";

interface QueueCapacityReferenceProps {
  group: QueueGroup;
  family: QueueFamily | "all";
  queue: string;
}

const numberFormatter = new Intl.NumberFormat("en-US");

function sourceQueueLabel(queue: string): string {
  return queue === "amd-cpu" ? "amd_cpu" : queue.replace(/^amd_mi/, "mi");
}

export function QueueCapacityReference({
  group,
  family,
  queue,
}: QueueCapacityReferenceProps) {
  const selectedQueue = queue
    ? getQueueCapacity(queue)?.allocations[0].queue
    : null;
  const inventory = filterQueues(QUEUE_CAPACITY, group);
  const rows = inventory.filter(
    (row) =>
      (family === "all" || row.family === family) &&
      (!queue || row.queue === selectedQueue),
  );
  const families = [...new Set(rows.map((row) => row.family))];
  const groupLabel =
    group === "rocm" ? "ROCm" : group === "cuda" ? "CUDA" : "All queues";

  return (
    <details className="group rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 rounded-xl px-5 py-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
          <svg
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform group-open:rotate-90"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="m6 3 5 5-5 5" />
          </svg>
          Configured capacity
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {groupLabel} view inventory · {rows.length}{" "}
          {rows.length === 1 ? "queue" : "queues"}
        </span>
      </summary>

      <div className="border-t border-zinc-100 px-5 pb-5 pt-4 dark:border-zinc-800">
        <p className="max-w-4xl text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          These configured limits are concurrent jobs. Historical load uses the
          current limits; earlier limit changes are not available.
        </p>

        {families.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">
              GPUs by family · {groupLabel} view inventory
            </p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {families.map((name) => {
                const allocations = inventory.filter(
                  (row) => row.family === name,
                );
                const gpuAllocations = allocations.filter(
                  (row) => row.gpuCount !== null,
                );
                const missingGpuAllocations = allocations.filter(
                  (row) => row.gpuCount === null,
                );
                const gpuCount = gpuAllocations.reduce(
                  (sum, row) => sum + row.gpuCount!,
                  0,
                );
                return (
                  <div
                    key={name}
                    className="rounded-lg bg-zinc-50 px-3.5 py-3 dark:bg-zinc-900/70"
                  >
                    <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
                      {name === "AMD CPU" ? "MI250-CPU" : name}
                    </p>
                    <p className="mt-2 text-2xl font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                      {gpuAllocations.length > 0
                        ? numberFormatter.format(gpuCount)
                        : "—"}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {missingGpuAllocations.length > 0 ? "Known GPUs" : "GPUs"}
                    </p>
                    {missingGpuAllocations.length > 0 && (
                      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                        GPU count not configured for{" "}
                        {missingGpuAllocations
                          .map((row) => sourceQueueLabel(row.queue))
                          .join(", ")}
                        .
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {rows.length > 0 ? (
          <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">
                Configured queue capacity
                {queue
                  ? ` for ${queue}`
                  : family === "all"
                    ? ""
                    : ` for ${family}`}
              </caption>
              <thead className="border-b border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                <tr>
                  <th
                    scope="col"
                    className="whitespace-nowrap px-3 py-2.5 font-medium"
                  >
                    Queue / family
                  </th>
                  <th
                    scope="col"
                    className="whitespace-nowrap px-3 py-2.5 text-right font-medium"
                  >
                    Max in flight
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const sourceLabel = sourceQueueLabel(row.queue);
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/70"
                    >
                      <th scope="row" className="px-3 py-2.5 font-normal">
                        <span className="block font-medium text-zinc-700 dark:text-zinc-200">
                          {sourceLabel}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-zinc-400">
                          {row.family === "AMD CPU" ? "MI250-CPU" : row.family}
                          {sourceLabel !== row.queue && ` · ${row.queue}`}
                        </span>
                      </th>
                      <td className="px-3 py-2.5 text-right font-medium tabular-nums text-zinc-700 dark:text-zinc-200">
                        {numberFormatter.format(row.maxInFlight)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 rounded-lg bg-zinc-50 px-4 py-3 text-xs text-zinc-500 dark:bg-zinc-900/70 dark:text-zinc-400">
            No supplied capacity limit for{" "}
            {queue || (family === "all" ? "this selection" : family)}.
          </p>
        )}

        <p className="mt-4 max-w-4xl text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          Load compares observed running jobs with their configured limits.
          {" "}GPU counts use each queue’s configured allocation.
          {group === "rocm" &&
            " Queues excluded from the ROCm view are also excluded from this inventory and its GPU counts."}
        </p>
      </div>
    </details>
  );
}
