import { OWNER_NONE, type QueueFilters } from "@/lib/triage-query";
import type {
  TriageItemDetail,
  TriageLinkedItem,
  TriageMaintainer,
  TriageMyPlate,
  TriageQueueItem,
  TriageQueueResponse,
  TriageStats,
} from "@/lib/triage-types";

type Env = Record<string, string | undefined>;

/**
 * Dev-only in-memory fixtures for `/triage` (`npm run dev:triage`) so UI
 * iteration and local screenshots need zero Postgres setup. Strictly disabled
 * in production.
 */
export function triageDevFixturesEnabled(env: Env = process.env): boolean {
  return env.NODE_ENV !== "production" && env.TRIAGE_DEV_FIXTURES === "1";
}

const NOW_ISO = "2026-11-20T12:00:00.000Z";
const HOURS_AGO = (h: number) => new Date(Date.parse(NOW_ISO) - h * 3600_000).toISOString();

const FIX_PR_LINK: TriageLinkedItem = {
  itemKey: "vllm-project/vllm#65365",
  number: 65365,
  kind: "pr",
  title: "[Bugfix][CPU] DeepSeek-V4: return all layer types from the CPU tile scheduler",
  state: "open",
  htmlUrl: "https://github.com/vllm-project/vllm/pull/65365",
  score: 105,
  band: "page",
  owner: null,
};

const ISSUE_65364_LINK: TriageLinkedItem = {
  itemKey: "vllm-project/vllm#65364",
  number: 65364,
  kind: "issue",
  title: "[Bug]: [CPU] DeepSeek-V4 fails at the first decode step with KeyError: 'c1a'",
  state: "open",
  htmlUrl: "https://github.com/vllm-project/vllm/issues/65364",
  score: 79,
  band: "page",
  owner: null,
};

const FIX_68597_LINK: TriageLinkedItem = {
  itemKey: "vllm-project/vllm#68597",
  number: 68597,
  kind: "pr",
  title: "[Bugfix][Frontend] Reject previous_input_messages on non-Harmony Responses models",
  state: "open",
  htmlUrl: "https://github.com/vllm-project/vllm/pull/68597",
  score: 100,
  band: "page",
  owner: "robertgshaw2-redhat",
};

const ISSUE_68575_LINK: TriageLinkedItem = {
  itemKey: "vllm-project/vllm#68575",
  number: 68575,
  kind: "issue",
  title: "[Bug]: /v1/responses silently drops previous_input_messages on non-Harmony models",
  state: "open",
  htmlUrl: "https://github.com/vllm-project/vllm/issues/68575",
  score: 76,
  band: "page",
  owner: "robertgshaw2-redhat",
};

