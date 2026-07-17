import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { loadEvalRows, type EvalRow } from "@/lib/eval-data";
import { getCached, setCache } from "@/lib/api-cache";
import {
  buildSummary,
  compareEvalRows,
  comparePerfRows,
  escapeSqlString,
  loadPerfRowsByImages,
  parseThreshold,
  sortDeltas,
  type CompareSummary,
  type CoverageItem,
  type DeltaItem,
  type PerfRun,
} from "@/lib/compare";

interface BuildRow {
  id: string;
  number: string;
  state: string;
  branch: string;
  commit: string;
  created_at: string;
  finished_at: string;
  web_url: string;
  message: string;
}

interface PairedNightlyQueryRow {
  perf_eval_build_id: string;
  perf_eval_build_number: string;
  perf_eval_web_url: string;
  perf_eval_message: string;
  perf_eval_state: string;
  perf_eval_branch: string;
  perf_eval_commit: string;
  perf_eval_created_at: string;
  perf_eval_finished_at: string | null;
  perf_eval_run_at: string;
  vllm_commit: string;
  vllm_image: string;
  full_ci_build_id: string | null;
  full_ci_build_number: string | null;
  full_ci_web_url: string | null;
  full_ci_message: string | null;
  full_ci_state: string | null;
  full_ci_branch: string | null;
  full_ci_commit: string | null;
  full_ci_created_at: string | null;
  full_ci_finished_at: string | null;
  schedule_delta_seconds: string | number | null;
  commit_matches: string | boolean | null;
}

interface NightlyRow {
  commit: string;
  sourceImage: string;
  runAt: string;
  perfEvalBuild: BuildRow;
  fullCIBuild: BuildRow | null;
  scheduleDeltaSeconds: number | null;
  commitMatches: boolean;
}

interface JobRow {
  build_id: string;
  name: string;
  state: string;
  web_url: string;
  started_at: string;
  finished_at: string;
  soft_failed: string;
}

interface TaggedJob extends Omit<JobRow, "build_id"> {
  category: "new" | "recurring" | "unknown";
}

