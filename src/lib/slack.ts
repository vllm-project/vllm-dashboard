interface SlackPostResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

export const ALERTS_SLACK_CHANNEL = "C0ANHBE642Y";

// Alerts share one channel, so each post leads with a header block,
// "<icon> SOURCE · what happened". Slack caps a header at 150 characters and
// a section at 3000.
const HEADER_LIMIT = 150;
const SECTION_LIMIT = 3000;

export type SlackBlock = Record<string, unknown>;

export function headedBlocks(title: string, body: string): SlackBlock[] {
  const header =
    title.length > HEADER_LIMIT ? `${title.slice(0, HEADER_LIMIT - 1)}…` : title;
  const chunks: string[] = [];
  let current = "";
  for (let line of body.replace(/^\n+|\n+$/g, "").split("\n")) {
    while (line.length > SECTION_LIMIT) {
      if (current) chunks.push(current);
      current = "";
      chunks.push(line.slice(0, SECTION_LIMIT));
      line = line.slice(SECTION_LIMIT);
    }
    let candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > SECTION_LIMIT) {
      chunks.push(current);
      candidate = line;
    }
    current = candidate;
  }
  if (current) chunks.push(current);
  return [
    { type: "header", text: { type: "plain_text", text: header, emoji: true } },
    ...chunks.map((text) => ({ type: "section", text: { type: "mrkdwn", text } })),
  ];
}

function getConfig() {
  const token = process.env.SLACK_BOT_TOKEN;
  // Every alert path shares one channel, told apart by each post's heading.
  const channel = process.env.SLACK_CI_ALERT_CHANNEL ?? ALERTS_SLACK_CHANNEL;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN must be set");
  }
  return { token, channel };
}

export async function postMessage(
  text: string,
  threadTs?: string,
  channelOverride?: string,
  blocks?: SlackBlock[],
): Promise<SlackPostResult> {
  const { token, channel: defaultChannel } = getConfig();
  const channel = channelOverride ?? defaultChannel;
  const body: Record<string, unknown> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;
  if (blocks) body.blocks = blocks;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return res.json();
}

export async function updateMessage(
  ts: string,
  text: string,
  blocks?: SlackBlock[],
): Promise<SlackPostResult> {
  const { token, channel } = getConfig();

  const res = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    // An edit with text but no blocks would drop the header.
    body: JSON.stringify({ channel, ts, text, ...(blocks ? { blocks } : {}) }),
  });

  return res.json();
}

export async function addReaction(
  name: string,
  messageTs: string,
): Promise<{ ok: boolean; error?: string }> {
  const { token, channel } = getConfig();

  const res = await fetch("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, name, timestamp: messageTs }),
  });

  return res.json();
}
