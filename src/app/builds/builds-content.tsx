"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { StatCard } from "@/components/stat-card";
import { BuildChart, BuildDuration } from "@/components/build-chart";
import { BuildsTable, Build, type BuildsTableView } from "@/components/builds-table";
import { SearchableSelect } from "@/components/searchable-select";
import { MultiSelect } from "@/components/multi-select";
import { DateRangePicker } from "@/components/date-range-picker";
import { PageHeader } from "@/components/page-header";
import { ToggleSwitch } from "@/components/toggle-switch";
import { isoDate, useUrlState } from "@/lib/use-url-state";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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
  startedJobCountsByBuild: Record<string, number>;
  jobOptions: Array<{ name: string; group: string }>;
  error?: string;
}

const DEFAULTS = {
  pipeline: "CI",
  branch: "main",
  start: "",
  end: "",
  page: "0",
  groups: "",
  jobs: "",
  softfail: "",
  optional: "",
  outliers: "",
  view: "compact",
};

function splitList(value: string): Set<string> {
  return new Set(value.split(",").filter(Boolean));
}

function joinList(value: Set<string>): string {
  return [...value].join(",");
}

/** Daily pass rate and volume for the stat-card sparklines. */
function dailySeries(durations: BuildDuration[]) {
  const byDay = new Map<string, { total: number; failed: number }>();
  for (const build of durations) {
    const day = build.created_at.slice(0, 10);
    const entry = byDay.get(day) ?? { total: 0, failed: 0 };
    entry.total += 1;
    if (build.state === "failed" || build.state === "failing") entry.failed += 1;
    byDay.set(day, entry);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    total: days.map(([, d]) => d.total),
    failed: days.map(([, d]) => d.failed),
    passed: days.map(([, d]) => d.total - d.failed),
    passRate: days.map(([, d]) =>
      d.total > 0 ? Math.round(((d.total - d.failed) / d.total) * 100) : 0,
    ),
  };
}

