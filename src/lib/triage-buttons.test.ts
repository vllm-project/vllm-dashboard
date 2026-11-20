import assert from "node:assert/strict";
import test from "node:test";
import { HIDE_TOOLTIP, actionButtons, actionToast } from "./triage-buttons";
import { DRAWER_SHORTCUTS } from "./triage-keys";
import { TRIAGE_ACTIONS } from "./triage-vocab";

const labels = (mode: Parameters<typeof actionButtons>[0]) => actionButtons(mode).map((button) => button.label);

test("before ack: Ack first and filled, then Not mine, Reassign, Done, Hide; no More or Open", () => {
  assert.deepEqual(labels("open"), ["Ack", "Not mine", "Reassign", "Done", "Hide for everyone"]);
  const [ack, ...rest] = actionButtons("open");
  assert.equal(ack.look, "primary");
  assert.ok(rest.every((button) => button.look !== "primary"));
});

test("after ack: Done becomes the primary, Ack goes away", () => {
  assert.deepEqual(labels("acked"), ["Done", "Not mine", "Reassign", "Hide for everyone"]);
  assert.equal(actionButtons("acked")[0].look, "primary");
});

test("other modes keep their buttons", () => {
  assert.deepEqual(labels("unassigned"), ["Take it", "Reassign"]);
  assert.deepEqual(labels("others"), ["Reassign"]);
  assert.deepEqual(labels("closed"), ["Reopen"]);
});

test("Hide for everyone sends drop, looks dangerous, and has no shortcut", () => {
  for (const mode of ["open", "acked"] as const) {
    const hide = actionButtons(mode).find((button) => button.id === "hide")!;
    assert.equal(hide.action, "drop");
    assert.equal(hide.look, "danger");
    assert.equal(hide.shortcut, null);
    assert.equal(hide.title, HIDE_TOOLTIP);
  }
  // The UI never offers slop any more, but the API still accepts it.
  for (const mode of ["open", "acked", "closed", "unassigned", "others"] as const) {
    assert.ok(actionButtons(mode).every((button) => button.action !== "slop"));
  }
  assert.ok(TRIAGE_ACTIONS.includes("slop"));
});

test("shortcuts on the buttons are the drawer's a / d / n / r", () => {
  const keys = new Map(DRAWER_SHORTCUTS.map((shortcut) => [shortcut.key, shortcut.command]));
  for (const mode of ["open", "acked", "unassigned", "others"] as const) {
    for (const button of actionButtons(mode)) {
      if (!button.shortcut) continue;
      const command = keys.get(button.shortcut);
      assert.ok(command, `${button.label}: ${button.shortcut} is a drawer shortcut`);
      assert.equal(command, button.id === "take" ? "ack" : button.id);
    }
  }
});

test("drop and slop toasts read the same", () => {
  assert.equal(actionToast("drop"), "Hidden from every maintainer");
  assert.equal(actionToast("slop"), actionToast("drop"));
  assert.equal(actionToast("reassign", "alice"), "Reassigned to alice");
});
