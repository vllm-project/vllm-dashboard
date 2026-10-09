import assert from "node:assert/strict";
import test from "node:test";
import { runtimeShard, SHARD_SUFFIX_SQL, SHARD_TOTAL_SQL, stepName } from "./job-shards";

test("runtime shards fold into their step; fixed parallel jobs stay apart", () => {
  assert.equal(stepName(":nvidia: (H200) Kernels Mamba shard 2/3"), ":nvidia: (H200) Kernels Mamba");
  assert.deepEqual(runtimeShard("Kernels Mamba shard 2/3"), { index: 2, total: 3 });
  for (const name of ["Language Models Test 3", "(H200) Language Models Shard 3", "unit test :amd: shard 1"]) {
    assert.equal(stepName(name), name);
    assert.equal(runtimeShard(name), null);
  }
});

test("the SQL patterns match what the TypeScript one does", () => {
  const suffix = new RegExp(SHARD_SUFFIX_SQL);
  const total = new RegExp(SHARD_TOTAL_SQL);
  assert.equal("Kernels shard 10/12".replace(suffix, ""), "Kernels");
  assert.equal("Kernels shard 10/12".match(total)?.[1], "12");
  assert.equal("Kernels Shard 3".match(suffix), null);
});
