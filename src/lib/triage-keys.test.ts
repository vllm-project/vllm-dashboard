import assert from "node:assert/strict";
import test from "node:test";
import { DRAWER_SHORTCUTS, advanceAfter, drawerCommand, isTypingTarget, listPosition, shortcutKey, stepItem } from "./triage-keys";

const body = { tagName: "BODY" };

test("single keys map to drawer commands", () => {
  const expected: Record<string, string> = { j: "next", k: "prev", a: "ack", d: "done", n: "not_mine", r: "reassign", o: "github", Escape: "close" };
  for (const [key, command] of Object.entries(expected)) {
    assert.equal(drawerCommand({ key, target: body }), command, key);
  }
  assert.equal(drawerCommand({ key: "?", shiftKey: true, target: body }), "help");
  assert.equal(drawerCommand({ key: "x", target: body }), null);
  assert.equal(drawerCommand({ key: "ArrowDown", target: body }), null);
});

test("modifiers never trigger shortcuts (browser and OS keys keep working)", () => {
  for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
    assert.equal(drawerCommand({ key: "a", [modifier]: true, target: body }), null, modifier);
    assert.equal(drawerCommand({ key: "Escape", [modifier]: true, target: body }), null, modifier);
  }
  assert.equal(drawerCommand({ key: "A", shiftKey: true, target: body }), null);
  assert.equal(drawerCommand({ key: "j", shiftKey: true, target: body }), null);
});

test("typing in inputs, selects, textareas and contenteditable is left alone", () => {
  for (const target of [
    { tagName: "INPUT" },
    { tagName: "input", type: "search" },
    { tagName: "INPUT", type: "date" },
    { tagName: "SELECT" },
    { tagName: "TEXTAREA" },
    { tagName: "DIV", isContentEditable: true },
    { tagName: "BUTTON", closest: (selector: string) => (selector.includes("menu") ? {} : null) },
  ]) {
    assert.equal(isTypingTarget(target), true, JSON.stringify(target));
    assert.equal(drawerCommand({ key: "a", target }), null);
    assert.equal(drawerCommand({ key: "Escape", target }), null);
  }
  for (const target of [body, { tagName: "BUTTON" }, { tagName: "INPUT", type: "checkbox" }, { tagName: "A", closest: () => null }, null, undefined]) {
    assert.equal(isTypingTarget(target), false, JSON.stringify(target));
  }
});

test("stepItem walks the list in order and stops at the ends", () => {
  const order = ["a", "b", "c"];
  assert.equal(stepItem(order, "a", 1), "b");
  assert.equal(stepItem(order, "c", 1), null);
  assert.equal(stepItem(order, "a", -1), null);
  assert.equal(stepItem(order, "b", -1), "a");
  assert.equal(stepItem(order, null, 1), "a");
  assert.equal(stepItem(order, "gone", -1), "c");
  assert.equal(stepItem([], "a", 1), null);
});

test("advanceAfter: next, else previous, else nothing", () => {
  assert.equal(advanceAfter(["a", "b", "c"], "b"), "c");
  assert.equal(advanceAfter(["a", "b", "c"], "c"), "b");
  assert.equal(advanceAfter(["a"], "a"), null);
  assert.equal(advanceAfter(["a", "b"], "zzz"), "a");
  assert.equal(advanceAfter([], "zzz"), null);
});

test("listPosition and hints", () => {
  assert.deepEqual(listPosition(["a", "b"], "b"), { index: 1, total: 2 });
  assert.equal(listPosition(["a"], "x"), null);
  assert.equal(shortcutKey("ack"), "a");
  assert.equal(shortcutKey("github"), "o");
  const keys = DRAWER_SHORTCUTS.map((shortcut) => shortcut.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("rowOrder follows the drawn order: issue, then its fix PRs", async () => {
  const { rowOrder } = await import("./triage-groups");
  assert.deepEqual(
    rowOrder([
      { item: { itemKey: "r#1" }, members: [{ itemKey: "r#5" }, { itemKey: "r#6" }] },
      { item: { itemKey: "r#2" }, members: [] },
    ]),
    ["r#1", "r#5", "r#6", "r#2"],
  );
});

test("advanceAfter skips fix PRs closed by the same click", () => {
  const order = ["r#1", "r#5", "r#2"];
  const alsoApplied = ["r#5"];
  assert.equal(advanceAfter(order.filter((key) => !alsoApplied.includes(key)), "r#1"), "r#2");
});
