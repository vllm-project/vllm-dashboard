import assert from "node:assert/strict";
import test from "node:test";

import { headedBlocks, postMessage, updateMessage } from "./slack";

test("headedBlocks puts a header above the body", () => {
  assert.deepEqual(headedBlocks("⏳ QUEUE WAIT · 3 active", "\n\nline one\nline two\n\n"), [
    {
      type: "header",
      text: { type: "plain_text", text: "⏳ QUEUE WAIT · 3 active", emoji: true },
    },
    { type: "section", text: { type: "mrkdwn", text: "line one\nline two" } },
  ]);
});

test("headedBlocks cuts a header over 150 characters", () => {
  const [header] = headedBlocks("x".repeat(151), "");
  assert.equal((header as { text: { text: string } }).text.text, `${"x".repeat(149)}…`);
});

test("headedBlocks splits the body at lines under 3000 characters", () => {
  const lines = ["a".repeat(1000), "b".repeat(1000), "c".repeat(998), "d"];
  const sections = headedBlocks("t", lines.join("\n")).slice(1);
  assert.deepEqual(
    sections.map((block) => (block as { text: { text: string } }).text.text),
    [lines.slice(0, 3).join("\n"), "d"],
  );
});

test("headedBlocks keeps a header of exactly 150 characters", () => {
  const [header] = headedBlocks("x".repeat(150), "");
  assert.equal((header as { text: { text: string } }).text.text, "x".repeat(150));
});

test("headedBlocks gives a long line its own sections after a short one", () => {
  const sections = headedBlocks("t", `short\n${"z".repeat(6001)}`).slice(1);
  assert.deepEqual(
    sections.map((block) => (block as { text: { text: string } }).text.text),
    ["short", "z".repeat(3000), "z".repeat(3000), "z"],
  );
});

test("headedBlocks keeps a line of exactly 3000 characters whole", () => {
  const sections = headedBlocks("t", "y".repeat(3000)).slice(1);
  assert.deepEqual(
    sections.map((block) => (block as { text: { text: string } }).text.text),
    ["y".repeat(3000)],
  );
});

test("posts and edits go to the shared alert channel with their blocks", async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  const realToken = process.env.SLACK_BOT_TOKEN;
  const realChannel = process.env.SLACK_CI_ALERT_CHANNEL;
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  delete process.env.SLACK_CI_ALERT_CHANNEL;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, ts: "1.2" }));
  }) as typeof fetch;
  try {
    const blocks = headedBlocks("⏳ QUEUE WAIT · 1 active", "body");
    await postMessage("text", undefined, undefined, blocks);
    await updateMessage("1.2", "text", blocks);
    await updateMessage("1.2", "plain");
    process.env.SLACK_CI_ALERT_CHANNEL = "C0MOVED";
    await postMessage("moved");
  } finally {
    globalThis.fetch = realFetch;
    process.env.SLACK_BOT_TOKEN = realToken;
    if (realChannel === undefined) delete process.env.SLACK_CI_ALERT_CHANNEL;
    else process.env.SLACK_CI_ALERT_CHANNEL = realChannel;
  }
  const blocks = headedBlocks("⏳ QUEUE WAIT · 1 active", "body");
  assert.deepEqual(sent, [
    {
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "C0ANHBE642Y", text: "text", blocks },
    },
    {
      url: "https://slack.com/api/chat.update",
      body: { channel: "C0ANHBE642Y", ts: "1.2", text: "text", blocks },
    },
    {
      url: "https://slack.com/api/chat.update",
      body: { channel: "C0ANHBE642Y", ts: "1.2", text: "plain" },
    },
    {
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "C0MOVED", text: "moved" },
    },
  ]);
});

test("headedBlocks with no body is the header alone", () => {
  assert.equal(headedBlocks("t", "\n").length, 1);
});

test("posting without a bot token fails loudly", async () => {
  const realToken = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  try {
    await assert.rejects(postMessage("text"), /^Error: SLACK_BOT_TOKEN must be set$/);
  } finally {
    if (realToken !== undefined) process.env.SLACK_BOT_TOKEN = realToken;
  }
});
