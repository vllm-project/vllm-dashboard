/**
 * Keyboard triage: which key does what in the item drawer, when keys are
 * ignored, and how j/k move through the list on screen.
 */

export type DrawerCommand =
  | "next"
  | "prev"
  | "ack"
  | "not_mine"
  | "done"
  | "reassign"
  | "github"
  | "close"
  | "help";

/** For the "?" overlay and button hints, in display order. */
export const DRAWER_SHORTCUTS: readonly { key: string; command: DrawerCommand; label: string }[] = [
  { key: "j", command: "next", label: "Next item" },
  { key: "k", command: "prev", label: "Previous item" },
  { key: "a", command: "ack", label: "Ack / Take it" },
  { key: "d", command: "done", label: "Done" },
  { key: "n", command: "not_mine", label: "Not mine" },
  { key: "r", command: "reassign", label: "Reassign…" },
  { key: "o", command: "github", label: "Open on GitHub" },
  { key: "?", command: "help", label: "Show these shortcuts" },
  { key: "Esc", command: "close", label: "Close" },
];

const BY_KEY: Record<string, DrawerCommand> = {
  j: "next",
  k: "prev",
  a: "ack",
  d: "done",
  n: "not_mine",
  r: "reassign",
  o: "github",
  "?": "help",
  Escape: "close",
};

/** The key hint for a command ("a"), for titles like "Ack (a)". */
export function shortcutKey(command: DrawerCommand): string {
  return DRAWER_SHORTCUTS.find((shortcut) => shortcut.command === command)?.key ?? "";
}

export interface KeyTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
  closest?: (selector: string) => unknown;
}

export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
}

const BUTTON_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio"]);

/** Is focus somewhere the user types (inputs, selects, textareas, contenteditable, listboxes)? */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as KeyTargetLike;
  const tag = (element.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !BUTTON_INPUTS.has((element.type ?? "text").toLowerCase());
  if (element.isContentEditable) return true;
  // Open custom menus/listboxes handle their own keys.
  return typeof element.closest === "function" && !!element.closest("[role=listbox],[role=menu]");
}

/**
 * The drawer command for a key press, or null when the key isn't one, a
 * modifier is held (so browser and OS shortcuts keep working), or the user
 * is typing. Shift is only accepted where the key needs it ("?").
 */
export function drawerCommand(event: KeyEventLike): DrawerCommand | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTypingTarget(event.target)) return null;
  const command = BY_KEY[event.key];
  if (!command) return null;
  if (event.shiftKey && event.key !== "?") return null;
  return command;
}

/** The item `delta` steps from `current` in `order`; null past either end. */
export function stepItem(order: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (order.length === 0) return null;
  const index = current === null ? -1 : order.indexOf(current);
  if (index === -1) return delta === 1 ? order[0] : order[order.length - 1];
  return order[index + delta] ?? null;
}

/**
 * Where to go once `current` leaves the list (a terminal action): the next
 * item in the order it had before, else the previous one, else nothing.
 */
export function advanceAfter(order: readonly string[], current: string): string | null {
  const index = order.indexOf(current);
  if (index === -1) return order[0] ?? null;
  return order[index + 1] ?? order[index - 1] ?? null;
}

/** "3 of 20" position, or null when `current` isn't in the list. */
export function listPosition(order: readonly string[], current: string | null): { index: number; total: number } | null {
  const index = current === null ? -1 : order.indexOf(current);
  return index === -1 ? null : { index, total: order.length };
}
