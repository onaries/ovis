import { describe, expect, it } from "bun:test";

import { confirmation, recordConfirmation } from "./pushConfirm.ts";

const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

describe("the confirmation push's outcome", () => {
  it("is kept for the subscription it went to, and is no answer for another", () => {
    const storage = memory();
    expect(confirmation("https://push.example/1", storage)).toBeNull();
    recordConfirmation("https://push.example/1", false, storage);
    expect(confirmation("https://push.example/1", storage)).toBe(false);
    expect(confirmation("https://push.example/2", storage)).toBeNull();
    expect(confirmation(null, storage)).toBeNull();
    recordConfirmation("https://push.example/1", true, storage);
    expect(confirmation("https://push.example/1", storage)).toBe(true);
  });

  it("is none where storage refuses", () => {
    const refusing = { getItem: (): string | null => { throw new Error("denied"); }, setItem: (): void => { throw new Error("denied"); } };
    expect(() => recordConfirmation("https://push.example/1", true, refusing)).not.toThrow();
    expect(confirmation("https://push.example/1", refusing)).toBeNull();
    expect(confirmation("https://push.example/1", null)).toBeNull();
  });
});
