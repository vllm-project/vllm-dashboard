#!/usr/bin/env node
// Downloadable, dependency-free Node 20+ client. GET requests only.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const HELP = `vllm-ci — read-only CI queries (Node 20+). JSON goes to stdout.
Guide: https://ci.vllm.ai/agents.md

  node cli.mjs builds [--branch main] [--state failed] [--limit 20] [--page 1]
  node cli.mjs build 88448 [--failed] [--attempts all] [--limit 100] [--offset 0]
  node cli.mjs failures [--status open|resolved|all] [--limit 20] [--offset 0]
  node cli.mjs queues [--queue l4-k8s]
  node cli.mjs queue-jobs --queue l4-k8s
  node cli.mjs trace 88448 [--job UUID] [--failed]
  node cli.mjs gpu 88448 [--job UUID] [--by-test | --by-command] [--test EXACT_NODEID]
                        [--limit 20] [--offset 0]
  node cli.mjs get '/api/jobs?pipeline=CI&branch=main&window=7d'

Global: --base-url URL (or VLLM_CI_BASE_URL), --pipeline ci, --organization vllm,
        --json (default), --help.
Read nextPage/nextOffset and truncated; pages are bounded, never silently complete.
Errors are JSON on stderr, exit 1. Failed CI jobs are successful queries, exit 0.
`;

const valueOptions = ['base-url', 'pipeline', 'organization', 'branch', 'state', 'commit', 'limit', 'page', 'offset', 'status', 'attempts', 'job', 'test', 'queue'];
const flagOptions = ['json', 'help', 'failed', 'by-test', 'by-command'];
const commandOptions = {
  builds: ['branch', 'state', 'commit', 'limit', 'page'], build: ['failed', 'attempts', 'limit', 'offset'],
  failures: ['status', 'limit', 'offset'], queues: ['queue'], 'queue-jobs': ['queue'],
  trace: ['job', 'failed'], gpu: ['job', 'by-test', 'by-command', 'test', 'limit', 'offset'], get: [],
};
const readPaths = new Set([
  '/api/builds', '/api/builds/summary', '/api/builds/jobs', '/api/builds/groups', '/api/builds/filters',
  '/api/builds/trace', '/api/builds/gpu', '/api/jobs', '/api/jobs/runs', '/api/tests', '/api/queue',
  '/api/queue/jobs', '/api/metrics', '/api/metrics/waiting-builds', '/api/gpu', '/api/gpu/latest',
  '/api/gpu/history', '/api/gpu/agents', '/api/alerts/main-ci', '/api/alerts/fast-ci', '/api/alerts/infra',
  '/api/cost', '/api/perf', '/api/perf/filters', '/api/eval', '/api/eval/filters', '/api/eval/samples', '/api/compare',
  '/api/agent/build', '/api/agent/builds', '/api/agent/failures', '/api/agent/queues',
]);

export function parseCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: Object.fromEntries([...valueOptions.map(k => [k, { type: 'string' }]), ...flagOptions.map(k => [k, { type: 'boolean' }])]) });
  if (values.help || !positionals.length) return { help: true };
  const [command, target] = positionals;
  if (!Object.hasOwn(commandOptions, command)) throw new Error(`Unknown command ${command}. Use --help.`);
  const allowed = new Set([...commandOptions[command], 'base-url', 'json', 'help',
    ...(['build', 'builds', 'trace', 'gpu'].includes(command) ? ['pipeline', 'organization'] : [])]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`--${key} does not apply to ${command}`);
  const needsTarget = ['build', 'trace', 'gpu', 'get'].includes(command);
  if (positionals.length !== (needsTarget ? 2 : 1)) throw new Error(`Unexpected or missing arguments for ${command}. Use --help.`);
  if (needsTarget && command !== 'get' && !/^\d{1,12}$/.test(target)) throw new Error('Build must be a numeric Buildkite build number');
  if (values['by-test'] && values['by-command']) throw new Error('Choose --by-test or --by-command');
  if (values.test && values['by-command']) throw new Error('--test cannot be combined with --by-command');
  for (const key of ['page', 'limit', 'offset']) {
    if (values[key] !== undefined && (!/^\d+$/.test(values[key]) || Number(values[key]) < (key === 'offset' ? 0 : 1))) throw new Error(`Invalid --${key}`);
  }
  if (command === 'gpu' && Number(values.limit ?? 20) > 100) throw new Error('GPU --limit cannot exceed 100');
  if (values.job && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.job)) throw new Error('Invalid --job UUID');
  if (values.attempts && values.attempts !== 'all') throw new Error('--attempts must be all');
  if (command === 'queue-jobs' && !values.queue) throw new Error('queue-jobs requires --queue');
  return { command, target, values };
}

export function createClient(base, fetcher = fetch) {
  const origin = new URL(base);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Base URL must be an origin without credentials, path, or query');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Use HTTPS, or HTTP for localhost');
  return async (path, params = {}) => {
    const url = new URL(path, origin);
    if (!path.startsWith('/api/') || url.origin !== origin.origin || !readPaths.has(url.pathname)) throw new Error('Only documented read-only API paths are allowed. Read /agents.md.');
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetcher(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const detail = typeof body?.error === 'string' ? `: ${body.error.slice(0, 500)}` : '';
      throw new Error(`HTTP ${response.status} from ${url.pathname}${detail}${response.headers.get('Retry-After') ? `; retry after ${response.headers.get('Retry-After')} seconds` : ''}`);
    }
    const data = await response.json();
    if (data.error) throw new Error(typeof data.error === 'string' ? data.error : 'API returned an error');
    return data;
  };
}

export async function readTrace(get, identity, job) {
  const lanes = new Map();
  const received = [];
  let result;
  let page = 0;
  const seen = new Set();
  for (let count = 0; count < 20; count++) {
    if (seen.has(page)) throw new Error('Trace pagination repeated a page');
    seen.add(page);
    result = await get('/api/builds/trace', { ...identity, ...(job ? { jobId: job } : {}), page });
    if (!Array.isArray(result.lanes)) throw new Error('Invalid trace response');
    for (const lane of result.lanes) lanes.set(lane.id, lane);
    const time = Date.parse(result.summary?.latestReceivedAt);
    if (Number.isFinite(time)) received.push(time);
    // Build overview has a hard cap; only job details support pagination.
    if (!job || result.nextPage === null || result.nextPage === undefined) break;
    page = result.nextPage;
  }
  const combined = [...lanes.values()];
  return { ...result, lanes: combined, pagesFetched: seen.size,
    ...(job ? { summary: {
      scope: 'returned job lanes; inspect truncated for completeness',
      commandCount: combined.filter(lane => lane.kind === 'command').length,
      testCount: combined.filter(lane => lane.kind === 'test').length,
      latestReceivedAt: received.length ? new Date(Math.max(...received)).toISOString() : null,
    } } : {}),
  };
}

async function mapLimited(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index]); }
  }));
  return results;
}

export async function run(args, get) {
  const parsed = parseCommand(args);
  if (parsed.help) return HELP;
  const { command, target, values: v } = parsed;
  get ??= createClient(v['base-url'] || process.env.VLLM_CI_BASE_URL || 'https://ci.vllm.ai');
  const identity = { organization: v.organization || 'vllm', pipeline: v.pipeline || 'ci', buildNumber: target };
  if (command === 'get') return get(target);
  if (['builds', 'build', 'failures', 'queues'].includes(command)) {
    const params = {};
    for (const key of commandOptions[command]) if (v[key] !== undefined) params[key] = v[key] === true ? '1' : v[key];
    if (command === 'build' || command === 'builds') Object.assign(params, identity);
    return get(`/api/agent/${command}`, params);
  }
  if (command === 'queue-jobs') return get('/api/queue/jobs', { queue: v.queue });
  const trace = await readTrace(get, identity, v.job);
  if (command === 'trace') return { ...trace, ...(v.failed ? { lanes: trace.lanes.filter(lane => lane.status === 'failed') } : {}),
    note: 'Trace spans cover instrumented execution only. Use build for authoritative live status and jobs that never ran.' };
  if (trace.truncated) throw new Error('Trace is truncated; select --job UUID or inspect trace pagination before summarizing GPU activity');
  const jobIds = [...new Set(trace.lanes.filter(lane => lane.gpuAvailable).map(lane => lane.jobId).filter(Boolean))];
  const jobId = v.job || (jobIds.length === 1 ? jobIds[0] : null);
  if (!jobId) return { available: false, reason: jobIds.length ? 'Multiple GPU jobs: select --job UUID' : 'No retained GPU telemetry found; this does not prove CPU execution or idle GPUs', jobs: trace.lanes.filter(lane => jobIds.includes(lane.jobId) && lane.kind === 'job') };
  const details = v.job ? trace : await readTrace(get, identity, jobId);
  if (details.truncated) throw new Error('Job trace is truncated; inspect trace pagination before summarizing GPU activity');
  const kind = v['by-test'] || v.test ? 'test' : v['by-command'] ? 'command' : 'job';
  const intervals = details.lanes.filter(lane => lane.jobId === jobId && lane.kind === kind && (!v.test || lane.label === v.test));
  const offset = Number(v.offset || 0), limit = Number(v.limit || 20);
  const results = await mapLimited(intervals.slice(offset, offset + limit), async lane => {
    const interval = { id: lane.id, label: lane.label, kind: lane.kind, status: lane.status, durationMs: lane.durationMs };
    if (Date.parse(lane.endTime) === Date.parse(lane.startTime)) {
      return { ...interval, available: false, devices: [], truncated: false,
        start: lane.startTime, end: lane.endTime, note: 'Interval is below timestamp resolution; GPU activity is unknown' };
    }
    return { ...interval, ...(await get('/api/builds/gpu', { ...identity, jobId, start: lane.startTime, end: lane.endTime, summary: 1 })) };
  });
  return { schemaVersion: 1, ...identity, jobId, intervals: results,
    matchingIntervals: intervals.length, offset, nextOffset: offset + limit < intervals.length ? offset + limit : null,
    truncated: results.some(result => result.truncated),
    note: intervals.length ? 'Check each interval available, truncated, and utilizationCoverage. Overlapping tests share device activity.' : 'No matching instrumented interval; missing data does not establish GPU inactivity.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(result => {
    process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  });
}
