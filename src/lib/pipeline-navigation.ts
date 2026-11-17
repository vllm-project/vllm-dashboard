export const DEFAULT_PIPELINE = "CI";

export function getPipeline(params: Pick<URLSearchParams, "get">): string {
  // An explicit empty value means all pipelines; an absent value means CI.
  return params.get("pipeline") ?? DEFAULT_PIPELINE;
}

/** Carry only the pipeline to another view, preserving that link's own filters. */
export function pipelineHref(href: string, pipeline: string): string {
  const url = new URL(href, "http://dashboard.local");
  if (pipeline === DEFAULT_PIPELINE) url.searchParams.delete("pipeline");
  else url.searchParams.set("pipeline", pipeline);
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

export function pipelineScopeNote(pathname: string): string | null {
  if (["/", "/jobs", "/cost"].includes(pathname)) return null;
  if (["/gpu", "/queue"].includes(pathname)) {
    return "This view shows shared infrastructure across all pipelines.";
  }
  return "This view shows vLLM data. Pipeline selection applies to Builds, Jobs, and Cost.";
}
