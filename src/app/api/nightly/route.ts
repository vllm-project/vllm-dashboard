import { NextRequest, NextResponse } from "next/server";
import { queryDatabricks } from "@/lib/databricks";
import { loadEvalRows, type EvalRow } from "@/lib/eval-data";
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

interface NightlyRow {
  commit: string;
  image: string;
  latest_ts: string;
}

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
  date: string;
  fullCI: {
    build: BuildRow | null;
    failedJobs: TaggedJob[];
    fixedJobs: TaggedJob[];
  };
  deltaVsPrev: {
    prevCommit: string | null;
    prevImage: string | null;
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

function tsToIso(ts: string | number | null): string {
  if (ts === null || ts === undefined) return "";
  const n = typeof ts === "number" ? ts : parseFloat(String(ts));
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toISOString();
}

async function loadNightlyCommits(limit: number): Promise<NightlyRow[]> {
  return queryDatabricks<NightlyRow>(`
    WITH nights AS (
      SELECT
        NULLIF(
          COALESCE(
            NULLIF(message:vllm_commit::STRING, ''),
            regexp_extract(LOWER(message:image::STRING), 'nightly-([0-9a-f]+)', 1)
          ),
          ''
        ) AS commit,
        message:image::STRING AS image,
        COALESCE(message:date::DOUBLE, message:data:date::DOUBLE) AS ts
      FROM vllm_data_warehouse.default.vllm_eval_data_ingest
      WHERE message:nightly::BOOLEAN = TRUE
        AND message:image::STRING IS NOT NULL

      UNION ALL

      SELECT
        NULLIF(regexp_extract(LOWER(message:image::STRING), 'nightly-([0-9a-f]+)', 1), '') AS commit,
        message:image::STRING AS image,
        unix_timestamp(message:date::STRING) AS ts
      FROM vllm_data_warehouse.default.vllm_perf_data_ingest
      WHERE message:nightly::BOOLEAN = TRUE
        AND message:image::STRING IS NOT NULL
    )
    SELECT
      commit,
      MAX(image) AS image,
      CAST(MAX(ts) AS STRING) AS latest_ts
    FROM nights
    WHERE commit IS NOT NULL
    GROUP BY commit
    ORDER BY MAX(ts) DESC
    LIMIT ${limit}
  `);
}

async function loadFullCIBuilds(commits: string[]): Promise<Map<string, BuildRow>> {
  if (commits.length === 0) return new Map();
  const inList = commits.map((c) => `'${escapeSqlString(c)}'`).join(", ");
  const builds = await queryDatabricks<BuildRow>(`
    SELECT
      b.id,
      b.number,
      b.state,
      b.branch,
      b.commit,
      b.created_at,
      b.finished_at,
      b.web_url,
      b.message
    FROM vllm_data_warehouse.buildkite.build AS b
    INNER JOIN vllm_data_warehouse.buildkite.pipeline AS p ON b.pipeline_id = p.id
    WHERE b._fivetran_deleted = false
      AND p.name = 'CI'
      AND b.branch = 'main'
      AND b.message LIKE '%Full CI%'
      AND b.state IN ('passed', 'failed')
      AND b.commit IN (${inList})
    ORDER BY b.created_at DESC
  `);

  // Latest build wins per commit.
  const out = new Map<string, BuildRow>();
  for (const b of builds) {
    if (!out.has(b.commit)) out.set(b.commit, b);
  }
  return out;
}

async function loadFailedJobs(buildIds: string[]): Promise<Map<string, JobRow[]>> {
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

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const requestedLimit = parseInt(sp.get("limit") ?? "", 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;
    const perfThreshold = parseThreshold(sp.get("perf_threshold"), 0.02);
    const evalSigma = parseThreshold(sp.get("eval_sigma"), 2);

    // We need limit + 1 nightlies so the oldest one can still be compared against
    // its predecessor; we trim back to `limit` in the response.
    const nightlies = await loadNightlyCommits(limit + 1);
    if (nightlies.length === 0) {
      return NextResponse.json({ nightlies: [], generatedAt: new Date().toISOString() });
    }

    const allCommits = nightlies.map((n) => n.commit);
    const allImages = nightlies.map((n) => n.image);

    const [builds, perfRows, evalRows] = await Promise.all([
      loadFullCIBuilds(allCommits),
      loadPerfRowsByImages(allImages),
      loadEvalRows({ images: allImages }),
    ]);

    const buildIds = [...builds.values()].map((b) => b.id);
    const jobsByBuild = await loadFailedJobs(buildIds);

    const perfByImage = groupPerfByImage(perfRows);
    const evalByImage = groupEvalByImage(evalRows);

    const entries: NightlyEntry[] = [];
    for (let i = 0; i < Math.min(limit, nightlies.length); i++) {
      const n = nightlies[i];
      const prev = nightlies[i + 1];
      const build = builds.get(n.commit) ?? null;
      const prevBuild = prev ? builds.get(prev.commit) ?? null : null;

      const currentJobs = build ? jobsByBuild.get(build.id) ?? [] : [];
      const prevJobs = prevBuild ? jobsByBuild.get(prevBuild.id) ?? [] : null;
      const { failedJobs, fixedJobs } = categorizeFailures(currentJobs, prevJobs);

      let deltaSummary: CompareSummary | null = null;
      let worstRegressions: DeltaItem[] = [];
      let perfDeltas: DeltaItem[] = [];
      let evalDeltas: DeltaItem[] = [];
      let perfMissingBaseline: CoverageItem[] = [];
      let perfMissingCandidate: CoverageItem[] = [];
      let evalMissingBaseline: CoverageItem[] = [];
      let evalMissingCandidate: CoverageItem[] = [];

      if (prev) {
        const candidatePerf = perfByImage.get(n.image) ?? [];
        const baselinePerf = perfByImage.get(prev.image) ?? [];
        const candidateEval = evalByImage.get(n.image) ?? [];
        const baselineEval = evalByImage.get(prev.image) ?? [];

        const perfResult = comparePerfRows(
          [...baselinePerf, ...candidatePerf],
          prev.image,
          n.image,
          perfThreshold
        );
        const evalResult = compareEvalRows(
          [...baselineEval, ...candidateEval],
          prev.image,
          n.image,
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
        image: n.image,
        date: tsToIso(n.latest_ts),
        fullCI: { build, failedJobs, fixedJobs },
        deltaVsPrev: {
          prevCommit: prev?.commit ?? null,
          prevImage: prev?.image ?? null,
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

    return NextResponse.json({
      nightlies: entries,
      thresholds: { perf: perfThreshold, evalSigma },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to load nightly summary:", error);
    return NextResponse.json(
      { error: "Failed to load nightly summary" },
      { status: 500 }
    );
  }
}
