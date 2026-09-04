import assert from "node:assert/strict";
import test from "node:test";

import {
  BASELINE_WINDOW,
  DEDUPE_WINDOW_SECONDS,
  compareToRollingBaseline,
  dedupeEvalRows,
  median,
  type EvalRow,
} from "./eval-data";

function makeRow(overrides: Partial<EvalRow> = {}): EvalRow {
  return {
    ingest_ts: "2026-09-02T14:02:00Z",
    run_date: "2026-09-02T14:02:00Z",
    run_epoch: 1_788_358_920,
    model: "openai/gpt-oss-120b",
    task: "gsm8k",
    n_shot: 0,
    n_samples: 1319,
    git_hash: null,
    eval_seconds: 120,
    metrics: [
      {
        name: "exact_match",
        filter: "flexible-extract",
        value: 0.8362,
        stderr: 0.0102,
        higher_is_better: true,
      },
    ],
    image: "public.ecr.aws/q9t5s3a7/vllm-release-repo:33898f832c53c3e98999e0ec2c689f61ee92a9bc-x86_64",
    buildkite_build_id: "123",
    buildkite_build_number: "42",
    buildkite_build_url: "https://buildkite.example/42",
    buildkite_commit: null,
    vllm_commit: "33898f832c53c3e98999e0ec2c689f61ee92a9bc",
    workload: null,
    duplicateCount: 1,
    ...overrides,
  };
}

test("dedupeEvalRows merges identical runs within the window, keeping the earliest", () => {
  const base = makeRow();
  const rows = [
    makeRow({ run_epoch: base.run_epoch + 180, ingest_ts: "2026-09-02T14:05:00Z" }),
    makeRow({ run_epoch: base.run_epoch, ingest_ts: "2026-09-02T14:02:00Z" }),
    makeRow({ run_epoch: base.run_epoch + 60, ingest_ts: "2026-09-02T14:03:00Z" }),
    makeRow({ run_epoch: base.run_epoch + 300, ingest_ts: "2026-09-02T14:07:00Z" }),
  ];

  const out = dedupeEvalRows(rows);

  assert.equal(out.length, 1);
  assert.equal(out[0].run_epoch, base.run_epoch);
  assert.equal(out[0].duplicateCount, 4);
});

test("dedupeEvalRows keeps runs that differ in score, commit, image or samples", () => {
  const base = makeRow();
  const variants = [
    makeRow(),
    makeRow({
      metrics: [{ ...base.metrics[0], value: 0.84 }],
    }),
    makeRow({
      image: null,
      vllm_commit: "0000000000000000000000000000000000000000",
    }),
    makeRow({ image: null }),
    makeRow({ n_samples: 500 }),
    makeRow({ task: "aime25" }),
  ];

  const out = dedupeEvalRows(variants);

  assert.equal(out.length, variants.length);
  assert.ok(out.every((r) => r.duplicateCount === 1));
});

test("dedupeEvalRows starts a new group after the 10-minute window", () => {
  const rows = [
    makeRow({ run_epoch: 1000 }),
    makeRow({ run_epoch: 1000 + DEDUPE_WINDOW_SECONDS }),
    makeRow({ run_epoch: 1000 + DEDUPE_WINDOW_SECONDS + 1 }),
  ];

  const out = dedupeEvalRows(rows);

  assert.equal(out.length, 2);
  const counts = out.map((r) => r.duplicateCount).sort();
  assert.deepEqual(counts, [1, 2]);
});

test("dedupeEvalRows returns runs newest first", () => {
  const rows = [
    makeRow({ run_epoch: 1000 }),
    makeRow({ run_epoch: 5000, task: "aime25" }),
  ];

  const out = dedupeEvalRows(rows);

  assert.deepEqual(out.map((r) => r.run_epoch), [5000, 1000]);
});

test("median handles odd and even sample sizes", () => {
  assert.equal(median([0.8]), 0.8);
  assert.equal(median([0.7, 0.9, 0.8]), 0.8);
  assert.equal(median([0.7, 0.9]), 0.8);
  assert.equal(median([]), null);
});

test("compareToRollingBaseline returns null without prior runs", () => {
  assert.equal(compareToRollingBaseline({ value: 0.8, stderr: 0.01 }, []), null);
});

test("compareToRollingBaseline uses the median of the last K runs", () => {
  const prior = Array.from({ length: BASELINE_WINDOW + 2 }, (_, i) => ({
    value: 0.8 + i * 0.1, // newest-first: 0.8, 0.9, 1.0, ... only first K count
    stderr: 0.01,
  }));
  const cmp = compareToRollingBaseline({ value: 0.85, stderr: 0.01 }, prior);

  assert.ok(cmp);
  assert.equal(cmp.baselineCount, BASELINE_WINDOW);
  // Median of the first BASELINE_WINDOW values (0.8, 0.9, 1.0, 1.1, 1.2).
  assert.equal(cmp.baseline, 1.0);
});

test("compareToRollingBaseline flags changes beyond 2x stderr and 1pp", () => {
  const prior = [{ value: 0.8, stderr: 0.01 }];

  const small = compareToRollingBaseline({ value: 0.805, stderr: 0.01 }, prior);
  assert.ok(small);
  assert.equal(small.flagged, false); // 0.5pp < 2*stderr and < 1pp

  const big = compareToRollingBaseline({ value: 0.83, stderr: 0.01 }, prior);
  assert.ok(big);
  assert.equal(big.flagged, true);
  assert.ok(Math.abs(big.delta - 0.03) < 1e-9);
  assert.ok(Math.abs(big.sigma - 0.03 / Math.SQRT2 / 0.01) < 1e-9);
});

test("compareToRollingBaseline never flags sub-1pp moves even with tiny stderr", () => {
  const prior = [{ value: 0.8, stderr: 0.001 }];
  const cmp = compareToRollingBaseline({ value: 0.809, stderr: 0.001 }, prior);

  assert.ok(cmp);
  assert.equal(cmp.flagged, false); // 0.9pp below the 1pp floor despite 9 sigma
  assert.ok(cmp.sigma > 2);
});
