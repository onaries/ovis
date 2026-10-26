import { describe, expect, it } from "bun:test";

import type { InteractivePrompt } from "../../shared/protocol.ts";
import { answerFromText, answerHint, answerRefusal, focusFollowsAnswer, needsConfirmation, pressOrigin, type PressOrigin } from "./promptAnswer.ts";

const prompt = (options: string[], custom: number | null, multi = false): InteractivePrompt => ({
  id: "p", agent: "claude", kind: "question", title: "Question", question: "?", body: null,
  options: options.map((label) => ({ label, description: null })), multi_select: multi, custom_option_index: custom,
});

describe("answering a prompt from the chat", () => {
  it("keeps GJC's native numbers when Other precedes a numbered clarification choice", () => {
    const question = { ...prompt(["1. Read only", "2. Other (type your own)", "3. Ask about these choices", "Esc"], 1), agent: "gjc", kind: "menu" as const };
    const answer = answerFromText(question, "3");
    expect(answer).toEqual({ option_index: 2 });
    expect(needsConfirmation(question, answer!)).toBe(true);
    expect(answerFromText(question, "2")).toEqual({ custom_text: "2" });
    expect(answerFromText(question, "4")).toEqual({ option_index: 3 });
  });
  it("reads the agent's option numbers, labels and bound letters, else the typed reply", () => {
    const question = prompt(["LM-O (Recommended)", "YCB-V"], 2);
    expect(answerFromText(question, "2")).toEqual({ option_index: 1 });
    expect(answerFromText(question, " lm-o ")).toEqual({ option_index: 0 });
    expect(answerFromText(question, "LM-O (Recommended)")).toEqual({ option_index: 0 });
    // the "type something" row is answered with text, not picked by its number
    expect(answerFromText(question, "3")).toEqual({ custom_text: "3" });
    expect(answerFromText(question, "use T-LESS instead")).toEqual({ custom_text: "use T-LESS instead" });
    expect(answerHint(question)).toBe("Type 1–2 or your own reply…");
  });

  it("answers a free-form question (Codex's queue) with the text itself, numbers included", () => {
    const freeForm = prompt([], 0);
    expect(answerFromText(freeForm, "1")).toEqual({ custom_text: "1" });
    expect(answerFromText(freeForm, "keep the logs")).toEqual({ custom_text: "keep the logs" });
    expect(answerHint(freeForm)).toBe("Type your reply…");
    expect(answerHint(prompt(["A", "B", "C"], null, true))).toBe("Type the numbers you choose, e.g. 1 3");
    // one option beside the custom answer: its number, not a range
    expect(answerHint(prompt(["LM-O"], 1))).toBe("Type 1 or your own reply…");
  });

  it("takes only an option for an approval", () => {
    const approval = { ...prompt(["Yes, proceed (y)", "Yes, and don't ask again (p)", "No, and tell Codex what to do differently (esc)"], null), kind: "approval" as const };
    expect(answerFromText(approval, "y")).toEqual({ option_index: 0 });
    expect(answerFromText(approval, "P")).toEqual({ option_index: 1 });
    expect(answerFromText(approval, "no, and tell codex what to do differently")).toEqual({ option_index: 2 });
    expect(answerFromText(approval, "4")).toBeNull();
    expect(answerFromText(approval, "maybe later")).toBeNull();
    expect(answerHint(approval)).toBe("Type 1–3 to choose…");
    expect(answerRefusal(approval)).toBe("Choose one of the options above: type 1–3.");
    // typed, an approval's pick waits for Confirm; a question's does not
    expect(needsConfirmation(approval, { option_index: 0 })).toBe(true);
    expect(needsConfirmation(prompt(["LM-O"], 1), { option_index: 0 })).toBe(false);
    expect(needsConfirmation({ ...prompt(["Yes", "No", "Tell Claude what to change"], 2), kind: "plan" }, { custom_text: "shorter" })).toBe(false);
    // Claude's review submits every answer, a Codex menu continues or stops: a typed pick waits too
    expect(needsConfirmation({ ...prompt(["Submit answers", "Cancel"], null), kind: "menu" }, { option_index: 0 })).toBe(true);
  });

  it("skips a plan's custom row inside the options and reads several numbers for a multiple choice", () => {
    const plan = prompt(["Yes, auto-accept edits", "Yes, manually approve edits", "No", "Tell Claude what to change"], 3);
    expect(answerFromText(plan, "4")).toEqual({ custom_text: "4" });
    expect(answerFromText(plan, "keep the intro")).toEqual({ custom_text: "keep the intro" });
    const multi = prompt(["LM-O", "YCB-V", "T-LESS"], null, true);
    expect(answerFromText(multi, "1, 3")).toEqual({ option_indices: [0, 2] });
    expect(answerFromText(multi, "1 1 2")).toEqual({ option_indices: [0, 1] });
    expect(answerFromText(multi, "1 and 3")).toBeNull();
    // a multiple choice with a typed-answer row (Claude's) takes anything else as that answer
    const open = prompt(["Manzana", "Pera"], 2, true);
    expect(answerFromText(open, "1 2")).toEqual({ option_indices: [0, 1] });
    expect(answerFromText(open, "Kiwi")).toEqual({ custom_text: "Kiwi" });
  });
});

