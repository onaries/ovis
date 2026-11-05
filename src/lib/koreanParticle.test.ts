import { expect, it } from "bun:test";
import { objectParticle } from "./koreanParticle.ts";

it("picks 을 after a final consonant and 를 after a vowel, in Hangul, digits and Latin names", () => {
  const cases: [string, "을" | "를"][] = [
    ["노트북", "을"], ["서버", "를"], ["p620", "을"], ["Pixel 9", "를"], ["iPhone 15", "를"],
    ["MacBook Air", "를"], ["MacBook", "을"], ["nuc", "을"], ["old-desktop", "을"], ["Galaxy", "를"], ["Mac (work)", "을"], ["…", "를"],
  ];
  expect(cases.map(([name]) => [name, objectParticle(name)])).toEqual(cases);
});
