import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { NextRequest } from "next/server";

const require = createRequire(import.meta.url);

test("metrics route preserves snapshot readings and describes history buckets", async (t) => {
  await import("@/lib/db");
  const dbModule = require.cache[require.resolve("@/lib/db")];
  assert.ok(dbModule);
  const originalExports = dbModule.exports;
  let query: (statement: string, parameters: unknown[]) => unknown[] | Promise<unknown[]> = () => [];
  const db = Object.assign(
    (strings: TemplateStringsArray, ...parameters: unknown[]) =>
      Promise.resolve(query(strings.join("?"), parameters)),
    {
      unsafe: (statement: string, parameters: unknown[]) =>
        Promise.resolve(query(statement, parameters)),
    },
  );
  // Replace the DB boundary before loading the route, without opening a connection.
  dbModule.exports = { getDb: () => db };
  t.after(() => { dbModule.exports = originalExports; });
  const { GET } = await import("./route");

  await t.test("latest nulls never borrow older percentiles from the same queue", async () => {
    const previous = {
      queue: "snapshot-null",
      agents_idle: 0, agents_busy: 2, agents_total: 2,
      jobs_scheduled: 3, jobs_running: 2, jobs_waiting: 1, jobs_total: 6,
      p50_wait_secs: 60, p90_wait_secs: 120, p95_wait_secs: 180, p99_wait_secs: 240,
    };
    const latest = [
      {
        ...previous,
        polled_at: "2026-10-01T12:00:00.000Z",
        p50_wait_secs: null, p90_wait_secs: null,
        p95_wait_secs: null, p99_wait_secs: null,
      },
      {
        ...previous,
        queue: "snapshot-partial",
        polled_at: "2026-10-01T12:00:00.000Z",
        p50_wait_secs: 0, p90_wait_secs: null,
        p95_wait_secs: 180, p99_wait_secs: null,
      },
    ];
    const snapshots = [
      { ...previous, time_bucket: "2026-10-01T11:55:00.000Z" },
      ...latest.map(({ polled_at, ...row }) => ({ ...row, time_bucket: polled_at })),
    ];
    let latestQueries = 0;
    query = (statement) => {
      if (!statement.includes("DISTINCT ON")) return snapshots;
      latestQueries++;
      assert.doesNotMatch(statement, /JOIN|IS NOT NULL|CASE WHEN/i);
      assert.match(statement, /SELECT DISTINCT ON \(queue\)\s+queue, polled_at/);
      assert.match(statement, /p50_wait_secs, p90_wait_secs, p95_wait_secs,/);
      assert.match(statement, /to_jsonb\(queue_snapshots\) ->> 'p99_wait_secs'/);
      assert.match(statement, /ORDER BY queue, polled_at DESC/);
      return latest;
    };

    const response = await GET(new NextRequest(
      "http://localhost/api/metrics?hours=5",
    ));
    assert.equal(response.status, 200);
    assert.equal(latestQueries, 1);
    const result = await response.json();
    assert.deepEqual(result.latest, latest);
    assert.deepEqual(result.snapshots, snapshots);
    assert.deepEqual(result.queues, ["snapshot-null", "snapshot-partial"]);
  });

  await t.test("bucket metadata matches raw polling and each SQL aggregation boundary", async () => {
    for (const [hours, bucketMinutes] of [
      [1, 5], [6, 5], [7, 15], [24, 15],
      [25, 60], [168, 60], [169, 360], [2160, 360],
    ]) {
      for (const queue of [null, `bucket-${hours}`]) {
        let historyQueries = 0;
        query = (statement, parameters) => {
          if (statement.includes("pg_attribute")) return [{ has_p99: true }];
          if (statement.includes("DISTINCT ON")) return [];
          historyQueries++;
          if (hours <= 6) {
            assert.match(statement, /polled_at AS time_bucket/);
            assert.doesNotMatch(statement, /GROUP BY/);
          } else {
            assert.ok(statement.includes(
              `FLOOR(EXTRACT(epoch FROM polled_at) / ${bucketMinutes * 60}) * ${bucketMinutes * 60}`,
            ));
            assert.match(statement, /GROUP BY time_bucket, queue/);
            const waitAggregates = statement.split("\n").filter((line) =>
              /AS p(?:50|90|95|99)_wait_secs/.test(line),
            );
            assert.equal(waitAggregates.length, 4);
            for (const aggregate of waitAggregates) {
              assert.match(aggregate, /FILTER \(WHERE agents_total > 0\)/);
            }
            assert.match(statement, /AVG\(p99_wait_secs::real\)/);
            assert.doesNotMatch(statement, /to_jsonb/);
            assert.match(statement, /ROUND\(AVG\(jobs_scheduled\)\)::int AS jobs_scheduled/);
            assert.match(statement, /ROUND\(AVG\(jobs_waiting\)\)::int AS jobs_waiting/);
          }
          assert.equal(parameters.length, queue ? 2 : 1);
          if (queue) assert.equal(parameters[1], queue);
          return [];
        };
        const params = new URLSearchParams({ hours: String(hours) });
        if (queue) params.set("queue", queue);
        const response = await GET(new NextRequest(
          `http://localhost/api/metrics?${params}`,
        ));
        assert.equal(response.status, 200);
        assert.equal(historyQueries, 1);
        assert.deepEqual((await response.json()).query, { hours, queue, bucketMinutes });
      }
    }
  });

  await t.test("latest-only reads skip history and cannot populate the history cache", async () => {
    for (const [hours, bucketMinutes] of [[1, 5], [24, 15]]) {
      const queue = `latest-only-${hours}`;
      const latest = [{ queue, polled_at: "2026-10-01T12:00:00.000Z", p95_wait_secs: null }];
      const snapshots = [{ queue, time_bucket: "2026-10-01T11:55:00.000Z", p95_wait_secs: 60 }];
      let latestQueries = 0;
      let historyQueries = 0;
      query = (statement) => {
        if (statement.includes("DISTINCT ON")) {
          latestQueries++;
          return latest;
        }
        historyQueries++;
        return snapshots;
      };
      const url = `http://localhost/api/metrics?hours=${hours}&queue=${queue}`;
      const current = await GET(new NextRequest(`${url}&latest=1`));
      assert.equal(current.status, 200);
      assert.deepEqual(await current.json(), {
        query: { hours, queue, bucketMinutes },
        latest,
        snapshots: [],
        queues: [queue],
      });
      assert.equal(latestQueries, 1);
      assert.equal(historyQueries, 0);

      const history = await GET(new NextRequest(url));
      assert.equal(history.status, 200);
      assert.deepEqual((await history.json()).snapshots, snapshots);
      assert.equal(latestQueries, 2);
      assert.equal(historyQueries, 1);

      const cachedCurrent = await GET(new NextRequest(`${url}&latest=1`));
      assert.deepEqual((await cachedCurrent.json()).snapshots, []);
      const cachedHistory = await GET(new NextRequest(`${url}&latest=0`));
      assert.deepEqual((await cachedHistory.json()).snapshots, snapshots);
      assert.equal(latestQueries, 2);
      assert.equal(historyQueries, 1);
    }
  });

  await t.test("aggregate P99 capability checks are shared, cached, and refreshed after migration", async (t) => {
    let now = Date.now() + 5 * 60_000 + 1;
    t.mock.method(Date, "now", () => now);
    let hasP99 = false;
    let schemaQueries = 0;
    const historyStatements: string[] = [];
    query = (statement) => {
      if (statement.includes("pg_attribute")) {
        schemaQueries++;
        assert.match(statement, /attrelid = 'queue_snapshots'::regclass/);
        assert.match(statement, /attname = 'p99_wait_secs'/);
        assert.match(statement, /attnum > 0 AND NOT attisdropped/);
        return [{ has_p99: hasP99 }];
      }
      if (statement.includes("GROUP BY")) historyStatements.push(statement);
      return [];
    };
    const request = (params: string) => GET(new NextRequest(
      `http://localhost/api/metrics?${params}`,
    ));
    await request("hours=24&queue=schema-latest&latest=1");
    await request("hours=1&queue=schema-raw");
    assert.equal(schemaQueries, 0, "raw and latest reads keep their JSON fallback");

    const responses = await Promise.all([
      request("hours=24&queue=schema-a"),
      request("hours=24&queue=schema-b"),
    ]);
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(schemaQueries, 1, "concurrent history requests share the probe");
    assert.equal(historyStatements.length, 2);
    assert.ok(historyStatements.every((statement) => statement.includes("AVG(NULL::real)")));

    hasP99 = true;
    await request("hours=24&queue=schema-c");
    assert.equal(schemaQueries, 1, "a cached negative result avoids another probe");
    assert.match(historyStatements.at(-1)!, /AVG\(NULL::real\)/);

    now += 5 * 60_000 + 1;
    const migrated = await request("hours=24&queue=schema-d");
    assert.equal(migrated.status, 200);
    assert.equal(schemaQueries, 2);
    assert.match(historyStatements.at(-1)!, /AVG\(p99_wait_secs::real\)/);
    assert.doesNotMatch(historyStatements.at(-1)!, /to_jsonb/);
  });

  await t.test("concurrent requests share one history and latest cache fill", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let historyQueries = 0;
    let latestQueries = 0;
    query = async (statement) => {
      if (statement.includes("DISTINCT ON")) {
        latestQueries++;
        return [{ queue: "shared-fill" }];
      }
      historyQueries++;
      started.resolve();
      await gate.promise;
      return [{ queue: "shared-fill", jobs_running: 2 }];
    };
    const url = "http://localhost/api/metrics?hours=1&queue=shared-fill";
    const requests = Array.from({ length: 3 }, () => GET(new NextRequest(url)));
    try {
      await started.promise;
      assert.equal(historyQueries, 1);
      assert.equal(latestQueries, 1);
      gate.resolve();
      const responses = await Promise.all(requests);
      assert.ok(responses.every((response) => response.status === 200));
      const bodies = await Promise.all(responses.map((response) => response.json()));
      for (const body of bodies) assert.deepEqual(body, bodies[0]);
      assert.deepEqual(bodies[0].snapshots, [{ queue: "shared-fill", jobs_running: 2 }]);
      const cached = await GET(new NextRequest(url));
      assert.deepEqual(await cached.json(), bodies[0]);
      assert.equal(historyQueries, 1);
      assert.equal(latestQueries, 1);
    } finally {
      gate.resolve();
      await Promise.all(requests);
    }
  });
});