describe("pressOrigin", () => {
  it("takes the pointer a click names", () => {
    for (const pointerType of ["mouse", "touch", "pen"] as const) {
      expect(pressOrigin({ pointerType, detail: 1, keyed: false })).toBe(pointerType);
      // a keydown left over on the button does not make a pointer's click a key
      expect(pressOrigin({ pointerType, detail: 1, keyed: true })).toBe(pointerType);
    }
  });

  it("takes the pointer that went down on the button, and a finger or a pen over a mouse", () => {
    // a browser whose click names no pointer
    for (const downType of ["mouse", "touch", "pen"] as const) expect(pressOrigin({ downType, detail: 1, keyed: false })).toBe(downType);
    // iOS Safari has called a tap's click a mouse's
    expect(pressOrigin({ downType: "touch", pointerType: "mouse", detail: 1, keyed: false })).toBe("touch");
    expect(pressOrigin({ downType: "pen", pointerType: "mouse", detail: 1, keyed: false })).toBe("pen");
    expect(pressOrigin({ downType: "mouse", pointerType: "touch", detail: 1, keyed: false })).toBe("touch");
    expect(pressOrigin({ downType: "mouse", pointerType: "mouse", detail: 1, keyed: false })).toBe("mouse");
  });

  it("calls a click a key only with no click count and its keydown on the button", () => {
    // Chromium and Firefox: a PointerEvent with an empty pointer type; Safari: a MouseEvent with none
    expect(pressOrigin({ pointerType: "", detail: 0, keyed: true })).toBe("keyboard");
    expect(pressOrigin({ detail: 0, keyed: true })).toBe("keyboard");
    // a script's click() or an assistive technology's activation: no key went down
    expect(pressOrigin({ pointerType: "", detail: 0, keyed: false })).toBe("unknown");
    expect(pressOrigin({ detail: 0, keyed: false })).toBe("unknown");
  });

  it("does not guess at a counted click that names no pointer", () => {
    expect(pressOrigin({ detail: 1, keyed: false })).toBe("unknown");
    expect(pressOrigin({ pointerType: "", detail: 1, keyed: true })).toBe("unknown");
    expect(pressOrigin({ keyed: true })).toBe("unknown");
  });

  it("reads Enter in the card's own field, which has no click, as a key", () => {
    expect(pressOrigin(undefined)).toBe("keyboard");
  });
});

describe("focusFollowsAnswer", () => {
  const still = { fromCard: true, origin: "mouse" as PressOrigin, coarse: false, cardMounted: true, inCard: false, onPage: true };

  it("hands the focus on when the pressed button lost it to the page, or still has it", () => {
    expect(focusFollowsAnswer(still)).toBe(true);
    expect(focusFollowsAnswer({ ...still, inCard: true, onPage: false })).toBe(true);
  });

  it("leaves the focus where the user put it while the answer was on its way", () => {
    expect(focusFollowsAnswer({ ...still, onPage: false })).toBe(false);
    expect(focusFollowsAnswer({ ...still, origin: "keyboard", coarse: true, onPage: false })).toBe(false);
  });

  it("does nothing for a card that is gone, or an answer that did not start in the card", () => {
    expect(focusFollowsAnswer({ ...still, cardMounted: false })).toBe(false);
    expect(focusFollowsAnswer({ ...still, fromCard: false })).toBe(false);
    expect(focusFollowsAnswer({ ...still, origin: "keyboard", coarse: true, cardMounted: false })).toBe(false);
    expect(focusFollowsAnswer({ ...still, origin: "keyboard", coarse: true, fromCard: false })).toBe(false);
  });

  // fine: a desktop, or a touch-screen laptop; coarse: a phone, or a tablet with a keyboard or a mouse
  const follows: Record<PressOrigin, { fine: boolean; coarse: boolean }> = {
    keyboard: { fine: true, coarse: true },
    mouse: { fine: true, coarse: true },
    touch: { fine: false, coarse: false },
    pen: { fine: false, coarse: false },
    unknown: { fine: true, coarse: false },
  };
  for (const [origin, expected] of Object.entries(follows) as [PressOrigin, { fine: boolean; coarse: boolean }][]) {
    it(`${expected.fine ? "hands the focus on" : "stays out of the message box"} after a ${origin} press on a fine pointer`, () => {
      expect(focusFollowsAnswer({ ...still, origin, coarse: false })).toBe(expected.fine);
    });
    it(`${expected.coarse ? "hands the focus on" : "stays out of the message box"} after a ${origin} press on a coarse pointer`, () => {
      expect(focusFollowsAnswer({ ...still, origin, coarse: true })).toBe(expected.coarse);
    });
  }
});