export default function BuildsContent() {
  const [state, setState] = useUrlState(DEFAULTS);
  const pipeline = state.pipeline;
  const branch = state.branch;
  const startDate = state.start || isoDate(14);
  const endDate = state.end || isoDate(0);
  const page = Math.max(0, parseInt(state.page, 10) || 0);
  const hideSoftFail = state.softfail === "1";
  const hideOptional = state.optional === "1";
  const hideOutliers = state.outliers === "1";
  const selectedGroups = useMemo(() => splitList(state.groups), [state.groups]);
  const selectedJobs = useMemo(() => splitList(state.jobs), [state.jobs]);

  const params = new URLSearchParams();
  if (pipeline) params.set("pipeline", pipeline);
  if (branch) params.set("branch", branch);
  params.set("startDate", startDate);
  params.set("endDate", endDate);
  params.set("page", String(page));
  if (selectedJobs.size > 0) {
    params.set("jobNames", [...selectedJobs].join(","));
  } else if (selectedGroups.size > 0) {
    params.set("jobGroups", [...selectedGroups].join(","));
  }
  const apiUrl = `/api/builds?${params.toString()}`;

  const { data: filters } = useSWR<FiltersResponse>(
    "/api/builds/filters",
    fetcher,
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

  const buildIds = useMemo(() => buildRows.map((build) => build.id), [buildRows]);
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
      for (const g of build.testGroups ?? []) groups.add(g.group);
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

  const series = useMemo(() => dailySeries(buildDurations), [buildDurations]);

  if (isLoading && !data) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted">
        Loading builds...
      </div>
    );
  }

  if (error || data?.error) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-bad">
        Failed to load build data. Check Databricks connection.
      </div>
    );
  }

  const start = page * pagination.pageSize + 1;
  const end = Math.min((page + 1) * pagination.pageSize, summary.total);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Builds"
        actions={
          <>
            <SearchableSelect
              label="Pipeline"
              value={pipeline}
              onChange={(v) => setState({ pipeline: v, page: "0" })}
              options={filters?.pipelines ?? []}
              allLabel="All Pipelines"
            />
            <SearchableSelect
              label="Branch"
              value={branch}
              onChange={(v) => setState({ branch: v, page: "0" })}
              options={filters?.branches ?? []}
              allLabel="All Branches"
            />
            <DateRangePicker
              startDate={startDate}
              endDate={endDate}
              onChange={(s, e) => setState({ start: s, end: e, page: "0" })}
            />
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Total Builds" value={summary.total} trend={series.total} />
        <StatCard
          label="Pass Rate"
          value={`${summary.passRate}%`}
          color={
            summary.passRate >= 80
              ? "green"
              : summary.passRate >= 50
                ? "yellow"
                : "red"
          }
          trend={series.passRate}
          detail="daily, over the range"
        />
        <StatCard
          label="Passed"
          value={summary.passed}
          color="green"
          trend={series.passed}
        />
        <StatCard
          label="Failed"
          value={summary.failed}
          color="red"
          trend={series.failed}
        />
      </div>

      <BuildChart
        data={buildDurations}
        startDate={startDate}
        endDate={endDate}
        hideOutliers={hideOutliers}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row">
          <MultiSelect
            label="Job Groups"
            selected={selectedGroups}
            onChange={(v) => {
              let jobs = selectedJobs;
              if (v.size > 0) {
                jobs = new Set<string>();
                for (const option of groupData?.jobOptions ?? []) {
                  if (v.has(option.group) && selectedJobs.has(option.name)) {
                    jobs.add(option.name);
                  }
                }
              }
              setState({ groups: joinList(v), jobs: joinList(jobs), page: "0" });
            }}
            options={allGroupNames}
            placeholder="All Groups"
          />
          <MultiSelect
            label="Jobs"
            selected={selectedJobs}
            onChange={(v) => {
              const groups = new Set(selectedGroups);
              for (const name of v) {
                const group = jobToGroup.get(name);
                if (group) groups.add(group);
              }
              setState({ jobs: joinList(v), groups: joinList(groups), page: "0" });
            }}
            options={availableJobNames}
            placeholder="All Jobs"
          />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <ToggleSwitch
            label="Hide soft fail"
            checked={hideSoftFail}
            onToggle={() => setState({ softfail: hideSoftFail ? "" : "1" })}
          />
          <ToggleSwitch
            label="Hide optional"
            checked={hideOptional}
            onToggle={() => setState({ optional: hideOptional ? "" : "1" })}
          />
          <ToggleSwitch
            label="Hide outliers (≥6h)"
            checked={hideOutliers}
            onToggle={() => setState({ outliers: hideOutliers ? "" : "1" })}
          />
        </div>
      </div>

      <BuildsTable
        builds={builds}
        view={state.view === "matrix" ? "matrix" : "compact"}
        onViewChange={(view: BuildsTableView) => setState({ view })}
        jobNames={groupData?.jobNames ?? []}
        jobsByBuild={groupData?.jobsByBuild ?? {}}
        startedJobCountsByBuild={groupData?.startedJobCountsByBuild ?? {}}
        showBranch={!branch}
        hideSoftFail={hideSoftFail}
        hideOptional={hideOptional}
        selectedGroups={selectedGroups}
        selectedJobs={selectedJobs}
      />
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted">
            Showing {start}–{end} of {summary.total} builds
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setState({ page: String(Math.max(0, page - 1)) })}
              disabled={page === 0}
              className="dashboard-control min-h-10 rounded-md border border-line px-3 text-sm font-medium hover:bg-surface-muted disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Previous
            </button>
            <button
              onClick={() => setState({ page: String(page + 1) })}
              disabled={page + 1 >= pagination.totalPages}
              className="dashboard-control min-h-10 rounded-md border border-line px-3 text-sm font-medium hover:bg-surface-muted disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
