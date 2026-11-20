import assert from "node:assert/strict";
import test from "node:test";
import { fileDiffAnchor, prFilesUrl, summarizeFiles } from "./triage-files";

test("summarizeFiles: count, line totals and the first 15 paths", () => {
  const files = Array.from({ length: 18 }, (_, i) => ({ path: `vllm/f${i}.py`, additions: i, deletions: 1 }));
  const summary = summarizeFiles(files);
  assert.equal(summary.count, 18);
  assert.equal(summary.additions, 153);
  assert.equal(summary.deletions, 18);
  assert.equal(summary.shown.length, 15);
  assert.equal(summary.more, 3);
  assert.equal(summary.line, "18 files · +153 −18");
  assert.equal(summary.capped, false);
});

test("summarizeFiles: one file, no counts, junk entries", () => {
  assert.equal(summarizeFiles([{ path: "a.py", additions: 18, deletions: 4 }]).line, "1 file · +18 −4");
  const noCounts = summarizeFiles([{ path: "a.py" }, { path: "b.py" }]);
  assert.equal(noCounts.line, "2 files");
  assert.equal(noCounts.additions, null);
  const junk = summarizeFiles([null, 3, { path: "" }, { path: 7 }, { path: "ok.py", additions: -1, deletions: "2" }]);
  assert.equal(junk.count, 1);
  assert.deepEqual(junk.shown, [{ path: "ok.py", additions: null, deletions: null }]);
  assert.equal(summarizeFiles(undefined).count, 0);
  assert.equal(summarizeFiles(undefined).line, "0 files");
});

test("summarizeFiles: the 300-file ingest cap reads as 300+", () => {
  const files = Array.from({ length: 300 }, (_, i) => ({ path: `p${i}`, additions: 1, deletions: 0 }));
  const summary = summarizeFiles(files);
  assert.equal(summary.capped, true);
  assert.equal(summary.line, "300+ files · +300 −0");
  assert.equal(summary.more, 285);
});

test("prFilesUrl only for PR URLs", () => {
  assert.equal(prFilesUrl("https://github.com/vllm-project/vllm/pull/123"), "https://github.com/vllm-project/vllm/pull/123/files");
  assert.equal(prFilesUrl("https://github.com/vllm-project/vllm/issues/123"), null);
  assert.equal(prFilesUrl("javascript:alert(1)"), null);
});

test("fileDiffAnchor is GitHub's sha256 diff anchor", async () => {
  assert.equal(await fileDiffAnchor("README.md"), "diff-b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5");
});
