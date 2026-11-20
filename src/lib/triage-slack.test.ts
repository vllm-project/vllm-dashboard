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
  const done = parseSlackInteraction(interaction({ action_id: SLACK_ACTIONS.done, value: "vllm-project/vllm#48071" }));
  assert.equal(done.kind === "action" && done.action, "done");
  const doneMenu = parseSlackInteraction(interaction({ action_id: SLACK_ACTIONS.menu, selected_option: { value: "done|vllm-project/vllm#48071" } }));
  assert.equal(doneMenu.kind === "action" && doneMenu.action, "done");
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

test("ack keeps the buttons (Done replaces Ack); done / not mine / reassign leave only Open", () => {
  const key = "vllm-project/vllm#48071";
  const button = (action_id: string, extra: Record<string, unknown> = {}) => ({ type: "button", action_id, ...extra });
  const blocks = [
    { type: "header", block_id: "h" },
    { type: "section", block_id: `triage:item:${key}` },
    {
      type: "actions",
      block_id: `triage:actions:${key}`,
      elements: [
        button(SLACK_ACTIONS.ack, { value: key }),
        button(SLACK_ACTIONS.notMine, { value: key }),
        { type: "static_select", action_id: SLACK_ACTIONS.reassign },
        button(SLACK_ACTIONS.open, { url: "https://ci.vllm.ai/triage?item=x" }),
      ],
    },
    { type: "context", block_id: "footer" },
  ];
  const acked = blocksAfterAction(blocks, key, "ack", "khluu", null, new Date(0));
  assert.deepEqual(acked.map((b) => b.block_id), ["h", `triage:item:${key}`, `triage:result:${key}`, `triage:actions:${key}`, "footer"]);
  const ids = (acked[3].elements as { action_id: string }[]).map((e) => e.action_id);
  assert.deepEqual(ids, [SLACK_ACTIONS.done, SLACK_ACTIONS.notMine, SLACK_ACTIONS.reassign, SLACK_ACTIONS.open]);
  assert.match(JSON.stringify(acked[2]), /Acked by \*khluu\*/);

  // A later click on the same message replaces the result line, not adds one.
  const done = blocksAfterAction(acked, key, "done", "khluu", null, new Date(0));
  assert.deepEqual(done.map((b) => b.block_id), ["h", `triage:item:${key}`, `triage:result:${key}`, `triage:actions:${key}`, "footer"]);
  assert.deepEqual((done[3].elements as { action_id: string }[]).map((e) => e.action_id), [SLACK_ACTIONS.open]);
  assert.match(JSON.stringify(done[2]), /Marked done/);

  // On a group, the result line says which fix PRs the click applied to too.
  const group = blocksAfterAction(blocks, key, "ack", "gau-nernst", null, new Date(0), "en", ["vllm-project/vllm#67812"]);
  assert.match(JSON.stringify(group[2]), /Acked by \*gau-nernst\* \(and its fix #67812\)/);
  const vi = blocksAfterAction(blocks, key, "done", "gau-nernst", null, new Date(0), "vi", ["vllm-project/vllm#67812"]);
  assert.match(JSON.stringify(vi[2]), /cùng bản sửa #67812/);

  const moved = blocksAfterAction(blocks, key, "reassign", "khluu", "gau-nernst", new Date(0));
  assert.match(JSON.stringify(moved[2]), /Reassigned to \*gau-nernst\* by khluu/);
  assert.deepEqual((moved[3].elements as { action_id: string }[]).map((e) => e.action_id), [SLACK_ACTIONS.open]);
});

test("digest menus: ack swaps Ack for Done, leaving ends with just Open", () => {
  const key = "vllm-project/vllm#48071";
  const menu = {
    type: "overflow",
    action_id: SLACK_ACTIONS.menu,
    options: [
      { value: `ack|${key}` },
      { value: `not_mine|${key}` },
      { value: "open", url: "https://ci.vllm.ai/triage?item=x" },
    ],
  };
  const blocks = [{ type: "section", block_id: `triage:item:${key}`, accessory: menu }, { type: "section", block_id: "triage:item:x/y#2" }];
  const acked = blocksAfterAction(blocks, key, "ack", "khluu", null, new Date(0));
  assert.deepEqual(acked.map((b) => b.block_id), [`triage:item:${key}`, `triage:result:${key}`, "triage:item:x/y#2"]);
  const options = (acked[0].accessory as { options: { value: string }[] }).options.map((o) => o.value);
  assert.deepEqual(options, [`done|${key}`, `not_mine|${key}`, "open"]);
  const gone = blocksAfterAction(acked, key, "not_mine", "khluu", null, new Date(0));
  assert.deepEqual((gone[0].accessory as { options: { value: string }[] }).options.map((o) => o.value), ["open"]);
  assert.equal(gone.filter((b) => b.block_id === `triage:result:${key}`).length, 1);
});

test("Vietnamese confirmation for maintainers with language: vi", () => {
  const key = "vllm-project/vllm#65385";
  const blocks = [
    { type: "section", block_id: `triage:item:${key}` },
    { type: "actions", block_id: `triage:actions:${key}`, elements: [{ type: "button", action_id: SLACK_ACTIONS.ack, value: key }] },
  ];
  const out = blocksAfterAction(blocks, key, "ack", "gau-nernst", null, new Date(0), "vi");
  assert.match(JSON.stringify(out[1]), /gau-nernst\* đã nhận việc/);
  assert.match(JSON.stringify(out[2]), /Hoàn thành/);
  assert.match(JSON.stringify(blocksAfterAction(blocks, key, "reassign", "gau-nernst", "khluu", new Date(0), "vi")[1]), /đã chuyển cho \*khluu\*/);
  // Everyone else stays in English.
  assert.match(JSON.stringify(blocksAfterAction(blocks, key, "ack", "khluu", null, new Date(0))[1]), /Acked by \*khluu\*/);
});

test("compact digest clicks update metadata without changing titles, fixes or other groups", () => {
  const key = "vllm-project/vllm#68575";
  for (const [initial, ackedLabel, doneLabel] of [["needs your ack", "acked", "done"], ["chờ bạn nhận", "đã nhận", "đã hoàn thành"]]) {
    const title = "*<https://ci.vllm.ai/triage?item=vllm-project%2Fvllm%2368575|needs your ack in a title>*";
    const meta = "<https://github.com/vllm-project/vllm/issues/68575|#68575> · wrong output · 33h · ";
    const fix = "↳ Fix <https://github.com/vllm-project/vllm/pull/68597|#68597> · ready for review · CI ✓";
    const other = { type: "section", block_id: "triage:item:vllm-project/vllm#2", text: { type: "mrkdwn", text: meta + initial } };
    const blocks = [{ type: "section", block_id: `triage:item:${key}`,
      text: { type: "mrkdwn", text: `${title}\n${meta}${initial}\n${fix}` },
      accessory: { type: "overflow", options: [{ value: `ack|${key}` }, { value: `not_mine|${key}` }, { value: "open", url: "https://ci.vllm.ai/triage" }] },
    }, other];
    const acked = blocksAfterAction(blocks, key, "ack", "robert", null, new Date(0));
    assert.equal((acked[0].text as { text: string }).text, `${title}\n${meta}${ackedLabel}\n${fix}`);
    assert.deepEqual(acked[2], other);
    const done = blocksAfterAction(acked, key, "done", "robert", null, new Date(0));
    assert.equal((done[0].text as { text: string }).text, `${title}\n${meta}${doneLabel}\n${fix}`);
    assert.equal(done.filter((b) => b.block_id === `triage:result:${key}`).length, 1);
  }
});
