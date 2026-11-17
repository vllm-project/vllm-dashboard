import assert from "node:assert/strict";
import test from "node:test";
import { DASHBOARD_SECTIONS, sectionPages, TRIAGE_SECTION } from "./dashboard-navigation";
import { getPipeline, pipelineHref, pipelineScopeNote } from "./pipeline-navigation";

test("missing pipeline defaults to CI while an explicit empty value selects all", () => {
  assert.equal(getPipeline(new URLSearchParams()), "CI");
  assert.equal(getPipeline(new URLSearchParams("pipeline=")), "");
  assert.equal(getPipeline(new URLSearchParams("pipeline=speculators")), "speculators");
});

test("pipeline selection survives navigation through every dashboard section", () => {
  const pages = [...DASHBOARD_SECTIONS, TRIAGE_SECTION].flatMap(sectionPages);
  for (const pipeline of ["CI", "speculators", "", "AMD CI", "custom&pipeline+#"]) {
    for (const page of pages) {
      const href = pipelineHref(page.href, pipeline);
      const url = new URL(href, "https://ci.vllm.ai");
      assert.equal(url.pathname, page.href);
      assert.equal(getPipeline(url.searchParams), pipeline);
    }
  }
});

test("changing pipelines preserves the destination's filters and fragment", () => {
  const href = pipelineHref("/queue?view=traffic&range=168&pipeline=CI#queues", "speculators");
  const url = new URL(href, "https://ci.vllm.ai");
  assert.equal(url.searchParams.get("view"), "traffic");
  assert.equal(url.searchParams.get("range"), "168");
  assert.deepEqual(url.searchParams.getAll("pipeline"), ["speculators"]);
  assert.equal(url.hash, "#queues");
  assert.equal(pipelineHref(href, "CI"), "/queue?view=traffic&range=168#queues");
  assert.equal(pipelineHref("/jobs", "CI"), "/jobs");
  assert.equal(pipelineHref("/jobs", ""), "/jobs?pipeline=");
});

test("scope notes distinguish filtered views, shared infrastructure and vLLM data", () => {
  for (const path of ["/", "/jobs", "/cost"]) assert.equal(pipelineScopeNote(path), null);
  for (const path of ["/queue", "/gpu"]) assert.match(pipelineScopeNote(path)!, /all pipelines/);
  for (const path of ["/tests", "/alerts", "/perf", "/platforms", "/triage"]) {
    assert.match(pipelineScopeNote(path)!, /vLLM data/);
  }
});
