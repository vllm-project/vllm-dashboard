import assert from "node:assert/strict";
import test from "node:test";
import { filterRetryJobs, retryHistoryUrl, type RetryJob } from "./job-retry-ranking";

const jobs: RetryJob[] = [
  { name: ":nvidia: Basic Models", retries: 2, total_runs: 10, has_soft_fail: false },
  { name: "Ray Dependency Compatibility Check", retries: 4, total_runs: 8, has_soft_fail: false },
  { name: "Custom Soft Fail", retries: 3, total_runs: 7, has_soft_fail: true },
  { name: "Distributed Tests (4 GPUs)(A100)", retries: 5, total_runs: 9, has_soft_fail: false },
  { name: "Basic Correctness", retries: 0, total_runs: 6, has_soft_fail: false },
];

const noFilters = { searchQuery: "", hideSoftFail: false, hideOptional: false };

test("retry history keeps the selected source, all filters, exact window, and encoded job name", () => {
  const name = ":amd: kernel & model [a+b]";
  const url = new URL(retryHistoryUrl("/api/jobs/retries?pipeline=&branch=&window=14d", name, "otel"), "http://localhost");
  assert.equal(url.pathname, "/api/jobs/retries/runs");
  assert.equal(url.searchParams.get("pipeline"), "");
  assert.equal(url.searchParams.get("branch"), "");
  assert.equal(url.searchParams.get("window"), "14d");
  assert.equal(url.searchParams.get("jobName"), name);
  assert.equal(url.searchParams.get("source"), "otel");

  const exact = new URL(retryHistoryUrl("/api/jobs/retries?startDate=2026-09-23T10%3A00Z&endDate=2026-09-23T11%3A00Z", name), "http://localhost");
  assert.equal(exact.searchParams.get("startDate"), "2026-09-23T10:00Z");
  assert.equal(exact.searchParams.get("endDate"), "2026-09-23T11:00Z");
  assert.equal(exact.searchParams.has("window"), false);
});

test("retry ranking hides original-only jobs even when search matches them", () => {
  assert.deepEqual(filterRetryJobs(jobs, noFilters), jobs.slice(0, 4));
  assert.deepEqual(filterRetryJobs([jobs[4]], noFilters), []);
  assert.deepEqual(filterRetryJobs(jobs, { ...noFilters, searchQuery: "Basic Correctness" }), []);
});

test("job search is case-insensitive and does not modify fetched jobs", () => {
  const snapshot = structuredClone(jobs);
  assert.deepEqual(filterRetryJobs(jobs, { ...noFilters, searchQuery: "  BASIC MODELS  " }), [jobs[0]]);
  assert.deepEqual(filterRetryJobs(jobs, { ...noFilters, searchQuery: "missing" }), []);
  assert.deepEqual(jobs, snapshot);
});

test("soft-fail filtering recognizes declared and reported soft failures", () => {
  assert.deepEqual(filterRetryJobs(jobs, { ...noFilters, hideSoftFail: true }), [jobs[0], jobs[3]]);
});

test("optional and soft-fail exclusions compose with job search", () => {
  assert.deepEqual(filterRetryJobs(jobs, { ...noFilters, hideOptional: true }), jobs.slice(0, 3));
  assert.deepEqual(filterRetryJobs(jobs, {
    searchQuery: "basic", hideOptional: true, hideSoftFail: true,
  }), [jobs[0]]);
  assert.deepEqual(filterRetryJobs(jobs, {
    searchQuery: "distributed", hideOptional: true, hideSoftFail: false,
  }), []);
});

test("vendor search retains explicit icons, legacy AMD mirrors, and native device prefixes", () => {
  const hardwareJobs: RetryJob[] = [
    { name: ":amd: (MI355) Kernels", retries: 2, total_runs: 5, has_soft_fail: false },
    { name: "AMD: Kernel mirror", retries: 3, total_runs: 5, has_soft_fail: false },
    { name: "mi325_1: Kernel test", retries: 4, total_runs: 5, has_soft_fail: false },
    { name: ":nvidia: (H100) Kernels", retries: 1, total_runs: 5, has_soft_fail: false },
  ];
  assert.deepEqual(filterRetryJobs(hardwareJobs, { ...noFilters, searchQuery: "AMD" }), hardwareJobs.slice(0, 3));
  assert.deepEqual(filterRetryJobs(hardwareJobs, { ...noFilters, searchQuery: "nvidia" }), [hardwareJobs[3]]);
  assert.deepEqual(filterRetryJobs(hardwareJobs, { ...noFilters, searchQuery: "MI325" }), [hardwareJobs[2]]);
});
