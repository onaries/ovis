import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsProvider } from "../lib/settings.ts";
import { keyIdGroups } from "./KeyId.tsx";
import { RelayShell, type RelayShellProps } from "./RelayShell.tsx";

const EXPECTED = "0123456789abcdef0123456789abcdef";
/** the same id but for its third and last groups */
const RECEIVED = "01234567ffffcdef0123456789abeeee";
const none = () => {};
const props = (state: RelayShellProps["state"]): RelayShellProps => ({ state, scoped: true, iosTab: false, onPair: none, onRetry: none, onCancel: none, onBack: none, onForget: none, onUpdate: none, onMatch: none, onCodeStart: none, onCodeSubmit: none, onCodeMatch: none });
const render = (shown: RelayShellProps): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
describe("the front page's account part", () => {
  const pc = (server_id: string, name: string, state: "paired" | "needs-approval" | "offline" | "needs-update", paired = state === "paired") => ({ server_id, name, state, last_seen_at: null, added_at: null, listed: true, paired, linked: paired });

  it("offers GitHub alone until the service is set up for Apple", () => {
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain("Continue with Apple");
  });

  it("offers GitHub and Apple alike, under one title, with the QR route behind a link", () => {
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, accountProviders: ["github", "apple"] });
    expect(html).toContain('data-account-state="signed-out"');
    const buttons = [...html.matchAll(/<button type="button" class="([^"]+)">(?:<svg[\s\S]*?<\/svg>)?(Continue with [^<]+)</g)].map(([, kind, label]) => [kind, label]);
    expect(buttons).toEqual([["btn account-provider", "Continue with GitHub"], ["btn account-provider", "Continue with Apple"]]);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html.indexOf("Continue with Apple")).toBeLessThan(html.indexOf("Other ways: QR code or pairing code"));
  });

  it("puts the sign-in first beside the saved PCs, with the QR code and pairing code folded under Other ways", () => {
    const device = { server_id: "a".repeat(32), server_public_key: "k", relay: "wss://relay.example", name: "p620", device_id: "0".repeat(16), label: "Phone" } as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
    const html = render({ ...props({ kind: "list", devices: [device], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    const fold = html.indexOf("<details");
    expect(html.indexOf("Continue with GitHub")).toBeLessThan(fold);
    expect(html.indexOf("Pair with a code")).toBeGreaterThan(fold);
    // without an account service the QR route is the page itself
    expect(render({ ...props({ kind: "list", devices: [device] }), scoped: false })).not.toContain("<details");
  });

  it("offers a PC new in the account as a card to add, which opens the typed comparison", () => {
    const fresh = { ...pc("b".repeat(32), "desk2", "needs-approval"), added_at: new Date().toISOString(), join: { server_public_key: "k", relay: "wss://relay.example" } };
    const old = { ...fresh, server_id: "c".repeat(32), name: "nuc", added_at: new Date(Date.now() - 3_600_000).toISOString() };
    const html = render({ ...props({ kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null, pcs: [fresh, old] } }), scoped: false, onSignIn: none, onJoin: none });
    expect(html).toContain("Add desk2 to your account?");
    expect(html).not.toContain("Add nuc to your account?");
  });

  it("asks for the number the new PC shows instead of showing one, and says so when it was wrong", () => {
    const typed = render(props({ kind: "compare", name: "desk2", digits: "123456", confirmed: false, typed: true }));
    expect(typed).toContain("Type the number desk2 shows");
    expect(typed).not.toContain("123 456");
    expect(typed).toContain('name="digits"');
    const wrong = render(props({ kind: "compare", name: "desk2", digits: "", confirmed: false, typed: true, wrong: true }));
    expect(wrong).toContain("That is not the number desk2 shows");
    expect(wrong).not.toContain('name="digits"');
  });

  it("opens a paired PC and leaves one that has not approved this device as a plain row", () => {
    const html = render({ ...props({ kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null,
      pcs: [pc("a".repeat(32), "p620", "paired"), pc("b".repeat(32), "nuc", "needs-approval"), pc("c".repeat(32), "old-desktop", "offline", false), pc("d".repeat(32), "laptop", "offline", true)] } }), scoped: false, onSignIn: none });
    expect(html).toContain(`href="/s/${"a".repeat(32)}/"`);
    expect(html).not.toContain(`href="/s/${"b".repeat(32)}/"`);
    // offline says nothing about pairing: only the PC this device is paired with opens
    expect(html).not.toContain(`href="/s/${"c".repeat(32)}/"`);
    expect(html).toContain(`href="/s/${"d".repeat(32)}/"`);
    expect(html).toContain("Needs approval");
    expect(html).not.toContain("Continue with GitHub");
  });

});

