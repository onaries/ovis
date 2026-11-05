import { expect, it } from "bun:test";
import { translate } from "./i18n.ts";
import { paneMoveNotice } from "./useLayoutNotice.ts";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

it("says where a moved pane stayed when herdr refused the swap that puts it first, and why a move was refused", () => {
  expect(paneMoveNotice({ ok: true, changed: true, reason: null }, "left", en)).toBeNull();
  expect(paneMoveNotice({ ok: true, changed: true, reason: "cross_tab" }, "left", en)).toBe("The pane moved to the right instead.");
  expect(paneMoveNotice({ ok: true, changed: true, reason: "internal_error" }, "up", en)).toBe("The pane moved below instead.");
  expect(paneMoveNotice({ ok: true, changed: false, reason: "cross_tab" }, "left", en)).toBe("Move failed: The panes are in different tabs.");
  expect(paneMoveNotice({ ok: true, changed: false, reason: "same_pane" }, "down", en)).toBe("Move failed: Choose two different panes.");
  expect(paneMoveNotice({ ok: true, changed: false, reason: "no_room" }, "down", en)).toBe("Move failed: Something went wrong. Try again.");
  expect(translate("ko", "The pane moved to the right instead.")).not.toBe("The pane moved to the right instead.");
});