const FIXTURE_ITEMS: readonly TriageQueueItem[] = [
  {
    itemKey: "vllm-project/vllm#65364",
    repo: "vllm-project/vllm",
    number: 65364,
    kind: "issue",
    title: "[Bug]: [CPU] DeepSeek-V4 fails at the first decode step with KeyError: 'c1a'",
    htmlUrl: "https://github.com/vllm-project/vllm/issues/65364",
    author: "amd-lalithnc",
    state: "open",
    draft: false,
    ghCreatedAt: HOURS_AGO(336),
    ghUpdatedAt: HOURS_AGO(4),
    score: 79,
    band: "page",
    summary: "DeepSeek-V4 on CPU raises KeyError 'c1a' at the first decode step because build_tile_scheduler omits c1a/c2a.",
    type: "bug",
    areas: ["cpu", "attention"],
    models: ["DeepSeek-V4-Flash"],
    hardware: ["CPU_x86"],
    serving: ["tp"],
    severity: { serving_broken: true, crash: true, wrong_output: false, hang: false, memory_regression: false, security: false },
    assignments: [],
    waitingOn: null,
    fixes: [],
    fixedBy: [FIX_PR_LINK],
    ci: null,
  },
  {
    itemKey: "vllm-project/vllm#65365",
    repo: "vllm-project/vllm",
    number: 65365,
    kind: "pr",
    title: "[Bugfix][CPU] DeepSeek-V4: return all layer types from the CPU tile scheduler",
    htmlUrl: "https://github.com/vllm-project/vllm/pull/65365",
    author: "amd-lalithnc",
    state: "open",
    draft: false,
    ghCreatedAt: HOURS_AGO(335),
    ghUpdatedAt: HOURS_AGO(3),
    score: 105,
    band: "page",
    summary: "Returns all layer types (c1a, c2a) from the CPU build_tile_scheduler override and adds a regression test.",
    type: "bug",
    areas: ["cpu", "attention"],
    models: ["DeepSeek-V4-Flash"],
    hardware: ["CPU_x86"],
    serving: ["tp"],
    severity: { serving_broken: true, crash: true, wrong_output: false, hang: false, memory_regression: false, security: false },
    assignments: [],
    waitingOn: "reviewer",
    fixes: [ISSUE_65364_LINK],
    fixedBy: [],
    ci: {
      head_sha: "abc1234567890",
      state: "passed",
      build_number: 42100,
      build_url: "https://buildkite.com/vllm/ci/builds/42100",
      build_state: "passed",
      jobs_total: 42,
      jobs_passed: 42,
      jobs_running: 0,
      jobs_failed: 0,
      jobs_failed_on_main: 0,
      jobs_failed_recent_on_main: 0,
      jobs_failed_pr_only: 0,
      main_known: true,
      failed_jobs: [],
      checked_at: NOW_ISO,
    },
  },
  {
    itemKey: "vllm-project/vllm#68575",
    repo: "vllm-project/vllm",
    number: 68575,
    kind: "issue",
    title: "[Bug]: /v1/responses silently drops previous_input_messages on non-Harmony models",
    htmlUrl: "https://github.com/vllm-project/vllm/issues/68575",
    author: "cannottellyou",
    state: "open",
    draft: false,
    ghCreatedAt: HOURS_AGO(32),
    ghUpdatedAt: HOURS_AGO(2),
    score: 76,
    band: "page",
    summary: "/v1/responses returns 200 and silently ignores previous_input_messages on non-Harmony models instead of 400.",
    type: "bug",
    areas: ["frontend_api", "tool_calling"],
    models: ["Qwen3-0.6B"],
    hardware: ["H100", "RTX"],
    serving: ["openai_api"],
    severity: { serving_broken: false, crash: false, wrong_output: true, hang: false, memory_regression: false, security: false },
    assignments: [{ id: 101, maintainer: "robertgshaw2-redhat", role: "primary", status: "open" }],
    waitingOn: null,
    fixes: [],
    fixedBy: [FIX_68597_LINK],
    ci: null,
  },
  {
    itemKey: "vllm-project/vllm#68597",
    repo: "vllm-project/vllm",
    number: 68597,
    kind: "pr",
    title: "[Bugfix][Frontend] Reject previous_input_messages on non-Harmony Responses models",
    htmlUrl: "https://github.com/vllm-project/vllm/pull/68597",
    author: "sniper35",
    state: "open",
    draft: false,
    ghCreatedAt: HOURS_AGO(29),
    ghUpdatedAt: HOURS_AGO(1),
    score: 100,
    band: "page",
    summary: "Rejects non-empty previous_input_messages with HTTP 400 on non-Harmony models in Responses endpoints.",
    type: "bug",
    areas: ["frontend_api", "tool_calling"],
    models: ["Qwen3-1.7B"],
    hardware: ["H100"],
    serving: ["openai_api"],
    severity: { serving_broken: false, crash: false, wrong_output: true, hang: false, memory_regression: false, security: false },
    assignments: [{ id: 102, maintainer: "robertgshaw2-redhat", role: "primary", status: "open" }],
    waitingOn: "reviewer",
    fixes: [ISSUE_68575_LINK],
    fixedBy: [],
    ci: {
      head_sha: "def4567890123",
      state: "failed",
      build_number: 42118,
      build_url: "https://buildkite.com/vllm/ci/builds/42118",
      build_state: "failed",
      jobs_total: 40,
      jobs_passed: 38,
      jobs_running: 0,
      jobs_failed: 2,
      jobs_failed_on_main: 1,
      jobs_failed_recent_on_main: 0,
      jobs_failed_pr_only: 1,
      main_known: true,
      failed_jobs: [
        {
          name: "Entrypoints Test",
          key: "entrypoints-test",
          url: "https://buildkite.com/vllm/ci/builds/42118#job-1",
          count: 1,
          on_main: false,
          recent_on_main: false,
          infra: false,
        },
      ],
      checked_at: NOW_ISO,
    },
  },
  {
    itemKey: "vllm-project/vllm#63121",
    repo: "vllm-project/vllm",
    number: 63121,
    kind: "issue",
    title: "[Bug]: torchcodec resolves to a CUDA-13 wheel in CUDA-12.9 builds, breaking vllm serve",
    htmlUrl: "https://github.com/vllm-project/vllm/issues/63121",
    author: "eeslook",
    state: "open",
    draft: false,
    ghCreatedAt: HOURS_AGO(48),
    ghUpdatedAt: HOURS_AGO(5),
    score: 66,
    band: "route",
    summary: "vllm/vllm-openai:v0.32.0-cu129 fails at startup because unpinned torchcodec pulls a CUDA-13 wheel.",
    type: "bug",
    areas: ["build_install", "ci"],
    models: [],
    hardware: ["H100"],
    serving: ["openai_api"],
    severity: { serving_broken: true, crash: true, wrong_output: false, hang: false, memory_regression: false, security: false },
    assignments: [{ id: 103, maintainer: "khluu", role: "primary", status: "open" }],
    waitingOn: null,
    fixes: [],
    fixedBy: [],
    ci: null,
  },
  {
    itemKey: "vllm-project/vllm#67751",
    repo: "vllm-project/vllm",
    number: 67751,
    kind: "pr",
    title: "[Bugfix][StructuredOutput] Defer llguidance import and relax version bound for glibc < 2.31",
    htmlUrl: "https://github.com/vllm-project/vllm/pull/67751",
    author: "yurun00",
    state: "open",
    draft: false,
    ghCreatedAt: HOURS_AGO(18),
    ghUpdatedAt: HOURS_AGO(2),
    score: 53,
    band: "route",
    summary: "Defers eager llguidance imports and relaxes lower bound so glibc < 2.31 hosts can install prebuilt wheels.",
    type: "bug",
    areas: ["build_install", "structured_output"],
    models: ["Mistral"],
    hardware: [],
    serving: [],
    severity: { serving_broken: false, crash: false, wrong_output: false, hang: false, memory_regression: false, security: false },
    assignments: [{ id: 104, maintainer: "khluu", role: "primary", status: "acked" }],
    waitingOn: "reviewer",
    fixes: [],
    fixedBy: [],
    ci: null,
  },
  {
    itemKey: "vllm-project/vllm#68990",
    repo: "vllm-project/vllm",
    number: 68990,
    kind: "issue",
    title: "[Perf]: Minor warmup latency increase on B200 with FP8 KV cache",
    htmlUrl: "https://github.com/vllm-project/vllm/issues/68990",
    author: "perf-user",
    state: "open",
    draft: false,
    ghCreatedAt: HOURS_AGO(9),
    ghUpdatedAt: HOURS_AGO(1),
    score: 31,
    band: "watch",
    summary: "Startup warmup takes ~2s longer on B200 when FP8 KV cache is enabled.",
    type: "performance",
    areas: ["performance", "kv_cache"],
    models: ["Qwen3-32B"],
    hardware: ["B200"],
    serving: ["tp"],
    severity: { serving_broken: false, crash: false, wrong_output: false, hang: false, memory_regression: false, security: false },
    assignments: [],
    waitingOn: null,
    fixes: [],
    fixedBy: [],
    ci: null,
  },
];

