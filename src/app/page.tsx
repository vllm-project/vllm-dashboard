"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { StatCard } from "@/components/stat-card";
import { BuildChart, BuildDuration } from "@/components/build-chart";
import { BuildsTable, Build } from "@/components/builds-table";
import { SearchableSelect } from "@/components/searchable-select";
import { MultiSelect } from "@/components/multi-select";
import { DateRangePicker } from "@/components/date-range-picker";
import { isOptionalJob, isSoftFailJob } from "@/lib/optional-jobs";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

interface BuildsResponse {
  builds: Build[];
  buildDurations: BuildDuration[];
  summary: { total: number; passed: number; failed: number; passRate: number };
  pagination: { page: number; pageSize: number; totalPages: number };
  error?: string;
}

interface FiltersResponse {
  pipelines: string[];
  branches: string[];
  error?: string;
}

export default function BuildsPage() {
  const [pipeline, setPipeline] = useState("CI");
  const [branch, setBranch] = useState("main");
  const [startDate, setStartDate] = useState(daysAgo(14));
  const [endDate, setEndDate] = useState(today());
  const [page, setPage] = useState(0);
  const [hideSoftFail, setHideSoftFail] = useState(false);
  const [hideOptional, setHideOptional] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(new Set());

  const params = new URLSearchParams();
  if (pipeline) params.set("pipeline", pipeline);
  if (branch) params.set("branch", branch);
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  params.set("page", String(page));
  if (selectedGroups.size > 0) params.set("jobGroups", [...selectedGroups].join(","));
  if (selectedJobs.size > 0) params.set("jobNames", [...selectedJobs].join(","));
  const queryString = params.toString();
  const apiUrl = `/api/builds?${queryString}`;

  const { data: filters } = useSWR<FiltersResponse>(
    "/api/builds/filters",
    fetcher
  );

  const { data, error, isLoading } = useSWR<BuildsResponse>(apiUrl, fetcher, {
    refreshInterval: 5 * 60 * 1000,
  });

  const {
    builds = [],
    buildDurations = [],
    summary = { total: 0, passed: 0, failed: 0, passRate: 0 },
    pagination = { page: 0, pageSize: 50, totalPages: 0 },
  } = data ?? {};

  const allGroupNames = useMemo(() => {
    const groups = new Set<string>();
    for (const build of builds) {
      for (const g of build.testGroups ?? []) {
        groups.add(g.group);
      }
    }
    return [...groups].sort();
  }, [builds]);

  const jobToGroup = useMemo(() => {
    const map = new Map<string, string>();
    for (const build of builds) {
      for (const g of build.testGroups ?? []) {
        for (const j of g.jobs) {
          if (!map.has(j.name)) map.set(j.name, g.group);
        }
      }
    }
    return map;
  }, [builds]);

  const availableJobNames = useMemo(() => {
    const jobs = new Set<string>();
    const groupFilter = selectedGroups.size > 0 ? selectedGroups : null;
    for (const build of builds) {
      for (const g of build.testGroups ?? []) {
        if (groupFilter && !groupFilter.has(g.group)) continue;
        for (const j of g.jobs) jobs.add(j.name);
      }
    }
    return [...jobs].sort();
  }, [builds, selectedGroups]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-zinc-400">
        Loading builds...
      </div>
    );
  }

  if (error || data?.error) {
    return (
      <div className="flex h-64 items-center justify-center text-red-400">
        Failed to load build data. Check Databricks connection.
      </div>
    );
  }

  const start = page * pagination.pageSize + 1;
  const end = Math.min((page + 1) * pagination.pageSize, summary.total);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">Builds</h1>
        <div className="flex gap-3">
          <SearchableSelect
            label="Pipeline"
            value={pipeline}
            onChange={(v) => { setPipeline(v); setPage(0); }}
            options={filters?.pipelines ?? []}
            allLabel="All Pipelines"
          />
          <SearchableSelect
            label="Branch"
            value={branch}
            onChange={(v) => { setBranch(v); setPage(0); }}
            options={filters?.branches ?? []}
            allLabel="All Branches"
          />
          <DateRangePicker
            startDate={startDate}
            endDate={endDate}
            onChange={(s, e) => {
              setStartDate(s);
              setEndDate(e);
              setPage(0);
            }}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Builds" value={summary.total} />
        <StatCard
          label="Pass Rate"
          value={`${summary.passRate}%`}
          color={summary.passRate >= 80 ? "green" : summary.passRate >= 50 ? "yellow" : "red"}
        />
        <StatCard label="Passed" value={summary.passed} color="green" />
        <StatCard label="Failed" value={summary.failed} color="red" />
      </div>

      <BuildChart data={buildDurations} startDate={startDate} endDate={endDate} />

      <div className="flex items-end justify-between gap-4">
        <div className="flex gap-3">
          <MultiSelect
            label="Job Groups"
            selected={selectedGroups}
            onChange={(v) => {
              setSelectedGroups(v);
              setPage(0);
              setSelectedJobs((prev) => {
                if (v.size === 0) return prev;
                const valid = new Set<string>();
                for (const build of builds) {
                  for (const g of build.testGroups ?? []) {
                    if (!v.has(g.group)) continue;
                    for (const j of g.jobs) {
                      if (prev.has(j.name)) valid.add(j.name);
                    }
                  }
                }
                return valid;
              });
            }}
            options={allGroupNames}
            placeholder="All Groups"
          />
          <MultiSelect
            label="Jobs"
            selected={selectedJobs}
            onChange={(v) => {
              setSelectedJobs(v);
              setPage(0);
              const groups = new Set(selectedGroups);
              for (const name of v) {
                const group = jobToGroup.get(name);
                if (group) groups.add(group);
              }
              if (groups.size !== selectedGroups.size) setSelectedGroups(groups);
            }}
            options={availableJobNames}
            placeholder="All Jobs"
          />
        </div>
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={hideSoftFail}
              onChange={(e) => setHideSoftFail(e.target.checked)}
              className="rounded border-zinc-300"
            />
            Hide soft fail
          </label>
          <label className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={hideOptional}
              onChange={(e) => setHideOptional(e.target.checked)}
              className="rounded border-zinc-300"
            />
            Hide optional
          </label>
        </div>
      </div>

      <BuildsTable builds={builds} showBranch={!branch} hideSoftFail={hideSoftFail} hideOptional={hideOptional} selectedGroups={selectedGroups} selectedJobs={selectedJobs} />
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Showing {start}–{end} of {summary.total} builds
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-zinc-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page + 1 >= pagination.totalPages}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-zinc-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