interface NightlyEntry {
  commit: string;
  shortCommit: string;
  image: string;
  sourceImage: string;
  date: string;
  perfEval: {
    build: BuildRow;
  };
  fullCI: {
    build: BuildRow | null;
    match: {
      type: "schedule";
      commitMatches: boolean;
      scheduleDeltaSeconds: number;
    } | null;
    comparisonAvailable: boolean;
    failedJobs: TaggedJob[];
    fixedJobs: TaggedJob[];
  };
  deltaVsPrev: {
    prevCommit: string | null;
    prevImage: string | null;
    prevSourceImage: string | null;
    summary: CompareSummary | null;
    worstRegressions: DeltaItem[];
    perfDeltas: DeltaItem[];
    evalDeltas: DeltaItem[];
    perfMissingBaseline: CoverageItem[];
    perfMissingCandidate: CoverageItem[];
    evalMissingBaseline: CoverageItem[];
    evalMissingCandidate: CoverageItem[];
  };
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const FULL_CI_MATCH_WINDOW_SECONDS = 300;
const RELEASE_IMAGE_PREFIX = "public.ecr.aws/q9t5s3a7/vllm-release-repo:";

function timestampToIso(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function parseDbBoolean(value: string | boolean | null): boolean {
  return value === true || (
    typeof value === "string" && ["true", "1"].includes(value.toLowerCase())
  );
}

function displayImage(sourceImage: string, commit: string): string {
  if (sourceImage === `${RELEASE_IMAGE_PREFIX}${commit}`) {
    return `vllm/vllm-openai:nightly-${commit}`;
  }
  return sourceImage;
}

function isTerminalBuild(build: BuildRow | null): build is BuildRow {
  return build !== null && (build.state === "passed" || build.state === "failed");
}

async function loadNightlies(limit: number): Promise<NightlyRow[]> {
  const rows = await queryDatabricks<PairedNightlyQueryRow>(`
    WITH perf_eval AS (
      SELECT
        b.id,
        b.number,
        b.web_url,
        b.message,
        b.state,
        b.branch,
        b.commit,
        b.created_at,
        b.finished_at,
        COALESCE(b.scheduled_at, b.created_at) AS run_at,
        NULLIF(TRIM(get_json_object(b.env, '$.VLLM_COMMIT')), '') AS vllm_commit,
        NULLIF(TRIM(get_json_object(b.env, '$.VLLM_IMAGE')), '') AS vllm_image
      FROM vllm_data_warehouse.buildkite.build AS b
      WHERE b._fivetran_deleted = false
        AND b.organization_slug = 'vllm'
        AND b.pipeline_slug = 'perf-eval'
        AND b.branch = 'main'
        AND get_json_object(b.env, '$.NIGHTLY') = '1'
        AND NULLIF(TRIM(get_json_object(b.env, '$.VLLM_COMMIT')), '') IS NOT NULL
        AND NULLIF(TRIM(get_json_object(b.env, '$.VLLM_IMAGE')), '') IS NOT NULL
      ORDER BY COALESCE(b.scheduled_at, b.created_at) DESC
      LIMIT ${limit}
    ),
    full_ci AS (
      SELECT
        b.id,
        b.number,
        b.web_url,
        b.message,
        b.state,
        b.branch,
        b.commit,
        b.created_at,
        b.finished_at,
        COALESCE(b.scheduled_at, b.created_at) AS run_at
      FROM vllm_data_warehouse.buildkite.build AS b
      WHERE b._fivetran_deleted = false
        AND b.organization_slug = 'vllm'
        AND b.pipeline_slug = 'ci'
        AND b.branch = 'main'
        AND b.source = 'schedule'
        AND get_json_object(b.env, '$.NIGHTLY') = '1'
        AND get_json_object(b.env, '$.RUN_ALL') = '1'
        AND get_json_object(b.env, '$.TORCH_NIGHTLY') IS NULL
        AND COALESCE(b.scheduled_at, b.created_at)
          BETWEEN (SELECT MIN(run_at) - INTERVAL 5 MINUTES FROM perf_eval)
              AND (SELECT MAX(run_at) + INTERVAL 5 MINUTES FROM perf_eval)
    )
    SELECT
      pe.id AS perf_eval_build_id,
      pe.number AS perf_eval_build_number,
      pe.web_url AS perf_eval_web_url,
      pe.message AS perf_eval_message,
      pe.state AS perf_eval_state,
      pe.branch AS perf_eval_branch,
      pe.commit AS perf_eval_commit,
      pe.created_at AS perf_eval_created_at,
      pe.finished_at AS perf_eval_finished_at,
      pe.run_at AS perf_eval_run_at,
      pe.vllm_commit,
      pe.vllm_image,
      ci.id AS full_ci_build_id,
      ci.number AS full_ci_build_number,
      ci.web_url AS full_ci_web_url,
      ci.message AS full_ci_message,
      ci.state AS full_ci_state,
      ci.branch AS full_ci_branch,
      ci.commit AS full_ci_commit,
      ci.created_at AS full_ci_created_at,
      ci.finished_at AS full_ci_finished_at,
      ABS(unix_timestamp(ci.run_at) - unix_timestamp(pe.run_at)) AS schedule_delta_seconds,
      CASE
        WHEN ci.id IS NULL THEN NULL
        ELSE pe.vllm_commit = ci.commit
      END AS commit_matches
    FROM perf_eval AS pe
    LEFT JOIN full_ci AS ci
      ON ABS(unix_timestamp(ci.run_at) - unix_timestamp(pe.run_at))
        <= ${FULL_CI_MATCH_WINDOW_SECONDS}
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY pe.id
      ORDER BY
        CASE WHEN ci.id IS NULL THEN 1 ELSE 0 END,
        ABS(unix_timestamp(ci.run_at) - unix_timestamp(pe.run_at)) ASC,
        ci.created_at DESC,
        ci.number DESC
    ) = 1
    ORDER BY pe.run_at DESC
  `);

  return rows.map((row) => {
    const perfEvalBuild: BuildRow = {
      id: row.perf_eval_build_id,
      number: row.perf_eval_build_number,
      state: row.perf_eval_state,
      branch: row.perf_eval_branch,
      commit: row.perf_eval_commit,
      created_at: row.perf_eval_created_at,
      finished_at: row.perf_eval_finished_at ?? "",
      web_url: row.perf_eval_web_url,
      message: row.perf_eval_message,
    };
    const fullCIBuild = row.full_ci_build_id ? {
      id: row.full_ci_build_id,
      number: row.full_ci_build_number ?? "",
      state: row.full_ci_state ?? "",
      branch: row.full_ci_branch ?? "",
      commit: row.full_ci_commit ?? "",
      created_at: row.full_ci_created_at ?? "",
      finished_at: row.full_ci_finished_at ?? "",
      web_url: row.full_ci_web_url ?? "",
      message: row.full_ci_message ?? "",
    } satisfies BuildRow : null;
    const parsedDelta = row.schedule_delta_seconds === null
      ? null
      : Number(row.schedule_delta_seconds);

    return {
      commit: row.vllm_commit,
      sourceImage: row.vllm_image,
      runAt: row.perf_eval_run_at,
      perfEvalBuild,
      fullCIBuild,
      scheduleDeltaSeconds: fullCIBuild && parsedDelta !== null && Number.isFinite(parsedDelta)
        ? parsedDelta
        : null,
      commitMatches: parseDbBoolean(row.commit_matches),
    };
  });
}

async function loadFailedJobsByBuildIds(buildIds: string[]): Promise<Map<string, JobRow[]>> {
  if (buildIds.length === 0) return new Map();
  const inList = buildIds.map((id) => `'${escapeSqlString(id)}'`).join(", ");
  const jobs = await queryDatabricks<JobRow>(`
    SELECT
      j.build_id,
      j.name,
      j.state,
      j.web_url,
      j.started_at,
      j.finished_at,
      j.soft_failed
    FROM vllm_data_warehouse.buildkite.build_job AS j
    WHERE j.build_id IN (${inList})
      AND j._fivetran_deleted = false
      AND j.type = 'script'
      AND j.state IN ('failed', 'failing', 'broken', 'timed_out')
    ORDER BY j.name
  `);

  const out = new Map<string, JobRow[]>();
  for (const j of jobs) {
    const arr = out.get(j.build_id) ?? [];
    arr.push(j);
    out.set(j.build_id, arr);
  }
  return out;
}

function tagJob(j: JobRow, category: TaggedJob["category"]): TaggedJob {
  return {
    name: j.name,
    state: j.state,
    web_url: j.web_url,
    started_at: j.started_at,
    finished_at: j.finished_at,
    soft_failed: j.soft_failed,
    category,
  };
}

function categorizeFailures(
  currentJobs: JobRow[],
  prevJobs: JobRow[] | null
): { failedJobs: TaggedJob[]; fixedJobs: TaggedJob[] } {
  if (!prevJobs) {
    return {
      failedJobs: currentJobs.map((j) => tagJob(j, "unknown")),
      fixedJobs: [],
    };
  }
  const prevNames = new Set(prevJobs.map((j) => j.name));
  const currentNames = new Set(currentJobs.map((j) => j.name));
  const failedJobs = currentJobs.map((j) =>
    tagJob(j, prevNames.has(j.name) ? "recurring" : "new")
  );
  const fixedJobs = prevJobs
    .filter((j) => !currentNames.has(j.name))
    .map((j) => tagJob(j, "unknown"));
  return { failedJobs, fixedJobs };
}

function groupPerfByImage(rows: PerfRun[]): Map<string, PerfRun[]> {
  const out = new Map<string, PerfRun[]>();
  for (const r of rows) {
    const arr = out.get(r.image) ?? [];
    arr.push(r);
    out.set(r.image, arr);
  }
  return out;
}

function groupEvalByImage(rows: EvalRow[]): Map<string, EvalRow[]> {
  const out = new Map<string, EvalRow[]>();
  for (const r of rows) {
    if (!r.image) continue;
    const arr = out.get(r.image) ?? [];
    arr.push(r);
    out.set(r.image, arr);
  }
  return out;
}

const TTL = 60_000;

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const requestedLimit = parseInt(sp.get("limit") ?? "", 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;
    const perfThreshold = parseThreshold(sp.get("perf_threshold"), 0.02);
    const evalSigma = parseThreshold(sp.get("eval_sigma"), 2);

    const cacheKey = `nightly:${limit}:${perfThreshold}:${evalSigma}`;
    const cached = getCached(cacheKey);
    if (cached) return NextResponse.json(cached);

    const nightlies = await loadNightlies(limit + 1);
    if (nightlies.length === 0) {
      return NextResponse.json({ nightlies: [], generatedAt: new Date().toISOString() });
    }

    const allSourceImages = [...new Set(nightlies.map((n) => n.sourceImage))];
    const fullCIBuildIds = [
      ...new Set(
        nightlies.flatMap((n) => n.fullCIBuild ? [n.fullCIBuild.id] : [])
      ),
    ];

    const [perfRows, evalRows, jobsByBuild] = await Promise.all([
      loadPerfRowsByImages(allSourceImages),
      loadEvalRows({ images: allSourceImages }),
      loadFailedJobsByBuildIds(fullCIBuildIds),
    ]);

    const perfByImage = groupPerfByImage(perfRows);
    const evalByImage = groupEvalByImage(evalRows);

    const entries: NightlyEntry[] = [];
    for (let i = 0; i < Math.min(limit, nightlies.length); i++) {
      const n = nightlies[i];
      const prev = nightlies[i + 1];
      const build = n.fullCIBuild;
      const prevBuild = prev?.fullCIBuild ?? null;

      const currentJobs = build ? jobsByBuild.get(build.id) ?? [] : [];
      const comparisonAvailable = isTerminalBuild(build) && isTerminalBuild(prevBuild);
      const { failedJobs, fixedJobs } = comparisonAvailable
        ? categorizeFailures(currentJobs, jobsByBuild.get(prevBuild.id) ?? [])
        : {
            failedJobs: currentJobs.map((j) => tagJob(j, "unknown")),
            fixedJobs: [],
          };

      let deltaSummary: CompareSummary | null = null;
      let worstRegressions: DeltaItem[] = [];
      let perfDeltas: DeltaItem[] = [];
      let evalDeltas: DeltaItem[] = [];
      let perfMissingBaseline: CoverageItem[] = [];
      let perfMissingCandidate: CoverageItem[] = [];
      let evalMissingBaseline: CoverageItem[] = [];
      let evalMissingCandidate: CoverageItem[] = [];

      if (prev) {
        const candidatePerf = perfByImage.get(n.sourceImage) ?? [];
        const baselinePerf = perfByImage.get(prev.sourceImage) ?? [];
        const candidateEval = evalByImage.get(n.sourceImage) ?? [];
        const baselineEval = evalByImage.get(prev.sourceImage) ?? [];

        const perfResult = comparePerfRows(
          [...baselinePerf, ...candidatePerf],
          prev.sourceImage,
          n.sourceImage,
          perfThreshold
        );
        const evalResult = compareEvalRows(
          [...baselineEval, ...candidateEval],
          prev.sourceImage,
          n.sourceImage,
          evalSigma
        );

        deltaSummary = buildSummary(perfResult, evalResult);
        const allDeltas = [...perfResult.deltas, ...evalResult.deltas].sort(sortDeltas);
        worstRegressions = allDeltas
          .filter((d) => d.status === "regression")
          .slice(0, 5);
        perfDeltas = perfResult.deltas.sort(sortDeltas);
        evalDeltas = evalResult.deltas.sort(sortDeltas);
        perfMissingBaseline = perfResult.missingBaseline;
        perfMissingCandidate = perfResult.missingCandidate;
        evalMissingBaseline = evalResult.missingBaseline;
        evalMissingCandidate = evalResult.missingCandidate;
      }

      entries.push({
        commit: n.commit,
        shortCommit: n.commit.slice(0, 7),
        image: displayImage(n.sourceImage, n.commit),
        sourceImage: n.sourceImage,
        date: timestampToIso(n.runAt),
        perfEval: { build: n.perfEvalBuild },
        fullCI: {
          build,
          match: build && n.scheduleDeltaSeconds !== null ? {
            type: "schedule",
            commitMatches: n.commitMatches,
            scheduleDeltaSeconds: n.scheduleDeltaSeconds,
          } : null,
          comparisonAvailable,
          failedJobs,
          fixedJobs,
        },
        deltaVsPrev: {
          prevCommit: prev?.commit ?? null,
          prevImage: prev ? displayImage(prev.sourceImage, prev.commit) : null,
          prevSourceImage: prev?.sourceImage ?? null,
          summary: deltaSummary,
          worstRegressions,
          perfDeltas,
          evalDeltas,
          perfMissingBaseline,
          perfMissingCandidate,
          evalMissingBaseline,
          evalMissingCandidate,
        },
      });
    }

    const result = {
      nightlies: entries,
      thresholds: { perf: perfThreshold, evalSigma },
      generatedAt: new Date().toISOString(),
    };
    setCache(cacheKey, result, TTL);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to load nightly summary:", error);
    return NextResponse.json(
      { error: "Failed to load nightly summary" },
      { status: 500 }
    );
  }
}
