"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
  ReferenceLine,
} from "recharts";

export interface JobRun {
  job_id: string;
  web_url: string | null;
  state: string;
  started_at: string | null;
  finished_at: string | null;
  duration_secs: string | number | null;
  commit_sha: string | null;
  build_created_at?: string | null;
  is_retry?: boolean;
}

type ChartMode = "failures" | "duration" | "retries";

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

// Format for axis ticks — always round
function formatDurationRound(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (rm === 0) return `${h}h`;
  return `${h}h${rm}m`;
}

// Generate nice round tick values for a given max
function roundTicks(maxSecs: number): number[] {
  // Pick a nice interval
  const candidates = [
    10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
    5400, 7200, 10800, 14400, 18000, 21600,
  ]; // 10s, 15s, 30s, 1m, 2m, 5m, 10m, 15m, 30m, 1h, 1h30, 2h, 3h, 4h, 5h, 6h
  let interval = candidates[candidates.length - 1];
  for (const c of candidates) {
    if (maxSecs / c <= 6) {
      interval = c;
      break;
    }
  }
  const ticks: number[] = [0];
  let v = interval;
  while (v <= maxSecs * 1.05) {
    ticks.push(v);
    v += interval;
  }
  return ticks;
}

function isFailed(state: string): boolean {
  return ["failed", "failing", "broken", "timed_out"].includes(state);
}

interface ChartDataPoint {
  index: number;
  date: string;
  dateShort: string;
  duration: number;
  status: number; // Failure mode: 1 = passed, -1 = failed. Retry mode: 1 = retry, -1 = original.
  failed: boolean;
  retry: boolean;
  commit: string;
  webUrl: string | null;
  state: string;
}

export function jobRunChartData(runs: JobRun[], mode: ChartMode): ChartDataPoint[] {
  return runs.map((run, i) => {
    const failed = isFailed(run.state);
    const retry = run.is_retry === true;
    const timestamp = mode === "retries" ? run.started_at : run.build_created_at;
    const date = timestamp ? new Date(timestamp) : null;
    const validDate = date !== null && !Number.isNaN(date.getTime());
    return {
      index: i,
      date: validDate
        ? mode === "retries"
          ? date.toLocaleString(undefined, { timeZoneName: "short" })
          : date.toLocaleString()
        : "Start time unavailable",
      dateShort: validDate ? date.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "Unknown",
      duration: parseInt(String(run.duration_secs ?? 0), 10),
      status: mode === "retries" ? (retry ? 1 : -1) : (failed ? -1 : 1),
      failed,
      retry,
      commit: run.commit_sha?.slice(0, 7) ?? "",
      webUrl: run.web_url,
      state: run.state,
    };
  });
}

function RetryTooltipContent({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartDataPoint }> }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      <p className={`font-medium ${d.retry ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`}>
        {d.retry ? "Retry attempt" : "Original attempt"}
      </p>
      <p className="text-zinc-600 dark:text-zinc-300">Outcome: {d.state.replaceAll("_", " ")}</p>
      <p className="text-zinc-500">Started: {d.date}</p>
      <p className="font-mono text-zinc-400">{d.commit || "Commit unavailable"}</p>
    </div>
  );
}

function FailureTooltipContent({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartDataPoint }> }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      <p className={`font-medium ${d.failed ? "text-red-600" : "text-emerald-600"}`}>
        {d.failed ? "Failed" : "Passed"}
      </p>
      <p className="text-zinc-500">{d.date}</p>
      <p className="font-mono text-zinc-400">{d.commit}</p>
    </div>
  );
}

function DurationTooltipContent({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartDataPoint }> }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      <p className={`font-medium ${d.failed ? "text-red-600" : "text-emerald-600"}`}>
        {d.failed ? "Failed" : "Passed"} — {formatDuration(d.duration)}
      </p>
      <p className="text-zinc-500">{d.date}</p>
      <p className="font-mono text-zinc-400">{d.commit}</p>
    </div>
  );
}

