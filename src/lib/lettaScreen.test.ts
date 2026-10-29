import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lettaScreenWork } from "./lettaScreen.ts";

const screen = (name: string): string => readFileSync(join(import.meta.dir, "fixtures-letta-screens", `${name}-0.34.23.txt`), "utf8");
const lines = (text: string): string[] => text.replace(/\n+$/, "").split("\n");
const RULE = /^─{20,}$/;

describe("the work on a Letta Code screen", () => {
  it("ends at the spinner row of a turn at work: its tip, input box and status line are cut", () => {
    for (const name of ["working-tool", "working-typed"]) {
      const recorded = lines(screen(name));
      const spinner = recorded.findIndex((line) => line.includes("(esc to interrupt"));
      expect(spinner).toBeGreaterThan(0);
      const work = lines(lettaScreenWork(screen(name)));
      expect(work).toEqual(recorded.slice(0, spinner + 1));
      expect(work.some((line) => RULE.test(line) || line.includes("Tip:") || line.trimStart().startsWith("Letta Code ·"))).toBe(false);
    }
  });

  it("keeps what the user typed into Letta's input out of the box", () => {
    expect(screen("working-typed")).toContain("› a queued follow-up I typed");
    expect(lettaScreenWork(screen("working-typed"))).not.toContain("a queued follow-up I typed");
  });

  it("keeps the rows a tool call hangs under itself", () => {
    expect(lettaScreenWork(screen("working-tool"))).toContain("  └  Running... (0s)");
  });

  it("ends at the answer once the turn is over", () => {
    const recorded = lines(screen("done"));
    const box = recorded.findIndex((line, index) => RULE.test(line) && recorded[index + 1]?.startsWith("›"));
    expect(lines(lettaScreenWork(screen("done")))).toEqual(recorded.slice(0, box).join("\n").replace(/\n+$/, "").split("\n"));
  });

  it("shows a screen it does not recognise as Letta's unchanged", () => {
    const shell = "user@host:~/proj$ ls\nnotes.txt\nuser@host:~/proj$ ";
    expect(lettaScreenWork(shell)).toBe(shell);
    const recorded = screen("working-tool");
    const noStatusLine = lines(recorded).slice(0, -1).join("\n");
    expect(lettaScreenWork(noStatusLine)).toBe(noStatusLine);
    const tallFooter = `${recorded}one\ntwo\nthree\n`;
    expect(lettaScreenWork(tallFooter)).toBe(tallFooter);
    const noPrompt = recorded.replace("\n›\n", "\nsomething else\n");
    expect(lettaScreenWork(noPrompt)).toBe(noPrompt);
  });
});
