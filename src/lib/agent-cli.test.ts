import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createClient, parseCommand, readTrace, run } from "../../public/agents/cli.mjs";
import { compactGpuSummary, parseGpuEvents } from "./job-gpu";

const job = "01a0932d-c77c-43cd-a431-2b4587aff590";

test("CLI rejects misspelled or inapplicable arguments before making requests", () => {
  for (const args of [['queues', '--failed'], ['build', '123', '--limit', '-1'], ['gpu', '123', '--by-test', '--by-command'], ['trace', '123', '--job', 'not-uuid'], ['failures', '--branch', 'main'], ['build', '123', 'extra'], ['queues', '--pipeline', 'private']]) {
    assert.throws(() => parseCommand(args));
  }
  assert.equal((parseCommand(['gpu', '123', '--test', 'tests/a.py::test_a[x]']).values as Record<string, unknown>).test, 'tests/a.py::test_a[x]');
});

test("generic get cannot invoke mutating GET/cron routes or escape the origin", async () => {
  let calls = 0;
  const client = createClient('https://ci.vllm.ai', async () => { calls++; return Response.json({ ok: true }); });
  for (const path of ['/api/alerts/queue', '/api/cron/poll-metrics', '//evil.example/api/jobs', 'https://evil.example/api/jobs', '/api/queue/jobs/reprioritize', '/api/gpu/report']) {
    await assert.rejects(client(path), /read-only/);
  }
  assert.equal(calls, 0);
  assert.throws(() => createClient('http://example.com'), /HTTPS/);
  assert.throws(() => createClient('https://user:password@ci.vllm.ai'), /credentials/);
  await client('/api/metrics?hours=1');
  assert.equal(calls, 1);
});

test("client returns actionable API errors and respects redirect boundary", async () => {
  const client = createClient('http://localhost:3012', async (_url: unknown, options?: RequestInit) => {
    assert.equal(options?.redirect, 'error');
    return Response.json({ error: 'Pipeline not enabled' }, { status: 403 });
  });
  await assert.rejects(client('/api/agent/build'), /403.*Pipeline not enabled/);
});

test("trace follows all job pages and deduplicates span IDs", async () => {
  const pages: number[] = [];
  const result = await readTrace(async (_path: unknown, params: Record<string, unknown>) => {
    const page = params.page as number; pages.push(page);
    return { lanes: [{ id: 'same' }, { id: `page-${page}` }], truncated: page === 0, nextPage: page === 0 ? 1 : null };
  }, { buildNumber: '1' }, job);
  assert.deepEqual(pages, [0, 1]);
  assert.equal(result.lanes.length, 3);
  assert.equal(result.truncated, false);
  await assert.rejects(readTrace(async () => ({ lanes: [], truncated: true, nextPage: 0 }), {}, job), /repeated/);
});

test("trace caps pages and never erases incompleteness", async () => {
  let calls = 0;
  const result = await readTrace(async () => ({ lanes: [], truncated: true, nextPage: ++calls }), {}, job);
  assert.equal(calls, 20); assert.equal(result.truncated, true); assert.equal(result.nextPage, 20);
});

test("GPU CLI selects exact parameterized test intervals, keeps missing readings and pagination", async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await run(['gpu', '88448', '--job', job, '--test', 'a.py::test_x[2]'], async (path: string, params: Record<string, unknown>) => {
    if (path.endsWith('/trace')) return { truncated: false, nextPage: null, lanes: [
      { id: 'a', jobId: job, kind: 'test', label: 'a.py::test_x[1]', startTime: 'first', endTime: 'second' },
      { id: 'b', jobId: job, kind: 'test', label: 'a.py::test_x[2]', startTime: 'second', endTime: 'third' },
    ] };
    calls.push(params);
    return { available: false, devices: [], truncated: false };
  });
  assert.equal(calls.length, 1); assert.equal(calls[0].start, 'second'); assert.equal(calls[0].end, 'third');
  assert.equal(calls[0].summary, 1);
  assert.equal(result.intervals[0].available, false);
  assert.equal(result.nextOffset, null);
});