export function fixtureQueue(filters: QueueFilters): TriageQueueResponse {
  const q = filters.q?.toLowerCase() ?? "";
  const model = filters.model?.toLowerCase() ?? "";
  const filtered = FIXTURE_ITEMS.filter((item) => {
    if (filters.state === "open" && item.state !== "open") return false;
    if (filters.bands.length > 0 && !filters.bands.includes((item.band ?? "unscored") as QueueFilters["bands"][number])) {
      return false;
    }
    if (filters.kind && item.kind !== filters.kind) return false;
    if (filters.area && !item.areas.includes(filters.area)) return false;
    if (filters.hardware && !item.hardware.includes(filters.hardware)) return false;
    if (model && !item.models.some((m) => m.toLowerCase().includes(model))) return false;
    if (filters.owner === OWNER_NONE && item.assignments.length > 0) return false;
    if (
      filters.owner &&
      filters.owner !== OWNER_NONE &&
      !item.assignments.some((a) => a.maintainer.toLowerCase() === filters.owner!.toLowerCase())
    ) {
      return false;
    }
    if (filters.status === "unassigned" && item.assignments.length > 0) return false;
    if (filters.status === "open" && !item.assignments.some((a) => a.status === "open")) return false;
    if (filters.status === "acked" && !item.assignments.some((a) => a.status === "acked")) return false;
    if (filters.review === "ready" && (item.kind !== "pr" || item.draft || item.waitingOn !== "reviewer")) return false;
    if (
      q &&
      !item.title.toLowerCase().includes(q) &&
      !(item.summary ?? "").toLowerCase().includes(q) &&
      String(item.number) !== q.replace(/^#/, "")
    ) {
      return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (filters.sort === "age") return Date.parse(b.ghCreatedAt) - Date.parse(a.ghCreatedAt);
    if (filters.sort === "updated") return Date.parse(b.ghUpdatedAt) - Date.parse(a.ghUpdatedAt);
    return (b.score ?? -1) - (a.score ?? -1);
  });
  const start = (filters.page - 1) * filters.pageSize;
  return {
    items: sorted.slice(start, start + filters.pageSize),
    total: sorted.length,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export function fixtureStats(): TriageStats {
  const bandCounts: TriageStats["bandCounts"] = { page: 0, route: 0, watch: 0, ignore: 0, unscored: 0 };
  for (const item of FIXTURE_ITEMS) {
    const key = (item.band ?? "unscored") as keyof TriageStats["bandCounts"];
    bandCounts[key]++;
  }
  const unownedItems = FIXTURE_ITEMS.filter(
    (i) => (i.band === "page" || i.band === "route") && i.assignments.length === 0,
  );
  return {
    bandCounts,
    unowned: unownedItems.length,
    unownedPage: unownedItems.filter((i) => i.band === "page").length,
    newToday: 2,
    ingestedLast24h: 14,
    inScopeLast7d: 120,
    extractedLast7d: 118,
    pageUnacked: FIXTURE_ITEMS.filter((i) => i.band === "page" && !i.assignments.some((a) => a.status === "acked")).length,
    assignedLast7d: 18,
    notMineLast7d: 1,
    suppression: { threshold: 10, actors: [] },
    health: {
      lastLabelledAt: HOURS_AGO(0.1),
      lastJudgedAt: HOURS_AGO(0.1),
      waitingForLabel: 0,
      labelWaitSince: null,
      waitingForJudgement: 0,
      judgementWaitSince: null,
      labelFailures24h: 0,
      labelGaveUp: 0,
      lastLabelError: null,
      loginExpiresOn: null,
      workerWarnings24h: 0,
      latestWorkerWarning: null,
    },
  };
}

export function fixtureActiveMaintainers(): { githubLogin: string; openAssignments: number; openPrimaries: number }[] {
  return [
    { githubLogin: "khluu", openAssignments: 2, openPrimaries: 2 },
    { githubLogin: "robertgshaw2-redhat", openAssignments: 2, openPrimaries: 2 },
    { githubLogin: "gau-nernst", openAssignments: 0, openPrimaries: 0 },
    { githubLogin: "mgoin", openAssignments: 0, openPrimaries: 0 },
    { githubLogin: "njhill", openAssignments: 0, openPrimaries: 0 },
  ];
}

export function fixtureMaintainer(login: string): TriageMaintainer {
  return {
    githubLogin: login,
    slackUserId: "U0000000001",
    active: true,
    rules: {
      areas: [],
      hardware: [],
      models: [],
      paths: [],
      keywords: [],
      types: [],
      exclude: { types: [], areas: [], hardware: [] },
      natural_language: "Dev fixture maintainer profile (TRIAGE_DEV_FIXTURES=1).",
      timezone: "America/Los_Angeles",
      max_notifications_per_day: 5,
    },
    minScore: 40,
    capacityPerWeek: 25,
    away: [],
    notifyMode: "immediate",
    updatedBy: "repo",
    updatedAt: NOW_ISO,
  };
}

export function fixtureMyPlate(login: string): TriageMyPlate {
  const mine = FIXTURE_ITEMS.filter((i) =>
    i.assignments.some((a) => a.maintainer.toLowerCase() === login.toLowerCase()),
  );
  const chosen = mine.length > 0 ? mine : FIXTURE_ITEMS.slice(4, 6);
  return {
    login,
    open: chosen.map((item, idx) => {
      const a = item.assignments[0] ?? { id: 900 + idx, maintainer: login, role: "primary" as const, status: "open" as const };
      return {
        ...item,
        assignment: {
          id: a.id,
          itemKey: item.itemKey,
          maintainer: login,
          role: a.role,
          status: a.status,
          reason: {
            matched: ["relevance:high (like #65107, #62575)"],
            why: "Dev fixture assignment matching your build/packaging history.",
            load: chosen.length,
            capacity: 25,
          },
          scoreAtAssign: item.score ?? 50,
          assignedBy: "router",
          assignedAt: HOURS_AGO(6 + idx * 4),
          notifiedAt: HOURS_AGO(5 + idx * 4),
          closedAt: null,
        },
        relevanceMatches: [
          { maintainer: login, relevance: "high" },
          { maintainer: "njhill", relevance: "medium" },
        ],
      };
    }),
    recentlyClosed: [],
  };
}

export function fixtureItemDetail(itemKey: string): TriageItemDetail | null {
  const item = FIXTURE_ITEMS.find((entry) => entry.itemKey === itemKey);
  if (!item) return null;
  const openOwner = item.assignments[0];
  return {
    item: {
      itemKey: item.itemKey,
      repo: item.repo,
      number: item.number,
      kind: item.kind,
      title: item.title,
      htmlUrl: item.htmlUrl,
      author: item.author,
      authorAssociation: "CONTRIBUTOR",
      state: item.state,
      draft: item.draft,
      labels: item.areas,
      files: item.kind === "pr" ? [{ path: "vllm/v1/attention/backends/cpu_mla.py", additions: 14, deletions: 3 }] : [],
      reactions: 4,
      commentCount: 3,
      ghCreatedAt: item.ghCreatedAt,
      ghUpdatedAt: item.ghUpdatedAt,
      prepass: { waiting_on: item.waitingOn ?? undefined },
      inScope: true,
      extractionStatus: "done",
      extractionError: null,
    },
    score: item.score !== null && item.band !== null
      ? {
          score: item.score,
          band: item.band,
          breakdown: [
            { factor: "severity:serving_broken", points: 40 },
            { factor: "reach:popular_model", points: 25 },
            { factor: "evidence:repro", points: 14 },
          ],
          scoringVersion: "fixture-v1",
          scoredAt: NOW_ISO,
        }
      : null,
    extraction: {
      id: item.number,
      facets: {
        type: item.type ?? "bug",
        summary: item.summary ?? "",
        areas: item.areas,
        hardware: item.hardware,
        models: item.models.map((name) => ({ name, family: name.toLowerCase() })),
        serving: item.serving,
        severity: item.severity ?? undefined,
      },
      model: "fixture",
      promptVersion: "v1",
      createdAt: NOW_ISO,
    },
    assignments: openOwner
      ? [
          {
            id: openOwner.id,
            itemKey: item.itemKey,
            maintainer: openOwner.maintainer,
            role: openOwner.role,
            status: openOwner.status,
            reason: { matched: ["relevance:high"], why: "Matched in dev fixtures." },
            scoreAtAssign: item.score ?? 50,
            assignedBy: "router",
            assignedAt: HOURS_AGO(8),
            notifiedAt: HOURS_AGO(7),
            closedAt: null,
          },
        ]
      : [],
    actions: [],
    relevance: openOwner
      ? [
          {
            maintainer: openOwner.maintainer,
            relevance: "high",
            reason: "Authored closely related fixes in this component.",
            evidence: [{ number: 65107, kind: "authored", title: "Related recent PR" }],
            current: true,
            judgedAt: HOURS_AGO(8),
          },
        ]
      : [],
    whyUnowned: openOwner
      ? null
      : {
          summary: "Nobody is a match: everyone judged is low or none, and no one's rules match it.",
          lines: [],
          pending: false,
        },
    fixes: item.fixes,
    fixedBy: item.fixedBy,
    ci: item.ci ?? null,
  };
}