export function JobRunsChart({
  runs,
  mode,
  loading,
}: {
  runs: JobRun[];
  mode: ChartMode;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-zinc-400">
        {mode === "retries" ? "Loading attempts..." : "Loading runs..."}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex h-20 items-center justify-center text-xs text-zinc-400">
        {mode === "retries" ? "No attempts found in this period" : "No runs found"}
      </div>
    );
  }

  const passCount = runs.filter((r) => !isFailed(r.state)).length;
  const failCount = runs.filter((r) => isFailed(r.state)).length;

  const data = jobRunChartData(runs, mode);
  const retryCount = data.filter((d) => d.retry).length;

  // Show ~8 date ticks evenly spaced
  const tickInterval = Math.max(1, Math.floor(data.length / 8));

  const handleClick = (d: ChartDataPoint) => {
    if (d.webUrl) window.open(d.webUrl, "_blank");
  };

  if (mode === "failures" || mode === "retries") {
    const retries = mode === "retries";
    return (
      <div className="space-y-2" role={retries ? "region" : undefined} aria-label={retries ? "Retry attempt history" : undefined}>
        <div className={`flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 ${retries ? "flex-wrap gap-x-4 gap-y-1" : ""}`}>
          <span>{runs.length} {retries ? "attempts" : "runs"}</span>
          {retries ? <span>
            <span className="text-amber-600 dark:text-amber-400">{retryCount} retries</span>
            {" / "}
            <span className="text-emerald-600 dark:text-emerald-400">{runs.length - retryCount} original attempts</span>
          </span> : <span>
            <span className="text-emerald-600 dark:text-emerald-400">{passCount} passed</span>
            {" / "}
            <span className="text-red-600 dark:text-red-400">{failCount} failed</span>
          </span>}
        </div>
        {retries && <p className="text-xs text-zinc-500 dark:text-zinc-400">Amber bars are retries; green bars are original attempts, regardless of outcome.{runs.some((run) => run.web_url) && " Click a linked bar to open Buildkite."}</p>}
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 10, right: 10, bottom: 5, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="index"
              tick={{ fontSize: 10 }}
              tickFormatter={(i: number) => data[i]?.dateShort ?? ""}
              interval={tickInterval}
              stroke="#71717a"
            />
            <YAxis
              domain={[-1.5, 1.5]}
              ticks={[-1, 1]}
              tickFormatter={(v: number) => (v === 1 ? (retries ? "Retry" : "Pass") : v === -1 ? (retries ? "Original" : "Fail") : "")}
              tick={{ fontSize: 10 }}
              stroke="#71717a"
              width={retries ? 50 : 35}
            />
            <Tooltip content={retries ? <RetryTooltipContent /> : <FailureTooltipContent />} cursor={{ fill: "rgba(113,113,122,0.1)" }} />
            <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="3 3" />
            <Bar dataKey="status" radius={[2, 2, 0, 0]} onClick={(_: unknown, idx: number) => handleClick(data[idx])}>
              {data.map((d, i) => (
                <Cell key={i} cursor={d.webUrl ? "pointer" : "default"} fill={retries ? (d.retry ? "#f59e0b" : "#10b981") : (d.failed ? "#ef4444" : "#10b981")} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Duration mode
  const maxDur = Math.max(...data.map((d) => d.duration), 1);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span>{runs.length} runs</span>
        <span>
          <span className="text-emerald-600 dark:text-emerald-400">{passCount} passed</span>
          {" / "}
          <span className="text-red-600 dark:text-red-400">{failCount} failed</span>
        </span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 10, right: 10, bottom: 5, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis
            dataKey="index"
            tick={{ fontSize: 10 }}
            tickFormatter={(i: number) => data[i]?.dateShort ?? ""}
            interval={tickInterval}
            stroke="#71717a"
          />
          <YAxis
            tick={{ fontSize: 10 }}
            tickFormatter={(v: number) => formatDurationRound(v)}
            stroke="#71717a"
            width={50}
            ticks={roundTicks(maxDur)}
            domain={[0, roundTicks(maxDur)[roundTicks(maxDur).length - 1] || maxDur]}
          />
          <Tooltip content={<DurationTooltipContent />} cursor={{ fill: "rgba(113,113,122,0.1)" }} />
          <Bar dataKey="duration" radius={[2, 2, 0, 0]} onClick={(_: unknown, idx: number) => handleClick(data[idx])}>
            {data.map((d, i) => (
              <Cell key={i} cursor={d.webUrl ? "pointer" : "default"} fill={d.failed ? "#ef4444" : "#10b981"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
