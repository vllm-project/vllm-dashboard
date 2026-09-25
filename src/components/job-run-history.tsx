"use client";

import dynamic from "next/dynamic";
import useSWR from "swr";
import type { JobRun } from "@/components/job-runs-chart";

const JobRunsChart = dynamic(
  () => import("@/components/job-runs-chart").then((module) => module.JobRunsChart),
  { loading: () => <div role="status" className="flex h-48 items-center justify-center text-zinc-400">Loading chart...</div> },
);

interface RunsResponse {
  runs: JobRun[];
  error?: string;
}

async function fetchRuns(url: string): Promise<RunsResponse> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to load job run history");
  const result: RunsResponse = await response.json();
  if (result.error) throw new Error(result.error);
  return result;
}

export function JobRunHistory({ apiUrl, mode }: {
  apiUrl: string;
  mode: "failures" | "duration" | "retries";
}) {
  const { data, error, isLoading, mutate } = useSWR<RunsResponse>(apiUrl, fetchRuns);
  if (error) {
    return (
      <div role="alert" className="flex h-48 flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-600 dark:text-red-400">Failed to load job run history.</p>
        <button type="button" onClick={() => { void mutate(); }} className="min-h-11 rounded-md border border-zinc-200 px-3 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
          Try again
        </button>
      </div>
    );
  }
  return <JobRunsChart runs={data?.runs ?? []} mode={mode} loading={isLoading} />;
}
