import { describe, expect, test } from "bun:test";
import { parseInteractivePrompt } from "../prompt.ts";
import { ANSI_RE } from "./shared.ts";
import { parsePiAsk } from "./pi-ask.ts";
import fixtures from "../fixtures/pi-ask-navigation.json";

const labels = ["单元格内容", "输出类型", "Submit"];

describe("Pi ask question navigation", () => {
  test.each([["first", 0], ["second", 1], ["first-answered", 0], ["second-answered", 1], ["review", 2]] as const)("reads the active tab from its background, not answered count: %s", (name, index) => {
    const prompt = parseInteractivePrompt("pi", fixtures[name]);
    expect(prompt).not.toBeNull();
    expect(prompt?.steps?.map(step => step.label)).toEqual(labels);
    expect(prompt?.steps?.findIndex(step => step.current)).toBe(index);
    expect(prompt?.can_step_back ?? false).toBe(index > 0);
    expect(prompt?.steps?.[0]?.can_navigate).toBe(true);
    expect(prompt?.title).toBe(index === 2 ? "Review your answers" : labels[index]);
  });

  test("plain detection text shows labels but never guesses the current tab", () => {
    const prompt = parseInteractivePrompt("pi", fixtures["first-answered"].replace(ANSI_RE, ""));
    expect(prompt?.steps?.map(step => step.label)).toEqual(labels);
    expect(prompt?.steps?.some(step => step.current || step.can_navigate)).toBe(false);
    expect(prompt?.can_step_back).not.toBe(true);
  });

  test("does not offer the Submit tab before every question is answered", () => {
    const prompt = parseInteractivePrompt("pi", fixtures.first);
    expect(prompt?.steps?.[1]?.can_navigate).toBe(true);
    expect(prompt?.steps?.[2]?.can_navigate).not.toBe(true);
  });

  test.each(["custom-empty", "custom-draft"] as const)("does not send tab navigation while the native input editor owns keys: %s", name => {
    const prompt = parseInteractivePrompt("pi", fixtures[name]);
    expect(prompt?.steps?.map(step => step.label)).toEqual(labels);
    expect(prompt?.steps?.some(step => step.can_navigate)).toBe(false);
    expect(prompt?.can_step_back).not.toBe(true);
  });

  test("focusing the inline editor changes navigation controls, not the question's identity", () => {
    const normal = parseInteractivePrompt("pi", fixtures["second-answered"]);
    const typing = parseInteractivePrompt("pi", fixtures["custom-empty"]);
    expect(normal).not.toBeNull();
    expect(typing).not.toBeNull();
    expect(typing!.id).toBe(normal!.id);
  });

  test("restores the native checkbox state when returning to a question", () => {
    const prompt = parseInteractivePrompt("pi", fixtures["multi-returned"]);
    expect(prompt?.default_option_indices).toEqual([0]);
    expect(prompt?.steps?.findIndex(step => step.current)).toBe(1);
  });

  test("a saved custom row needs the pane's pending call to prove its role", () => {
    const options = [{ label: "允许结构化单元格", description: "单元格可包含列表或对象。" }, { label: "只允许普通单值", description: "仅数字、文字和布尔值。" }];
    const expected = { id: "fixture-call", questions: [
      { header: "单元格内容", question: "结果表是否允许结构化单元格？", multiSelect: false, options },
      { header: "输出类型", question: "结果使用哪种类型？", multiSelect: false, options },
    ] };
    expect(parsePiAsk(fixtures["custom-returned"])).toBeNull();
    const returned = parsePiAsk(fixtures["custom-returned"], expected);
    expect(returned).not.toBeNull();
    expect(returned?.default_custom_text).toBe("existing draft");
    expect(returned?.can_step_back).toBe(true);
    expect(returned?.id).toBe(parsePiAsk(fixtures["custom-returned-focused"], expected)?.id);
    expect(parsePiAsk(fixtures["custom-returned"], { ...expected, questions: expected.questions.map(q => ({ ...q, question: "Wrong question" })) })).toBeNull();
    expect(parsePiAsk(fixtures["custom-returned"], { ...expected, questions: expected.questions.map(q => ({ ...q, options: [...q.options, { label: "Hidden third choice", description: "" }] })) })).toBeNull();
    expect(parsePiAsk(fixtures["custom-returned"], { ...expected, id: "another-call" })?.id).not.toBe(returned?.id);
  });

  test("ambiguous multiple backgrounds do not authorize navigation", () => {
    const ambiguous = fixtures.first.replace("\u001b[38;2;157;165;169m □ 输出类型", "\u001b[48;5;20m\u001b[38;2;157;165;169m □ 输出类型");
    const prompt = parseInteractivePrompt("pi", ambiguous);
    expect(prompt).not.toBeNull();
    expect(prompt?.steps?.some(step => step.can_navigate)).toBe(false);
  });
});
