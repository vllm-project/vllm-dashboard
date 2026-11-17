"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { fetchJson } from "@/lib/fetch-json";
import { DEFAULT_PIPELINE, getPipeline, pipelineHref } from "@/lib/pipeline-navigation";

export function PipelineSelect() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pipeline = getPipeline(searchParams);
  const { data } = useSWR<{ pipelines: string[] }>("/api/builds/filters", fetchJson);
  // Keep direct links usable while options load, including on an API failure.
  const options = [...new Set([DEFAULT_PIPELINE, pipeline, ...(data?.pipelines ?? [])])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  return (
    <select
      aria-label="Pipeline"
      title={`Pipeline: ${pipeline || "All pipelines"}`}
      value={pipeline}
      onChange={(event) => {
        const href = `${pathname}?${searchParams}${window.location.hash}`;
        router.push(pipelineHref(href, event.target.value), { scroll: false });
      }}
      className="dashboard-control min-h-10 min-w-0 max-w-36 rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 sm:max-w-44"
    >
      <option value="">All pipelines</option>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}