const groupsOf = (html: string) => [...html.matchAll(/<span class="(key-id-group(?: key-id-differs)?)">([0-9a-f]{4})/g)].map(([, kind, group]) => [group, kind === "key-id-group key-id-differs"]);

describe("a key that is not the PC's", () => {
  it("splits an id into eight groups of four", () => {
    expect(keyIdGroups(EXPECTED)).toEqual(["0123", "4567", "89ab", "cdef", "0123", "4567", "89ab", "cdef"]);
  });

  for (const state of [
    { kind: "forged", name: "Desk", mismatch: { expected: EXPECTED, received: RECEIVED, from: "link" } },
    { kind: "failed", failure: "identity-changed", name: "Desk", detail: null, mismatch: { expected: EXPECTED, received: RECEIVED, from: "saved" } },
  ] as const) {
    it(`shows the PC's id and the other key's, marking the groups that differ (${state.kind})`, () => {
      const html = render(props(state));
      expect(html).toContain('data-relay-state="identity-changed"');
      const [pcGroups, receivedGroups] = [groupsOf(html).slice(0, 8), groupsOf(html).slice(8)];
      expect(pcGroups.every(([, differs]) => differs === false)).toBe(true);
      expect(receivedGroups).toEqual([["0123", false], ["4567", false], ["ffff", true], ["cdef", false], ["0123", false], ["4567", false], ["89ab", false], ["eeee", true]]);
      // a differing group is named for a screen reader, not told by colour alone
      expect(html.match(/visually-hidden">\s*differs</g)).toHaveLength(2);
    });
  }

  it("never calls an id the PC's: each is labelled by where it came from", () => {
    const forged = render(props({ kind: "forged", name: "Desk", mismatch: { expected: EXPECTED, received: RECEIVED, from: "link" } }));
    expect(forged).not.toContain("This PC&#x27;s ID");
    expect(forged).toContain("ID this link names");
    expect(forged).toContain("ID of the key this link carries");
    // a bad saved key under a genuine link is the saved key's, not the link's
    const changed = render(props({ kind: "failed", failure: "identity-changed", name: "Desk", detail: null, mismatch: { expected: EXPECTED, received: RECEIVED, from: "saved" } }));
    expect(changed).toContain("ID this phone paired with");
    expect(changed).toContain("ID of the key this phone saved");
    expect(changed).not.toContain("this link carries");
  });

  it("says a key that does not parse is not a valid key, and still shows the PC's id", () => {
    const html = render(props({ kind: "forged", name: null, mismatch: { expected: EXPECTED, received: null, from: "link" } }));
    expect(html).toContain("Not a valid key");
    expect(groupsOf(html)).toHaveLength(8);
  });
});

describe("pairing with a typed code", () => {
  it("shows every group of the ID a code found before anything is paired", () => {
    const html = render(props({ kind: "code-compare", offer: { v: 1, server_id: EXPECTED, server_public_key: "k", relay: "wss://relay.example", code: "123456", name: "Desk" } }));
    for (const group of keyIdGroups(EXPECTED)) expect(html).toContain(`>${group}<`);
    expect(html).toContain("It matches");
    expect(html).toContain('data-relay-state="code-compare"');
  });

  it("keeps the code in its field only, and says why the last one gave no PC", () => {
    const html = render(props({ kind: "code-entry", failure: "no-pc" }));
    expect(html).toMatch(/<input[^>]*name="code"/);
    expect(html).not.toMatch(/<input[^>]*name="code"[^>]*value=/);
    expect(html).toContain("No PC shows this code");
  });
});