test("GPU CLI bounds fanout and interval output while propagating truncation", async () => {
  let running = 0, peak = 0;
  const result = await run(['gpu', '1', '--job', job, '--by-test', '--limit', '5'], async (path: string) => {
    if (path.endsWith('/trace')) return { truncated: false, nextPage: null, lanes: Array.from({ length: 8 }, (_, i) => ({ id: String(i), jobId: job, kind: 'test', startTime: 'a', endTime: 'b' })) };
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 5)); running--;
    return { available: true, truncated: true, devices: [] };
  });
  assert.equal(result.intervals.length, 5); assert.equal(result.nextOffset, 5); assert.equal(result.truncated, true); assert.ok(peak <= 4);
});

test("no telemetry is not reported as zero utilization", async () => {
  const result = await run(['gpu', '1'], async () => ({ lanes: [], truncated: false, nextPage: null }));
  assert.equal(result.available, false); assert.match(result.reason, /does not prove/);
});

test("compact GPU summaries preserve measured zero, unsupported metrics, and coverage", () => {
  const events = [0, 2000].map(ms => ({ name: 'ci.gpu.sample', timeUnixNano: String(ms * 1e6), attributes: {
    'gpu.uuid': 'a', 'gpu.index': 0, 'gpu.utilization': 0, 'gpu.memory.used': 0,
  } }));
  const samples = parseGpuEvents(events, 0, 4000);
  const summary = compactGpuSummary(samples, 0, 4000, 1000)[0];
  assert.equal(summary.meanUtilizationPercent, 0); assert.equal(summary.peakMemoryBytes, 0); assert.equal(summary.utilizationCoverage, 0.5);
  assert.equal('samples' in summary, false);
  const unknown = compactGpuSummary(samples.map(s => ({ ...s, utilization: null, memoryUsedBytes: null })), 0, 4000, 1000)[0];
  assert.equal(unknown.meanUtilizationPercent, null); assert.equal(unknown.peakMemoryBytes, null); assert.equal(unknown.utilizationCoverage, 0);
  assert.deepEqual(compactGpuSummary([], 0, 4000, 1000), []);
});

test("published discovery files and OpenAPI references stay usable", () => {
  const spec = JSON.parse(readFileSync('public/agents/openapi.json', 'utf8'));
  assert.equal(spec.openapi, '3.1.0');
  for (const path of ['/api/agent/build', '/api/agent/builds', '/api/agent/queues', '/api/agent/failures', '/api/builds/trace', '/api/builds/gpu']) assert.ok(spec.paths[path].get);
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref') {
        const resolved = String(child).slice(2).split('/').reduce((value, part) => value?.[part], spec);
        assert.ok(resolved, `unresolved ${child}`);
      }
      else walk(child);
    }
  };
  walk(spec);
  assert.match(readFileSync('public/llms.txt', 'utf8'), /https:\/\/ci.vllm.ai\/agents.md/);
  assert.match(readFileSync('public/agents.md', 'utf8'), /agents\/cli.mjs/);
});

test("paged job summaries count combined tests and retain the newest receipt time", async () => {
  const result = await readTrace(async (_path: unknown, params: Record<string, unknown>) => ({
    lanes: [{ id: `test-${params.page}`, kind: 'test' }],
    truncated: params.page === 0, nextPage: params.page === 0 ? 1 : null,
    summary: { testCount: 1, latestReceivedAt: params.page === 0 ? '2026-09-12T10:00:00Z' : '2026-09-12T09:00:00Z' },
  }), {}, job);
  assert.equal(result.summary.testCount, 2);
  assert.equal(result.summary.latestReceivedAt, '2026-09-12T10:00:00.000Z');
});

test("submillisecond test spans stay unknown without failing the entire GPU query", async () => {
  const result = await run(['gpu', '1', '--job', job, '--by-test'], async (path: string) => {
    assert.ok(path.endsWith('/trace'), 'zero-width interval must not request GPU samples');
    return { truncated: false, nextPage: null, lanes: [{ id: 'tiny', jobId: job, kind: 'test', startTime: '2026-09-12T10:00:00Z', endTime: '2026-09-12T10:00:00Z' }] };
  });
  assert.equal(result.intervals[0].available, false);
  assert.match(result.intervals[0].note, /timestamp resolution/);
});
