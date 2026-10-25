import { describe, expect, it } from "bun:test";
import { INSERT_MAX_BYTES, INSERT_MAX_UNITS, insertTextProblem } from "./terminal-insert.ts";

const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

describe("insertTextProblem", () => {
  it("takes one line as written, non-ASCII included", () => {
    expect(insertTextProblem("git status")).toBeNull();
    expect(insertTextProblem("a b 한글 😀")).toBeNull();
  });

  it("refuses a tab: a shell would complete on it, so the prompt would not show the line as written", () => {
    expect(insertTextProblem("a\tb")).toMatchObject({ code: "invalid_insert_text" });
  });

  it("refuses what is not a string, and nothing", () => {
    expect(insertTextProblem(undefined)).toMatchObject({ code: "invalid_insert_text" });
    expect(insertTextProblem(42)).toMatchObject({ code: "invalid_insert_text" });
    expect(insertTextProblem("")).toMatchObject({ code: "invalid_insert_text" });
  });

  it("refuses every line break, bare or inside a bracketed paste the client wrapped", () => {
    for (const text of ["one\rtwo", "one\ntwo", "ls\r", "\n", "one\r\n", paste("one\rtwo"), paste("one\ntwo")]) {
      expect(insertTextProblem(text)).toMatchObject({ code: "unsafe_multiline" });
    }
  });

  it("refuses paste markers and every other control byte, and half a character", () => {
    expect(insertTextProblem(paste("one"))).toMatchObject({ code: "invalid_insert_text" });
    expect(insertTextProblem(paste(""))).toMatchObject({ code: "invalid_insert_text" });
    expect(insertTextProblem("x\x1b[201~y")).toMatchObject({ code: "invalid_insert_text" });
    expect(insertTextProblem("a\x03")).toMatchObject({ code: "invalid_insert_text" });
    expect(insertTextProblem("\x1b[A")).toMatchObject({ code: "invalid_insert_text" });
    expect(insertTextProblem("a\x7f")).toMatchObject({ code: "invalid_insert_text" });
    expect(insertTextProblem("a\u0085")).toMatchObject({ code: "invalid_insert_text" });
    expect(insertTextProblem("😀".slice(0, 1))).toMatchObject({ code: "invalid_insert_text" });
    expect(insertTextProblem("😀".slice(1))).toMatchObject({ code: "invalid_insert_text" });
    expect(insertTextProblem(`abc${"😀".slice(0, 1)}`)).toMatchObject({ code: "invalid_insert_text" });
  });

  it("takes the longest line the draft holds and refuses one past it, in code units or in bytes", () => {
    expect(insertTextProblem("a".repeat(INSERT_MAX_UNITS))).toBeNull();
    expect(insertTextProblem("a".repeat(INSERT_MAX_UNITS + 1))).toMatchObject({ code: "insert_too_long" });
    // the widest a line under the unit cap gets: three bytes a code unit, under the byte cap with room
    const widest = "한".repeat(INSERT_MAX_UNITS);
    expect(new TextEncoder().encode(widest).length).toBeLessThanOrEqual(INSERT_MAX_BYTES);
    expect(insertTextProblem(widest)).toBeNull();
    expect(insertTextProblem(`${widest}a`)).toMatchObject({ code: "insert_too_long" });
  });
});
