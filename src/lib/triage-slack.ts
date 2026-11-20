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
  done: "triage:done",
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

export type SlackClickAction = "ack" | "done" | "not_mine" | "reassign";

export type SlackTriageClick =
  | { kind: "ignore" }
  | {
      kind: "action";
      slackUserId: string;
      action: SlackClickAction;
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
  const buttons: Record<string, SlackClickAction> = {
    [SLACK_ACTIONS.ack]: "ack",
    [SLACK_ACTIONS.done]: "done",
    [SLACK_ACTIONS.notMine]: "not_mine",
  };
  if (typeof actionId === "string" && actionId in buttons) {
    if (!isItemKey(click.value)) return { kind: "error", error: "bad item" };
    return { ...base, action: buttons[actionId], itemKey: click.value, target: null };
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
    if ((action !== "ack" && action !== "done" && action !== "not_mine") || !isItemKey(itemKey)) {
      return { kind: "ignore" }; // e.g. the "Open" option, which is a link
    }
    return { ...base, action, itemKey, target: null };
  }
  return { kind: "ignore" };
}

export type SlackLanguage = "en" | "vi";

const RESULT_TEXT: Record<SlackLanguage, Record<SlackClickAction, (login: string, target: string | null) => string>> = {
  en: {
    ack: (login) => `:white_check_mark: Acked by *${login}*`,
    done: (login) => `:checkered_flag: Marked done by *${login}*`,
    not_mine: (login) => `:leftwards_arrow_with_hook: *${login}* said not mine; it will be routed to someone else`,
    reassign: (login, target) => `:arrow_right: Reassigned to *${target}* by ${login}`,
  },
  // One-off for maintainers whose file says `language: vi`.
  vi: {
    ack: (login) => `:white_check_mark: *${login}* đã nhận việc`,
    done: (login) => `:checkered_flag: *${login}* đã hoàn thành`,
    not_mine: (login) => `:leftwards_arrow_with_hook: *${login}* báo không phải việc của mình; hệ thống sẽ chuyển cho người khác`,
    reassign: (login, target) => `:arrow_right: *${login}* đã chuyển cho *${target}*`,
  },
};

const DONE_LABEL: Record<SlackLanguage, string> = { en: "Done", vi: "Hoàn thành" };

/** "(and #67812)": the group's fix PRs the click applied to too. */
const ALSO: Record<SlackLanguage, (numbers: string) => string> = {
  en: (numbers) => `(and its fix ${numbers})`,
  vi: (numbers) => `(cùng bản sửa ${numbers})`,
};

type Block = Record<string, unknown>;
type Element = Record<string, unknown>;

const doneButton = (itemKey: string, lang: SlackLanguage): Element => ({
  type: "button",
  action_id: SLACK_ACTIONS.done,
  style: "primary",
  text: { type: "plain_text", text: DONE_LABEL[lang] },
  value: itemKey,
});

/** Digest ⋮ menu after an ack: Done replaces Ack; Not mine and Open stay. */
function menuAfterAck(accessory: Record<string, unknown>, itemKey: string, lang: SlackLanguage): Record<string, unknown> {
  const options = Array.isArray(accessory.options) ? (accessory.options as Record<string, unknown>[]) : [];
  return {
    ...accessory,
    options: [
      { text: { type: "plain_text", text: DONE_LABEL[lang] }, value: `done|${itemKey}` },
      ...options.filter((o) => typeof o.value === "string" && !o.value.startsWith("ack|") && !o.value.startsWith("done|")),
    ],
  };
}

/** Digest ⋮ menu after the item left this person: only "Open" stays. */
function menuOpenOnly(accessory: Record<string, unknown>): Record<string, unknown> | null {
  const options = Array.isArray(accessory.options) ? (accessory.options as Record<string, unknown>[]) : [];
  const open = options.filter((o) => typeof o.url === "string");
  return open.length ? { ...accessory, options: open } : null;
}

/** Only the compact digest's metadata line contains these status tokens. */
function digestStatusAfterAction(block: Block, action: SlackClickAction): Block {
  const text = block.text as { type?: string; text?: string } | undefined;
  if (text?.type !== "mrkdwn" || typeof text.text !== "string") return block;
  const lines = text.text.split("\n");
  if (!/^<https:\/\/github\.com\/[^|]+\|#\d+> · /.test(lines[1] ?? "")) return block;
  const labels = {
    ack: ["✅ acked", "✅ đã nhận"],
    done: ["🏁 done", "🏁 đã hoàn thành"],
    not_mine: ["↩️ awaiting reroute", "↩️ chờ chuyển người phụ trách"],
    reassign: ["➡️ reassigned", "➡️ đã chuyển người phụ trách"],
  }[action];
  lines[1] = lines[1].split(" · ").map((part) =>
    ["needs your ack", "acked", "🔔 needs your ack", "✅ acked", ":bell: needs your ack", ":white_check_mark: acked"].includes(part) ? labels[0]
      : ["chờ bạn nhận", "đã nhận", "🔔 chờ bạn nhận", "✅ đã nhận", ":bell: chờ bạn nhận", ":white_check_mark: đã nhận"].includes(part) ? labels[1] : part,
  ).join(" · ");
  return { ...block, text: { ...text, text: lines.join("\n") } };
}

/**
 * The message after a click. Ack is not the end: Ack becomes "Done" and Not
 * mine / Reassign / Open stay, under a one-line result. Done, Not mine and
 * Reassign end this person's ownership, so only "Open in dashboard" remains.
 * The result line is replaced on each later click, so it always shows the
 * latest state. On a group (an issue with its fix PRs), `also` lists the fix
 * PRs the click applied to as well.
 */
export function blocksAfterAction(
  blocks: Block[],
  itemKey: string,
  action: SlackClickAction,
  login: string,
  target: string | null,
  at: Date,
  lang: SlackLanguage = "en",
  also: readonly string[] = [],
): Block[] {
  const time = `<!date^${Math.floor(at.getTime() / 1000)}^{time}|${at.toISOString()}>`;
  const numbers = also.map((key) => `#${key.replace(/^.*#/, "")}`).join(", ");
  const alsoText = numbers ? ` ${ALSO[lang](numbers)}` : "";
  const result: Block = {
    type: "context",
    block_id: `triage:result:${itemKey}`,
    elements: [{ type: "mrkdwn", text: `${RESULT_TEXT[lang][action](login, target)}${alsoText} · ${time}` }],
  };
  const out: Block[] = [];
  let placed = false;
  for (const block of blocks) {
    if (block.block_id === `triage:result:${itemKey}`) continue; // replaced below
    if (block.block_id === `triage:actions:${itemKey}`) {
      out.push(result);
      placed = true;
      const elements = Array.isArray(block.elements) ? (block.elements as Element[]) : [];
      const kept =
        action === "ack"
          ? [doneButton(itemKey, lang), ...elements.filter((e) => e.action_id !== SLACK_ACTIONS.ack && e.action_id !== SLACK_ACTIONS.done)]
          : elements.filter((e) => e.action_id === SLACK_ACTIONS.open);
      if (kept.length) out.push({ ...block, elements: kept });
      continue;
    }
    if (block.block_id === `triage:item:${itemKey}` && block.accessory && typeof block.accessory === "object") {
      const accessory = block.accessory as Record<string, unknown>;
      const next = action === "ack" ? menuAfterAck(accessory, itemKey, lang) : menuOpenOnly(accessory);
      const rest = { ...digestStatusAfterAction(block, action) };
      if (next) rest.accessory = next;
      else delete rest.accessory;
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
