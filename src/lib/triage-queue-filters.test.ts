import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { queueFocusCte, queueViewWhere } from "./triage-queue-filters";
import type { QueueFilters } from "./triage-query";

// Use only an explicitly supplied disposable database; tables are session-local.
test("queue SQL filters before pagination and handles missing/closed data", { skip: !process.env.TRIAGE_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.TRIAGE_TEST_DATABASE_URL!.replace("@/", "@localhost/"));
  const socketHost = url.searchParams.get("host");
  url.searchParams.delete("host");
  const db = postgres(url.toString(), { max: 1, ...(socketHost ? { host: socketHost } : {}) });
  try {
    await db`CREATE TEMP TABLE triage_items (item_key text, repo text, number int, kind text, state text DEFAULT 'open', draft boolean DEFAULT false, prepass jsonb DEFAULT '{}')`;
    await db`CREATE TEMP TABLE triage_extractions (id serial, item_key text, facets jsonb, created_at timestamptz DEFAULT now())`;
    await db`CREATE TEMP TABLE triage_scores (item_key text, band text DEFAULT 'route', scored_at timestamptz DEFAULT now(), routable_since timestamptz DEFAULT now())`;
    await db`CREATE TEMP TABLE triage_assignments (item_key text, role text DEFAULT 'primary', status text, assigned_at timestamptz DEFAULT now())`;
    const item = async (n: number, kind = "pr", prepass = {}, facets = {}, state = "open", repo = "vllm-project/vllm") => {
      const key = `${repo}#${n}`;
      await db`INSERT INTO triage_items (item_key, repo, number, kind, prepass, state) VALUES (${key}, ${repo}, ${n}, ${kind}, ${db.json(prepass)}, ${state})`;
      await db`INSERT INTO triage_scores (item_key) VALUES (${key})`;
      await db`INSERT INTO triage_extractions (item_key, facets) VALUES (${key}, ${db.json(facets)})`;
    };
    const matching = async (focus: QueueFilters["focus"], review: QueueFilters["review"] = null, limit = 100) => db<{ number: number; total: number }[]>`
      ${queueFocusCte(db, focus, review)}
      SELECT i.number, count(*) OVER ()::int AS total FROM triage_items i
      LEFT JOIN triage_scores s USING (item_key)
      LEFT JOIN LATERAL (SELECT facets FROM triage_extractions x WHERE x.item_key = i.item_key
                        ORDER BY x.created_at DESC, x.id DESC LIMIT 1) e ON true
      WHERE true ${queueViewWhere(db, { focus, review })} ORDER BY i.number LIMIT ${limit}
    `;
    const nums = (rows: { number: number }[]) => rows.map((r) => r.number);
    await item(1, "issue");
    await item(2, "pr", { fixes_issues: [1, 1] });
    await item(3, "pr", {}, { pr: { fixes_issues: [1] } });
    await item(4, "pr", { fixes_issues: [9] });
    await item(5, "pr", { fixes_issues: [9] }, {}, "closed");
    await item(6, "pr", {}, { pr: { low_effort: true } });
    await item(7, "pr", {}, { slop_signals: ["low effort"] });
    await item(8, "pr", { fixes_issues: "malformed" }, { slop_signals: null, pr: null });
    // Draft PRs must not drag a ready PR into Close / dedup as a competing fix.
    await item(14, "pr", { fixes_issues: [9] });
    await db`UPDATE triage_items SET draft = true WHERE number = 14`;
    // Same issue number in a different repository must not create a competing fix.
    await item(10, "pr", { fixes_issues: [9] }, {}, "open", "other/repo");
    assert.deepEqual(nums(await matching("cleanup")), [2, 3, 6, 7]);
    assert.deepEqual(nums(await matching(null, "cleanup")), [2, 3, 6, 7]);
    assert.deepEqual((await matching("cleanup", null, 1)).map((r) => [r.number, r.total]), [[2, 4]]);
    assert.deepEqual(nums(await matching("has-fix")), [1]);
    // Use the latest extraction, not an older low-effort judgement.
    await db`INSERT INTO triage_extractions (item_key, facets) VALUES ('vllm-project/vllm#6', '{}')`;
    assert.deepEqual(nums(await matching("cleanup")), [2, 3, 7]);
    await item(11, "issue", {}, { severity: { security: true } });
    await item(12, "issue", {}, { type: "regression" });
    await item(13, "pr", {}, { severity: { serving_broken: true } }, "closed");
    await db`INSERT INTO triage_assignments (item_key, status) VALUES ('vllm-project/vllm#11', 'acked')`;
    assert.deepEqual(nums(await matching("fires")), [11, 12]);
    await db`UPDATE triage_scores SET routable_since = now() - interval '4 days' WHERE item_key IN ('vllm-project/vllm#1', 'vllm-project/vllm#11')`;
    await db`INSERT INTO triage_assignments (item_key, status, assigned_at) VALUES ('vllm-project/vllm#2', 'open', now() - interval '4 days'), ('vllm-project/vllm#3', 'open', now())`;
    // Fresh routing of an old issue and freshly assigned work are not stale.
    await db`UPDATE triage_scores SET scored_at = now() - interval '8 days' WHERE item_key = 'vllm-project/vllm#3'`;
    assert.deepEqual(nums(await matching("stale")), [1, 2]);
    const ready = { waiting_on: "reviewer", merge_ready: true, merge_checked_at: new Date().toISOString() };
    await item(20, "pr", ready);
    await item(21, "pr", { ...ready, merge_ready: false });
    await item(22, "pr", { ...ready, merge_checked_at: "2020-01-01T00:00:00Z" });
    await item(23, "pr", { ...ready, waiting_on: "author" });
    await item(24, "pr", ready, {}, "closed");
    await item(25, "pr", ready);
    await db`UPDATE triage_items SET draft = true WHERE number = 25`;
    assert.deepEqual(nums(await matching(null, "merge")), [20]);
    assert.deepEqual(nums(await matching(null, "blocked")), [23]);
  } finally {
    await db.end();
  }
});
