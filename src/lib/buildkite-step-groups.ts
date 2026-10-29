import yaml from "js-yaml";

const REST_ENDPOINT = "https://api.buildkite.com/v2";

// The OTel spans carry no `buildkite.step.group.label`, and the REST job
// objects have no group either. The bootstrap job uploads the generated
// pipeline as an artifact, plus the optional steps it defers behind
// "Run more jobs"; together they map every step key to its group.
const PIPELINE_PATH = ".buildkite/pipeline.yaml";
const DEFERRED_PATH = ".buildkite/deferred/deferred_steps.json";
const ARTIFACT_PAGE_LIMIT = 5;

export interface StepGroups {
  /** Step key → group label. */
  byKey: Record<string, string>;
  /** Step label → group label, for steps uploaded without a key. */
  byLabel: Record<string, string>;
  /** Group labels in pipeline order. */
  order: string[];
}

type PipelineStep = {
  group?: unknown;
  key?: unknown;
  label?: unknown;
  steps?: unknown;
};

type DeferredFile = {
  steps?: Array<{ group?: unknown; step?: PipelineStep }>;
};

function emptyGroups(): StepGroups {
  return { byKey: {}, byLabel: {}, order: [] };
}

function addStep(groups: StepGroups, group: string, step: PipelineStep) {
  if (!groups.order.includes(group)) groups.order.push(group);
  if (typeof step.key === "string" && step.key) groups.byKey[step.key] = group;
  if (typeof step.label === "string" && step.label) groups.byLabel[step.label] = group;
}

export function stepGroupsFromPipeline(text: string, into = emptyGroups()): StepGroups {
  const parsed = yaml.load(text) as { steps?: unknown } | unknown[] | null;
  const steps = Array.isArray(parsed) ? parsed : (parsed as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return into;
  for (const entry of steps as PipelineStep[]) {
    if (!entry || typeof entry.group !== "string" || !Array.isArray(entry.steps)) continue;
    for (const child of entry.steps as PipelineStep[]) {
      if (child && typeof child === "object") addStep(into, entry.group, child);
    }
  }
  return into;
}

export function stepGroupsFromDeferred(text: string, into = emptyGroups()): StepGroups {
  const parsed = JSON.parse(text) as DeferredFile;
  for (const entry of parsed.steps ?? []) {
    if (typeof entry.group === "string" && entry.step) addStep(into, entry.group, entry.step);
  }
  return into;
}

function headers(token: string) {
  return { Accept: "application/json", Authorization: `Bearer ${token}` };
}

type Artifact = { path: string; download_url: string; state?: string };

async function findArtifacts(
  token: string,
  organization: string,
  pipeline: string,
  buildNumber: string,
): Promise<Map<string, Artifact>> {
  const wanted = new Map<string, Artifact>();
  let url: string | null =
    `${REST_ENDPOINT}/organizations/${encodeURIComponent(organization)}/pipelines/${encodeURIComponent(pipeline)}/builds/${encodeURIComponent(buildNumber)}/artifacts?per_page=100`;
  // Bootstrap uploads these first, so they sit on the first page.
  for (let page = 0; url && page < ARTIFACT_PAGE_LIMIT; page++) {
    const response: Response = await fetch(url, { headers: headers(token), cache: "no-store" });
    if (!response.ok) throw new Error(`Buildkite artifacts request failed: ${response.status}`);
    for (const artifact of (await response.json()) as Artifact[]) {
      if ((artifact.path === PIPELINE_PATH || artifact.path === DEFERRED_PATH) &&
        (artifact.state ?? "finished") === "finished" && !wanted.has(artifact.path)) {
        wanted.set(artifact.path, artifact);
      }
    }
    if (wanted.size === 2) break;
    url = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return wanted;
}

async function downloadArtifact(token: string, artifact: Artifact): Promise<string> {
  // The download endpoint redirects to a presigned S3 URL; follow it by hand
  // so the Buildkite token is never sent to S3.
  const redirect = await fetch(artifact.download_url, {
    headers: headers(token),
    redirect: "manual",
    cache: "no-store",
  });
  const location = redirect.headers.get("location");
  const response = location
    ? await fetch(location, { cache: "no-store" })
    : redirect;
  if (!response.ok) throw new Error(`Artifact download failed: ${response.status}`);
  return response.text();
}

export interface StepGroupsResult {
  groups: StepGroups;
  /** False until the pipeline artifact exists; callers should not cache that. */
  complete: boolean;
}

export async function fetchStepGroups(
  organization: string,
  pipeline: string,
  buildNumber: string,
): Promise<StepGroupsResult> {
  const token = process.env.BUILDKITE_API_TOKEN;
  if (!token) return { groups: emptyGroups(), complete: false };
  const artifacts = await findArtifacts(token, organization, pipeline, buildNumber);
  const groups = emptyGroups();
  const pipelineArtifact = artifacts.get(PIPELINE_PATH);
  const deferredArtifact = artifacts.get(DEFERRED_PATH);
  const [pipelineText, deferredText] = await Promise.all([
    pipelineArtifact ? downloadArtifact(token, pipelineArtifact) : null,
    deferredArtifact ? downloadArtifact(token, deferredArtifact) : null,
  ]);
  if (pipelineText) stepGroupsFromPipeline(pipelineText, groups);
  if (deferredText) stepGroupsFromDeferred(deferredText, groups);
  return { groups, complete: Boolean(pipelineText) };
}
