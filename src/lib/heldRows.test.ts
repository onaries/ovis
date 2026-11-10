import { expect, it } from "bun:test";
import { heldOpenAtFold, heldOpenOnFocus, heldRefocusDue, heldRowError, heldRowsFold, heldRowsHidden, heldToggleShown, SHORT_PHONE_QUERY } from "./heldRows.ts";

it("the rows fold while a prompt card is open or the phone is short, and at no other time", () => {
  expect(heldRowsFold({ promptOpen: false, shortPhone: false, ready: false })).toBe(false);
  expect(heldRowsFold({ promptOpen: true, shortPhone: false, ready: false })).toBe(true);
  expect(heldRowsFold({ promptOpen: false, shortPhone: true, ready: false })).toBe(true);
  expect(heldRowsFold({ promptOpen: true, shortPhone: true, ready: false })).toBe(true);
});

it("a list that asks for the user's action is never folded", () => {
  expect(heldRowsFold({ promptOpen: false, shortPhone: true, ready: true })).toBe(false);
  expect(heldRowsFold({ promptOpen: true, shortPhone: true, ready: true })).toBe(false);
});

it("folded rows hide until the user opens them, and a row's error opens them", () => {
  expect(heldRowsHidden(true, false, false)).toBe(true);
  expect(heldRowsHidden(true, true, false)).toBe(false);
  expect(heldRowsHidden(true, false, true)).toBe(false);
  // not folded: nothing to open, nothing hidden
  expect(heldRowsHidden(false, false, false)).toBe(false);
  expect(heldRowsHidden(false, true, true)).toBe(false);
});

it("a send error opens the rows only while its own message is still in this pane's list", () => {
  const error = { owner: "local:1", id: "a" };
  expect(heldRowError(error, "local:1", ["a", "b"])).toBe(true);
  // the message was discarded: no row shows the error, so it must not hold the rows open
  expect(heldRowError(error, "local:1", ["b"])).toBe(false);
  expect(heldRowError(error, "local:1", [])).toBe(false);
  // another pane's error
  expect(heldRowError(error, "local:2", ["a"])).toBe(false);
  expect(heldRowError(null, "local:1", ["a"])).toBe(false);
  expect(heldRowError(error, null, ["a"])).toBe(false);
});

it("a fold starts open only for the user who is in one of this pane's rows", () => {
  expect(heldOpenAtFold({ fold: true, sameOwner: true, focusInRows: true })).toBe(true);
  expect(heldOpenAtFold({ fold: true, sameOwner: true, focusInRows: false })).toBe(false);
  // the focus is still in the pane the user just left: its rows are not this pane's
  expect(heldOpenAtFold({ fold: true, sameOwner: false, focusInRows: true })).toBe(false);
  expect(heldOpenAtFold({ fold: false, sameOwner: true, focusInRows: true })).toBe(false);
});

it("a row that takes focus under a fold stays in sight when the error that opened the rows goes", () => {
  const owner = "local:1";
  const error = { owner, id: "a" };
  // back in the pane under an open prompt: the fold starts closed, the failed row's error opens it
  let opened = heldOpenAtFold({ fold: true, sameOwner: false, focusInRows: false });
  expect(opened).toBe(false);
  expect(heldRowsHidden(true, opened, heldRowError(error, owner, ["a", "b"]))).toBe(false);
  // the user edits the other row, then another tab discards the failed one: owner, fold and
  // non-empty are as they were, so nothing but the focus says the rows are in use
  opened = heldOpenOnFocus(true, opened);
  expect(heldRowsHidden(true, opened, heldRowError(error, owner, ["b"]))).toBe(false);
  // without that focus the rows fold again
  expect(heldRowsHidden(true, false, heldRowError(error, owner, ["b"]))).toBe(true);
  // no fold, nothing to latch: the next fold decides by itself
  expect(heldOpenOnFocus(false, false)).toBe(false);
  expect(heldOpenOnFocus(false, true)).toBe(true);
});

it("the caption is a button only while it can close the rows it opens", () => {
  expect(heldToggleShown(true, false)).toBe(true);
  expect(heldToggleShown(true, true)).toBe(false);
  expect(heldToggleShown(false, false)).toBe(false);
  expect(heldToggleShown(false, true)).toBe(false);
});

it("focus on the button that went moves to its own pane's list, never to another pane's", () => {
  // the fold ended in the same pane: the agent is ready, or the prompt was answered
  expect(heldRefocusDue("queued-list-local:1", "queued-list-local:1")).toBe(true);
  // the user moved from pane 1's caption to a pane whose list is not folded
  expect(heldRefocusDue("queued-list-local:1", "queued-list-local:2")).toBe(false);
  // the list went with the button
  expect(heldRefocusDue("queued-list-local:1", null)).toBe(false);
  // focus was not on the button
  expect(heldRefocusDue(null, "queued-list-local:1")).toBe(false);
  expect(heldRefocusDue(null, null)).toBe(false);
});

it("the short phone is a phone's width with a keyboard's worth of height gone", () => {
  expect(SHORT_PHONE_QUERY).toBe("(max-width: 480px) and (max-height: 600px)");
});
