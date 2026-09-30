import assert from "node:assert/strict";
import test from "node:test";
import { getDb, webDatabaseUrl } from "./db";

test("only shared Supabase session endpoints are routed to transaction mode", () => {
  const base = "postgres://user:p%40ss@aws-1-us-east-1.pooler.supabase.com";
  for (const port of ["", ":5432"]) {
    assert.equal(
      webDatabaseUrl(`${base}${port}/postgres?sslmode=require`),
      `${base}:6543/postgres?sslmode=require`,
    );
  }
  for (const url of [
    `${base}:6543/postgres`,
    `${base}:5433/postgres`,
    "postgres://user:pass@db.project.supabase.co:5432/postgres",
    "postgres://user:pass@localhost:5432/postgres",
    "postgres://user:pass@host1:5432,host2:5432/postgres",
    "postgres://user:pass@aws.pooler.supabase.com.example.org:5432/postgres",
  ]) {
    assert.equal(webDatabaseUrl(url), url);
  }
});

test("the web client uses transaction pooling for a Supabase session URL", async (t) => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL =
    "postgres://user:pass@aws-1-us-east-1.pooler.supabase.com:5432/postgres";
  const db = getDb();
  t.after(async () => {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    await db.end();
  });

  assert.deepEqual(db.options.port, [6543]);
  assert.equal(db.options.prepare, false);
});
