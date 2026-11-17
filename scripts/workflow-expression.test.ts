import { describe, expect, test } from "bun:test";
import { evaluate, evaluateValue } from "./workflow-expression.ts";

describe("workflow expressions, as GitHub evaluates them", () => {
  test("loose equality: null, false, 0 and '' are equal across types; mixed types compare as numbers; strings ignore case", () => {
    for (const [expression, value] of [
      ["null == ''", true], ["null == false", true], ["null == 0", true], ["null == '0'", true], ["null == null", true],
      ["null == 'x'", false], ["null == true", false], ["null == 1", false], ["null != ''", false],
      ["false == 0", true], ["'1' == 1", true], ["true == '1'", true], ["'abc' == 'ABC'", true], ["'abc' == 0", false],
      ["inputs.missing == false", true], ["inputs.missing == ''", true], ["inputs.missing != false", false],
    ] as const) {
      expect([expression, evaluate(expression, { inputs: {} })]).toEqual([expression, value]);
    }
  });

  test("an object or array equals only itself, never null", () => {
    expect(evaluate("github.event == null", { github: { event: {} } })).toBe(false);
    expect(evaluate("fromJSON('[]') == null", {})).toBe(false);
  });

  test("&& and || return an operand; ! binds tighter than ==, == than &&, && than ||", () => {
    expect(evaluate("inputs.x && 'a' || 'b'", { inputs: {} })).toBe("b");
    expect(evaluate("inputs.x && 'a' || 'b'", { inputs: { x: true } })).toBe("a");
    expect(evaluate("'' || null", {})).toBeNull();
    expect(evaluate("!inputs.x == true", { inputs: {} })).toBe(true);
    expect(evaluate("true || false && false", {})).toBe(true);
  });

  test("contexts ignore case, functions follow GitHub, a whole ${{ }} keeps its type", () => {
    expect(evaluate("GitHub.Ref", { github: { ref: "refs/heads/main" } })).toBe("refs/heads/main");
    expect(evaluate("contains(fromJSON('[\"Self-Hosted\"]'), 'self-hosted')", {})).toBe(true);
    expect(evaluate("contains('ubuntu-24.04', 'UBUNTU')", {})).toBe(true);
    expect(evaluateValue("${{ fromJSON('[1,2]') }}", {})).toEqual([1, 2]);
    expect(evaluateValue("a-${{ 'b' }}-${{ 1 }}", {})).toBe("a-b-1");
    expect(evaluateValue("inputs.missing == false", { inputs: {} }, true)).toBe(true);
  });
});
