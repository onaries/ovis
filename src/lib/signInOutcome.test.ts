import { describe, expect, it } from "bun:test";

import { signInOutcome } from "./signInOutcome.ts";

describe("signInOutcome", () => {
  it("names the account a first sign-in added", () => {
    expect(signInOutcome([], ["me@example.com"], false)).toEqual({ kind: "signed-in", account: "me@example.com" });
    expect(signInOutcome(["work@example.com"], ["work@example.com", "me@example.com"], false)).toEqual({ kind: "signed-in", account: "me@example.com" });
  });

  it("counts a new sign-in whose account the PC cannot name", () => {
    expect(signInOutcome([null], [null, null], false)).toEqual({ kind: "signed-in", account: null });
  });

  it("says a sign-in that added nothing did not sign in", () => {
    expect(signInOutcome([], [], false)).toEqual({ kind: "not-signed-in" });
    expect(signInOutcome(["me@example.com"], ["me@example.com"], false)).toEqual({ kind: "not-signed-in" });
  });

  it("says signing in again finished, whatever the names, while the account is still there", () => {
    expect(signInOutcome(["me@example.com"], ["me@example.com"], true)).toEqual({ kind: "finished" });
    expect(signInOutcome(["me@example.com"], [], true)).toEqual({ kind: "not-signed-in" });
  });
});
