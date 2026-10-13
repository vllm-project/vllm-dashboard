import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

type Frag = { text: string; values: unknown[] };
type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
let current: Sql = () => { throw new Error("no fake installed"); };

// Runs queryLatestTestTimings against a fake sql tag that records the
// build-selection statement (nested fragments inlined) and finds no builds.
async function buildSelection(t: test.TestContext, queue: string | null): Promise<Frag> {
  await import("@/lib/db");
  const dbModule = require.cache[require.resolve("@/lib/db")];
  assert.ok(dbModule);
  const originalExports = dbModule.exports;
  const calls: Frag[] = [];
  current = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const frag: Frag = { text: "", values: [] };
    strings.forEach((s, i) => {
      frag.text += s;
      if (i >= values.length) return;
      const v = values[i] as Frag;
      if (v && typeof v === "object" && "text" in v) {
        frag.text += v.text;
        frag.values.push(...v.values);
      } else {
        frag.text += "?";
        frag.values.push(v);
      }
    });
    if (!frag.text.includes("SELECT")) return frag; // a nested fragment
    calls.push(frag);
    return Promise.resolve([]);
  };
  // Replace the DB boundary before loading the module, without opening a
  // connection. latest-test-timings caches the db module's exports on first
  // load, so install one stable getDb and point it at this call's fake.
  dbModule.exports = { getDb: () => (...args: Parameters<Sql>) => current(...args) };
  t.after(() => { dbModule.exports = originalExports; });
  const { queryLatestTestTimings } = await import("./latest-test-timings");
  assert.equal(await queryLatestTestTimings("step-a", { queue }), null);
  return calls[0];
}

test("a queue limits build selection to builds whose job ran on it", async (t) => {
  const select = await buildSelection(t, "amd_mi355_dpx");
  assert.match(select.text, /AND step_key = \? AND agent_queue = \?\n\s+AND start_time/);
  assert.deepEqual(select.values, ["step-a", "amd_mi355_dpx", 14, 20]);
});

test("without a queue the build-selection SQL has no queue predicate", async (t) => {
  const select = await buildSelection(t, null);
  assert.ok(!select.text.includes("agent_queue"));
  assert.match(select.text, /AND step_key = \?\n\s+AND start_time >= NOW\(\)/);
  assert.deepEqual(select.values, ["step-a", 14, 20]);
});
