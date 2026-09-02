import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHostRow } from "./gpu-host-data";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hostname: "h200-ci-1",
    cpu_util: 42.5,
    cpu_count: 64,
    ram_used_bytes: "103079215104",
    ram_total_bytes: "274877906944",
    ram_available_bytes: "171798691840",
    disks: [
      {
        mount_point: "/",
        device: "/dev/nvme0n1p2",
        fstype: "ext4",
        role: "system",
        used_bytes: 193273528320,
        total_bytes: 515396075520,
        error: null,
      },
    ],
    reporter_status: "ok",
    last_error: null,
    node_conditions: null,
    reported_at: new Date("2026-09-02T19:00:00.000Z"),
    ...overrides,
  };
}

test("normalizeHostRow coerces bigint columns from strings or BigInt", () => {
  const fromStrings = normalizeHostRow(row());
  assert.equal(fromStrings.ram_used_bytes, 103079215104);
  assert.equal(fromStrings.ram_total_bytes, 274877906944);

  const fromBigInt = normalizeHostRow(
    row({ ram_used_bytes: BigInt(103079215104) }),
  );
  assert.equal(fromBigInt.ram_used_bytes, 103079215104);
});

test("normalizeHostRow turns Date reported_at into an ISO string", () => {
  const host = normalizeHostRow(row());
  assert.equal(host.reported_at, "2026-09-02T19:00:00.000Z");
});

test("normalizeHostRow keeps degraded reporter status and last_error", () => {
  const host = normalizeHostRow(
    row({ reporter_status: "degraded", last_error: "smartctl: Permission denied" }),
  );
  assert.equal(host.reporter_status, "degraded");
  assert.equal(host.last_error, "smartctl: Permission denied");
});

test("normalizeHostRow passes parsed disks jsonb through untouched", () => {
  const host = normalizeHostRow(row());
  assert.equal(host.disks?.length, 1);
  assert.equal(host.disks?.[0].role, "system");
  assert.equal(host.disks?.[0].fstype, "ext4");
});

test("normalizeHostRow maps missing or malformed optionals to null", () => {
  const host = normalizeHostRow(
    row({
      cpu_util: null,
      cpu_count: null,
      ram_used_bytes: null,
      ram_total_bytes: null,
      ram_available_bytes: null,
      disks: null,
      node_conditions: "not-an-object",
    }),
  );
  assert.equal(host.cpu_util, null);
  assert.equal(host.cpu_count, null);
  assert.equal(host.ram_used_bytes, null);
  assert.equal(host.disks, null);
  assert.equal(host.node_conditions, null);
});

test("normalizeHostRow keeps valid node_conditions", () => {
  const conditions = {
    ready: true,
    disk_pressure: false,
    memory_pressure: null,
    pid_pressure: false,
    unschedulable: true,
  };
  const host = normalizeHostRow(row({ node_conditions: conditions }));
  assert.deepEqual(host.node_conditions, conditions);
});
