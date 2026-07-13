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

// ---------------------------------------------------------------------------
// Canvas support (requires the bot to have the `canvases:write` scope; sharing
// to a channel also needs the bot to be a member of that channel).
// ---------------------------------------------------------------------------

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function slackApi(method: string, body: Record<string, unknown>): Promise<SlackApiResponse> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not set" };
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

export interface CanvasResult {
  ok: boolean;
  canvasId?: string;
  url?: string;
  error?: string;
}

/**
 * Create a standalone canvas from Canvas-flavored Markdown and return its id and
 * a viewable URL (built from the workspace's auth.test url + team id).
 */
export async function createCanvas(title: string, markdown: string): Promise<CanvasResult> {
  const created = await slackApi("canvases.create", {
    title,
    document_content: { type: "markdown", markdown },
  });
  if (!created.ok || typeof created.canvas_id !== "string") {
    return { ok: false, error: created.error ?? "canvases.create failed" };
  }
  const canvasId = created.canvas_id;

  // canvases.create does not return a URL; build it from workspace info.
  const auth = await slackApi("auth.test", {});
  let url: string | undefined;
  if (auth.ok && typeof auth.url === "string" && typeof auth.team_id === "string") {
    url = `${auth.url.replace(/\/$/, "")}/docs/${auth.team_id}/${canvasId}`;
  }
  return { ok: true, canvasId, url };
}

/** Grant a channel read access to a canvas so its members can open it. */
export async function shareCanvasToChannel(
  canvasId: string,
  channelId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await slackApi("canvases.access.set", {
    canvas_id: canvasId,
    access_level: "read",
    channel_ids: [channelId],
  });
  return { ok: res.ok, error: res.error };
}
