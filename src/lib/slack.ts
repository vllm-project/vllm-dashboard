interface SlackPostResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

function getConfig() {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) {
    throw new Error("SLACK_BOT_TOKEN and SLACK_CHANNEL_ID must be set");
  }
  return { token, channel };
}

export async function postMessage(
  text: string,
  threadTs?: string,
  channelOverride?: string,
): Promise<SlackPostResult> {
  const { token, channel: defaultChannel } = getConfig();
  const channel = channelOverride ?? defaultChannel;
  const body: Record<string, string> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;

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
): Promise<SlackPostResult> {
  const { token, channel } = getConfig();

  const res = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, ts, text }),
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
