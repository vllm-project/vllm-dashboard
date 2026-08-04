"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { StatCard } from "@/components/stat-card";
import { BuildChart, BuildDuration } from "@/components/build-chart";
import { BuildsTable, Build } from "@/components/builds-table";
import { SearchableSelect } from "@/components/searchable-select";
import { MultiSelect } from "@/components/multi-select";
import { DateRangePicker } from "@/components/date-range-picker";

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

interface BuildGroupsResponse {
  groupsByBuild: Record<
    string,
    Array<{
      group: string;
      state: "passed" | "failed" | "running" | "blocked";
      passed: number;
      failed: number;
      running: number;
      blocked: number;
      total: number;
      failedJobs?: Array<{ name: string; web_url: string }>;
    }>
  >;
  jobNames: string[];
  jobsByBuild: Record<
    string,
    Record<string, Array<[nameIndex: number, state: string]>>
  >;
  jobOptions: Array<{ name: string; group: string }>;
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
  if (selectedJobs.size > 0) {
    params.set("jobNames", [...selectedJobs].join(","));
  } else if (selectedGroups.size > 0) {
    params.set("jobGroups", [...selectedGroups].join(","));
  }
  const queryString = params.toString();
  const apiUrl = `/api/builds?${queryString}`;

  const { data: filters } = useSWR<FiltersResponse>(
    "/api/builds/filters",
    fetcher
  );

  const { data, error, isLoading } = useSWR<BuildsResponse>(apiUrl, fetcher, {
    refreshInterval: 5 * 60 * 1000,
    keepPreviousData: true,
  });

  const {
    builds: buildRows = [],
    buildDurations = [],
    summary = { total: 0, passed: 0, failed: 0, passRate: 0 },
    pagination = { page: 0, pageSize: 50, totalPages: 0 },
  } = data ?? {};

  const buildIds = useMemo(
    () => buildRows.map((build) => build.id),
    [buildRows],
  );
  const groupsUrl =
    buildIds.length > 0
      ? `/api/builds/groups?buildIds=${encodeURIComponent(buildIds.join(","))}`
      : null;
  const { data: groupData } = useSWR<BuildGroupsResponse>(groupsUrl, fetcher, {
    refreshInterval: 5 * 60 * 1000,
    keepPreviousData: true,
  });

  const builds = useMemo(
    () =>
      buildRows.map((build) => ({
        ...build,
        testGroups: (groupData?.groupsByBuild[build.id] ?? []).map((group) => ({
          ...group,
          jobs: [],
        })),
      })),
    [buildRows, groupData?.groupsByBuild],
  );

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
    for (const option of groupData?.jobOptions ?? []) {
      map.set(option.name, option.group);
    }
    return map;
  }, [groupData?.jobOptions]);

  const availableJobNames = useMemo(() => {
    const groupFilter = selectedGroups.size > 0 ? selectedGroups : null;
    return (groupData?.jobOptions ?? [])
      .filter((option) => !groupFilter || groupFilter.has(option.group))
      .map((option) => option.name);
  }, [groupData?.jobOptions, selectedGroups]);

  if (isLoading && !data) {
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

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="flex min-w-0 gap-3">
          <MultiSelect
            label="Job Groups"
            selected={selectedGroups}
            onChange={(v) => {
              setSelectedGroups(v);
              setPage(0);
              setSelectedJobs((prev) => {
                if (v.size === 0) return prev;
                const valid = new Set<string>();
                for (const option of groupData?.jobOptions ?? []) {
                  if (v.has(option.group) && prev.has(option.name)) {
                    valid.add(option.name);
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
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <label className="flex min-h-11 items-center gap-2 text-xs text-zinc-500 sm:min-h-10 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={hideSoftFail}
              onChange={(e) => setHideSoftFail(e.target.checked)}
              className="rounded border-zinc-300"
            />
            Hide soft fail
          </label>
          <label className="flex min-h-11 items-center gap-2 text-xs text-zinc-500 sm:min-h-10 dark:text-zinc-400">
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

      <BuildsTable
        builds={builds}
        jobNames={groupData?.jobNames ?? []}
        jobsByBuild={groupData?.jobsByBuild ?? {}}
        showBranch={!branch}
        hideSoftFail={hideSoftFail}
        hideOptional={hideOptional}
        selectedGroups={selectedGroups}
        selectedJobs={selectedJobs}
      />
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Showing {start}–{end} of {summary.total} builds
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="min-h-11 rounded-md border border-zinc-200 px-3 text-sm font-medium transition-colors hover:bg-zinc-100 active:scale-[0.98] disabled:opacity-40 disabled:hover:bg-transparent sm:min-h-10 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page + 1 >= pagination.totalPages}
              className="min-h-11 rounded-md border border-zinc-200 px-3 text-sm font-medium transition-colors hover:bg-zinc-100 active:scale-[0.98] disabled:opacity-40 disabled:hover:bg-transparent sm:min-h-10 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
