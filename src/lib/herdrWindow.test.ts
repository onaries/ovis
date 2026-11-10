import { describe, expect, it } from "bun:test";
import { HERDR_WINDOW_CHOICES } from "./herdrWindow.ts";

describe("herdr window choices", () => {
  for (const [choice, releasePaneAway, followHerdrFocus] of [
    ["separate", false, false],
    ["alongside", true, false],
    ["follow", true, true],
  ] as const) {
    it(`${choice} pairs its saved flags with its own description key`, () => {
      const { descriptionKey, ...flags } = HERDR_WINDOW_CHOICES[choice];
      expect(flags.releasePaneAway).toBe(releasePaneAway);
      expect(flags.followHerdrFocus).toBe(followHerdrFocus);
      expect(descriptionKey.length).toBeGreaterThan(0);
      for (const [other, entry] of Object.entries(HERDR_WINDOW_CHOICES)) {
        if (other !== choice) expect(entry.descriptionKey).not.toBe(descriptionKey);
      }
    });
  }
});
