import { createHmac, timingSafeEqual } from "node:crypto";
import { isItemKey } from "@/lib/triage-actions";
import { isValidLogin } from "@/lib/triage-auth";

/**
 * Slack interactivity for triage DMs: Ack / Not mine / Reassign buttons.
 *
 * Slack POSTs each click to /api/triage/slack/interactions. Every request is
 * authenticated with the app's signing secret (HMAC-SHA256 over
 * "v0:<timestamp>:<raw body>") and must be at most five minutes old, so a
 * captured request cannot be replayed later. The clicker is identified only
 * by the Slack user ID in that signed payload, mapped to a maintainer through
 * `slack_user_id` in their maintainers file.
 */

export const SLACK_MAX_AGE_SECONDS = 5 * 60;

/** action_id values the worker puts on buttons (triage/notify.py). */
export const SLACK_ACTIONS = {
  ack: "triage:ack",
  notMine: "triage:not_mine",
  reassign: "triage:reassign",
  /** Overflow menu on digest lines; option value is "<action>|<itemKey>". */
  menu: "triage:menu",
  /** Link button; Slack still posts a click, which is ignored. */
  open: "triage:open",
} as const;

export function verifySlackSignature(
  secret: string | undefined,
  timestamp: string | null,
  signature: string | null,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > SLACK_MAX_AGE_SECONDS) return false;
  const expected = Buffer.from(
    `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`,
  );
  const received = Buffer.from(signature);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export type SlackTriageClick =
  | { kind: "ignore" }
  | {
      kind: "action";
      slackUserId: string;
      action: "ack" | "not_mine" | "reassign";
      itemKey: string;
      target: string | null;
      responseUrl: string;
      blocks: Record<string, unknown>[];
    };

/** Only Slack's own webhook host may receive our follow-up. */
export function isSlackResponseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "hooks.slack.com";
  } catch {
    return false;
  }
}

/** Parse a Slack interaction POST body (form-encoded `payload=<json>`). */
export function parseSlackInteraction(rawBody: string): SlackTriageClick | { kind: "error"; error: string } {
  let payload: Record<string, unknown>;
  try {
    const json = new URLSearchParams(rawBody).get("payload");
    payload = JSON.parse(json ?? "") as Record<string, unknown>;
  } catch {
    return { kind: "error", error: "payload is not JSON" };
  }
  if (payload.type !== "block_actions") return { kind: "ignore" };
  const user = payload.user as { id?: unknown } | undefined;
  const actions = payload.actions as Record<string, unknown>[] | undefined;
  const click = actions?.[0];
  if (!click || typeof user?.id !== "string" || !/^[UW][A-Z0-9]{6,}$/.test(user.id)) {
    return { kind: "error", error: "missing user or action" };
  }
  if (!isSlackResponseUrl(payload.response_url)) return { kind: "error", error: "missing response_url" };
  const message = payload.message as { blocks?: unknown } | undefined;
  const blocks = Array.isArray(message?.blocks) ? (message.blocks as Record<string, unknown>[]) : [];
  const base = { kind: "action" as const, slackUserId: user.id, responseUrl: payload.response_url, blocks };

  const actionId = click.action_id;
  if (actionId === SLACK_ACTIONS.open) return { kind: "ignore" };
  if (actionId === SLACK_ACTIONS.ack || actionId === SLACK_ACTIONS.notMine) {
    if (!isItemKey(click.value)) return { kind: "error", error: "bad item" };
    return { ...base, action: actionId === SLACK_ACTIONS.ack ? "ack" : "not_mine", itemKey: click.value, target: null };
  }
  if (actionId === SLACK_ACTIONS.reassign) {
    const selected = (click.selected_option as { value?: unknown } | undefined)?.value;
    const itemKey = typeof click.block_id === "string" ? click.block_id.replace(/^triage:actions:/, "") : "";
    if (!isItemKey(itemKey) || typeof selected !== "string" || !isValidLogin(selected)) {
      return { kind: "error", error: "bad reassign" };
    }
    return { ...base, action: "reassign", itemKey, target: selected };
  }
  if (actionId === SLACK_ACTIONS.menu) {
    const value = (click.selected_option as { value?: unknown } | undefined)?.value;
    const [action, itemKey] = typeof value === "string" ? value.split("|", 2) : [];
    if ((action !== "ack" && action !== "not_mine") || !isItemKey(itemKey)) {
      return { kind: "ignore" }; // e.g. the "Open" option, which is a link
    }
    return { ...base, action, itemKey, target: null };
  }
  return { kind: "ignore" };
}

const DONE_TEXT: Record<"ack" | "not_mine" | "reassign", (login: string, target: string | null) => string> = {
  ack: (login) => `:white_check_mark: Acked by *${login}*`,
  not_mine: (login) => `:leftwards_arrow_with_hook: *${login}* said not mine; it will be routed to someone else`,
  reassign: (login, target) => `:arrow_right: Reassigned to *${target}* by ${login}`,
};

/**
 * The message after a click: the item's buttons (or its overflow menu) are
 * removed and a one-line result appears in their place, so the same button
 * can't be pressed twice and everyone who sees the DM sees the outcome.
 */
export function blocksAfterAction(
  blocks: Record<string, unknown>[],
  itemKey: string,
  action: "ack" | "not_mine" | "reassign",
  login: string,
  target: string | null,
  at: Date,
): Record<string, unknown>[] {
  const time = `<!date^${Math.floor(at.getTime() / 1000)}^{time}|${at.toISOString()}>`;
  const result = {
    type: "context",
    block_id: `triage:result:${itemKey}`,
    elements: [{ type: "mrkdwn", text: `${DONE_TEXT[action](login, target)} · ${time}` }],
  };
  const out: Record<string, unknown>[] = [];
  let placed = false;
  for (const block of blocks) {
    if (block.block_id === `triage:actions:${itemKey}` || block.block_id === `triage:result:${itemKey}`) {
      if (!placed) out.push(result);
      placed = true;
      continue;
    }
    if (block.block_id === `triage:item:${itemKey}`) {
      const rest = { ...block };
      delete rest.accessory;
      out.push(rest);
      continue;
    }
    out.push(block);
  }
  if (!placed) {
    const index = out.findIndex((block) => block.block_id === `triage:item:${itemKey}`);
    out.splice(index >= 0 ? index + 1 : out.length, 0, result);
  }
  return out;
}

/** A private note only the clicker sees (the DM itself is left as is). */
export function ephemeral(text: string): Record<string, unknown> {
  return { response_type: "ephemeral", replace_original: false, text };
}
