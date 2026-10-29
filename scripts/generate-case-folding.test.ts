import { describe, expect, it } from "bun:test";

import { caseFoldingEntries, UNICODE_VERSION } from "./generate-case-folding.ts";
import { confusableEntries, CONFUSABLES_VERSION } from "./generate-confusables.ts";

// a file with the pinned file's header and enough entries of the right shape, but other bytes (#2233)
const lines = (count: number, line: (index: number) => string) => Array.from({ length: count }, (_, index) => line(index)).join("\n");
const hex = (code: number) => code.toString(16).toUpperCase().padStart(4, "0");

describe("the Unicode tables a typed answer compares names with", () => {
  it("are read only from the pinned CaseFolding.txt, not one with its header and entry count", () => {
    const forged = `# CaseFolding-${UNICODE_VERSION}.txt\n${lines(1500, (index) => `${hex(0x100 + index)}; C; ${hex(0x61 + index % 26)}; # FORGED`)}\n`;
    expect(() => caseFoldingEntries(new TextEncoder().encode(forged))).toThrow(/SHA-256/);
  });

  it("are read only from the pinned confusables.txt, not one with its header and entry count", () => {
    const forged = `# confusables.txt\n# Version: ${CONFUSABLES_VERSION}\n${lines(7000, (index) => `${hex(0x400 + index)} ;\t${hex(0x61 + index % 26)} ;\tMA\t# FORGED`)}\n`;
    expect(() => confusableEntries(new TextEncoder().encode(forged))).toThrow(/SHA-256/);
  });
});
