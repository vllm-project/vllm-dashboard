/**
 * Which action buttons a row or the drawer shows, in order, for each
 * assignment state. Every button is inline (no "More" menu). "Hide for
 * everyone" sends `drop`; the API still accepts `slop` (older rows, Slack),
 * but the UI no longer offers it.
 */
import type { TriageAction } from "./triage-vocab";

/**
 * "open"/"acked": the viewer's own assignment; "closed": the viewer's closed
 * assignment; "unassigned": nobody holds it; "others": someone else holds it.
 */
export type ActionMode = "open" | "acked" | "closed" | "unassigned" | "others";

export interface ActionButtonSpec {
  id: "ack" | "take" | "done" | "not_mine" | "reassign" | "hide" | "reopen";
  label: string;
  /** What a click sends; null for Reassign, which opens the maintainer picker first. */
  action: TriageAction | null;
  look: "primary" | "secondary" | "danger";
  title: string;
  /** The drawer's single-key shortcut. Hide never gets one, so it can't happen by accident. */
  shortcut: "a" | "d" | "n" | "r" | null;
}

export const HIDE_TOOLTIP = "Hides this from every maintainer; you can undo for a few seconds";

const ACK: ActionButtonSpec = { id: "ack", label: "Ack", action: "ack", look: "primary", title: "Tell everyone you're on it", shortcut: "a" };
const TAKE: ActionButtonSpec = { id: "take", label: "Take it", action: "ack", look: "primary", title: "Become its owner", shortcut: "a" };
const NOT_MINE: ActionButtonSpec = { id: "not_mine", label: "Not mine", action: "not_mine", look: "secondary", title: "Send it to someone else", shortcut: "n" };
const REASSIGN: ActionButtonSpec = { id: "reassign", label: "Reassign", action: null, look: "secondary", title: "Hand it to someone you choose", shortcut: "r" };
const HIDE: ActionButtonSpec = { id: "hide", label: "Hide for everyone", action: "drop", look: "danger", title: HIDE_TOOLTIP, shortcut: null };
const REOPEN: ActionButtonSpec = { id: "reopen", label: "Reopen", action: "reopen", look: "secondary", title: "Put it back on your list", shortcut: null };

function done(look: ActionButtonSpec["look"]): ActionButtonSpec {
  return { id: "done", label: "Done", action: "done", look, title: "You've dealt with it", shortcut: "d" };
}

/**
 * Before ack: Ack · Not mine · Reassign · Done · Hide.
 * After ack: Done · Not mine · Reassign · Hide.
 */
export function actionButtons(mode: ActionMode): ActionButtonSpec[] {
  switch (mode) {
    case "open":
      return [ACK, NOT_MINE, REASSIGN, done("secondary"), HIDE];
    case "acked":
      return [done("primary"), NOT_MINE, REASSIGN, HIDE];
    case "unassigned":
      return [TAKE, REASSIGN];
    case "others":
      return [REASSIGN];
    case "closed":
      return [REOPEN];
  }
}

/** The Undo toast's message after an action. */
export function actionToast(action: TriageAction, target?: string): string {
  switch (action) {
    case "not_mine":
      return "Marked not mine";
    case "done":
      return "Marked done";
    case "drop":
    case "slop":
      return "Hidden from every maintainer";
    case "reassign":
      return target ? `Reassigned to ${target}` : "Reassigned";
    default:
      return "Saved";
  }
}
