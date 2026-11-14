import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  missingProductionEnv,
  OPTIONAL_ENV,
  REQUIRED_PRODUCTION_ENV,
} from "./required-env";

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return entry === "route.ts" ? [path] : [];
  });
}

test("missingProductionEnv lists unset and blank variables", () => {
  const env = Object.fromEntries(
    Object.keys(REQUIRED_PRODUCTION_ENV).map((name) => [name, "x"]),
  );
  assert.deepEqual(missingProductionEnv(env), []);
  assert.deepEqual(
    missingProductionEnv({ ...env, CRON_SECRET: undefined, GITHUB_TOKEN: " " }),
    ["CRON_SECRET", "GITHUB_TOKEN"],
  );
});

// Every scheduled job runs unattended, so a variable it reads must either be
// required on production builds or have a working default. A new cron that
// reads a new secret fails this test until the secret is listed.
test("every variable the cron routes read is required or knowingly optional", () => {
  const files = [
    ...routeFiles("src/app/api/cron"),
    "src/app/api/alerts/queue/route.ts",
    "src/lib/operator-auth.ts",
    "src/lib/slack.ts",
    "src/lib/db.ts",
    "src/lib/databricks.ts",
    "src/lib/buildkite-queue-metrics.ts",
    "src/lib/buildkite-queue-jobs.ts",
    "src/lib/force-merge-stats.ts",
  ];
  const read = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      read.add(match[1]);
    }
  }
  assert.ok(read.has("CRON_SECRET"));
  const unaccounted = [...read].filter(
    (name) => !(name in REQUIRED_PRODUCTION_ENV) && !OPTIONAL_ENV.has(name),
  );
  assert.deepEqual(unaccounted, []);
});

test("vercel.json crons all point at routes that exist", () => {
  const { crons } = JSON.parse(readFileSync("vercel.json", "utf8")) as {
    crons: Array<{ path: string }>;
  };
  for (const { path } of crons) {
    assert.ok(
      statSync(join("src/app", path, "route.ts")).isFile(),
      `${path} has no route.ts`,
    );
  }
});
