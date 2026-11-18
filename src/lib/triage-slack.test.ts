import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  blocksAfterAction,
  isSlackResponseUrl,
  parseSlackInteraction,
  SLACK_ACTIONS,
  verifySlackSignature,
} from "./triage-slack";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const sign = (ts: string, body: string, secret = SECRET) =>
  `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

test("Slack signatures: valid, tampered, wrong secret, stale, missing", () => {
  const now = 1_800_000_000;
  const ts = String(now - 10);
  const body = "payload=%7B%7D";
  assert.equal(verifySlackSignature(SECRET, ts, sign(ts, body), body, now), true);
  assert.equal(verifySlackSignature(SECRET, ts, sign(ts, body), `${body}x`, now), false);
  assert.equal(verifySlackSignature(SECRET, ts, sign(ts, body, "other-secret"), body, now), false);
  const old = String(now - 301);
  assert.equal(verifySlackSignature(SECRET, old, sign(old, body), body, now), false); // replay window
  assert.equal(verifySlackSignature(undefined, ts, sign(ts, body), body, now), false);
  assert.equal(verifySlackSignature(SECRET, null, sign(ts, body), body, now), false);
  assert.equal(verifySlackSignature(SECRET, "12abc", sign(ts, body), body, now), false);
});

const RESPONSE_URL = "https://hooks.slack.com/actions/T0/123/abc";
function interaction(action: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const payload = {
    type: "block_actions",
    user: { id: "U07QCLE6Y8P" },
    response_url: RESPONSE_URL,
    message: { blocks: [{ type: "section", block_id: "triage:item:vllm-project/vllm#48071" }] },
    actions: [action],
    ...extra,
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

test("parses ack, not mine, reassign and digest menu clicks", () => {
  const ack = parseSlackInteraction(interaction({ action_id: SLACK_ACTIONS.ack, value: "vllm-project/vllm#48071" }));
  assert.equal(ack.kind === "action" && ack.action, "ack");
  assert.equal(ack.kind === "action" && ack.slackUserId, "U07QCLE6Y8P");

  const reassign = parseSlackInteraction(interaction({
    action_id: SLACK_ACTIONS.reassign,
    block_id: "triage:actions:vllm-project/vllm#48071",
    selected_option: { value: "gau-nernst" },
  }));
  assert.deepEqual(
    reassign.kind === "action" && [reassign.action, reassign.itemKey, reassign.target],
    ["reassign", "vllm-project/vllm#48071", "gau-nernst"],
  );

  const menu = parseSlackInteraction(interaction({
    action_id: SLACK_ACTIONS.menu,
    selected_option: { value: "not_mine|vllm-project/vllm#48071" },
  }));
  assert.equal(menu.kind === "action" && menu.action, "not_mine");
  // The "Open" link option and link buttons are ignored.
  assert.equal(parseSlackInteraction(interaction({ action_id: SLACK_ACTIONS.menu, selected_option: { value: "open" } })).kind, "ignore");
  assert.equal(parseSlackInteraction(interaction({ action_id: SLACK_ACTIONS.open })).kind, "ignore");
});

test("rejects malformed or unsafe interactions", () => {
  assert.equal(parseSlackInteraction("payload=not-json").kind, "error");
  assert.equal(parseSlackInteraction(interaction({ action_id: SLACK_ACTIONS.ack, value: "drop table" })).kind, "error");
  assert.equal(parseSlackInteraction(interaction({
    action_id: SLACK_ACTIONS.reassign, block_id: "triage:actions:vllm-project/vllm#1", selected_option: { value: "bad login!" },
  })).kind, "error");
  // Follow-ups only ever go to Slack's own webhook host.
  assert.equal(parseSlackInteraction(interaction({ action_id: SLACK_ACTIONS.ack, value: "vllm-project/vllm#1" },
    { response_url: "https://evil.example/hook" })).kind, "error");
  assert.equal(isSlackResponseUrl("http://hooks.slack.com/x"), false);
  assert.equal(parseSlackInteraction(interaction({}, { type: "view_submission" })).kind, "ignore");
});

test("after a click the item's buttons are replaced by the result", () => {
  const key = "vllm-project/vllm#48071";
  const blocks = [
    { type: "header", block_id: "h" },
    { type: "section", block_id: `triage:item:${key}`, accessory: { type: "overflow" } },
    { type: "actions", block_id: `triage:actions:${key}`, elements: [] },
    { type: "context", block_id: "footer" },
  ];
  const out = blocksAfterAction(blocks, key, "reassign", "khluu", "gau-nernst", new Date(0));
  assert.deepEqual(out.map((b) => b.block_id), ["h", `triage:item:${key}`, `triage:result:${key}`, "footer"]);
  assert.equal("accessory" in out[1], false);
  assert.match(JSON.stringify(out[2]), /Reassigned to \*gau-nernst\* by khluu/);
  // Digest lines have no actions block: the result goes right under the item.
  const digest = blocksAfterAction([blocks[1], { type: "section", block_id: "triage:item:x/y#2" }], key, "ack", "khluu", null, new Date(0));
  assert.deepEqual(digest.map((b) => b.block_id), [`triage:item:${key}`, `triage:result:${key}`, "triage:item:x/y#2"]);
});
