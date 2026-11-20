import assert from "node:assert/strict";
import test from "node:test";
import { groupBand, isGroupReason, linkLabel, nestGroups, type Groupable } from "./triage-groups";
import type { TriageLinkedItem } from "./triage-types";

function link(number: number, kind: "issue" | "pr", state = "open"): TriageLinkedItem {
  return {
    itemKey: `vllm-project/vllm#${number}`, number, kind, title: `t${number}`, state,
    htmlUrl: `https://github.com/vllm-project/vllm/issues/${number}`, score: null, band: null, owner: null,
  };
}

function item(number: number, kind: "issue" | "pr", score: number, band: string, fixes: number[] = []): Groupable {
  return { itemKey: `vllm-project/vllm#${number}`, kind, score, band, fixes: fixes.map((n) => link(n, "issue")) };
}

test("fix PRs nest under the highest-scored issue they fix that is in the list", () => {
  const items = [
    item(66694, "pr", 99, "page", [65906]),
    item(65906, "issue", 79, "page"),
    item(10, "pr", 60, "route", [1, 2]),
    item(1, "issue", 50, "route"),
    item(2, "issue", 55, "route"),
    item(11, "pr", 52, "route", [2]),
    item(12, "pr", 40, "route", [999]), // its issue isn't listed: stands alone
  ];
  const rows = nestGroups(items);
  assert.deepEqual(
    rows.map((row) => [row.item.itemKey.split("#")[1], row.members.map((m) => m.itemKey.split("#")[1])]),
    [["65906", ["66694"]], ["2", ["10", "11"]], ["1", []], ["12", []]],
  );
  // The issue's row is as urgent as its P0 fix.
  assert.equal(groupBand(nestGroups([item(5, "issue", 45, "route"), item(6, "pr", 90, "page", [5])])[0]), "page");
  assert.equal(groupBand(rows[2]), "route");
});

test("group reasons and link labels", () => {
  assert.ok(isGroupReason("fixes #65385") && isGroupReason("fixed by #67812"));
  assert.ok(!isGroupReason("authored #61343") && !isGroupReason("fixes 65385"));
  assert.equal(linkLabel(link(67812, "pr", "merged")), "#67812 (merged)");
  assert.equal(linkLabel(link(65385, "issue")), "#65385");
});
