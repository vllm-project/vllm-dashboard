import assert from "node:assert/strict";
import test from "node:test";
import { reassignOptions } from "./triage-reassign";

const people = [
  { githubLogin: "zed", openPrimaries: 1 },
  { githubLogin: "Alice", openPrimaries: 3 },
  { githubLogin: "bob", openPrimaries: 0 },
  { githubLogin: "carol", openPrimaries: 5 },
  { githubLogin: "dave", openPrimaries: 2 },
  { githubLogin: "erin", openPrimaries: 0 },
];

test("high, then medium, then everyone else alphabetically; current owner left out", () => {
  const options = reassignOptions(
    people,
    [
      { maintainer: "carol", relevance: "medium" },
      { maintainer: "alice", relevance: "high" },
      { maintainer: "zed", relevance: "high" },
      { maintainer: "dave", relevance: "low" },
      { maintainer: "erin", relevance: "none" },
    ],
    ["BOB"],
  );
  assert.deepEqual(options.map((o) => o.login), ["zed", "Alice", "carol", "dave", "erin"]);
  assert.deepEqual(options.map((o) => o.label), [
    "zed · high match · 1 open",
    "Alice · high match · 3 open",
    "carol · medium match · 5 open",
    "dave · 2 open",
    "erin · 0 open",
  ]);
});

test("no judgements: alphabetical, case-insensitive, no duplicates", () => {
  const options = reassignOptions([...people, { githubLogin: "alice", openPrimaries: 9 }], [], []);
  assert.deepEqual(options.map((o) => o.login), ["Alice", "bob", "carol", "dave", "erin", "zed"]);
  assert.equal(options[0].relevance, null);
});

test("same match level: fewer open primaries first, then name", () => {
  const options = reassignOptions(
    [
      { githubLogin: "b", openPrimaries: 2 },
      { githubLogin: "a", openPrimaries: 2 },
      { githubLogin: "c", openPrimaries: 0 },
    ],
    ["a", "b", "c"].map((maintainer) => ({ maintainer, relevance: "high" as const })),
    [],
  );
  assert.deepEqual(options.map((o) => o.login), ["c", "a", "b"]);
});
