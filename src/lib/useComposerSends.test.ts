import { expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { paneStorageId } from "../../shared/machines.ts";
import { PendingMessageStore, pendingMessages } from "./pendingMessages.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { useComposerSends, type ComposerSendsDeps } from "./useComposerSends.ts";
import type { HerdrSocket, SubmitResult } from "./ws.ts";

// A bridge without `submit` takes a message as raw input and sends no receipt (ws.ts `unconfirmed`):
// nothing says the pane got it, so its text must not go as if it had (#1591).
function savedStorage() {
  const data = new Map<string, string>(), storage = paneLifetimes.paneStorage;
  const spies = [
    spyOn(storage, "getItem").mockImplementation((key) => data.get(key) ?? null),
    spyOn(storage, "setItem").mockImplementation((key, value) => { data.set(key, value); }),
    spyOn(storage, "removeItem").mockImplementation((key) => { data.delete(key); }),
  ];
  return { storage, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

function sends(pane: string, answer: SubmitResult, shown: string[], extra: Partial<ComposerSendsDeps> = {}) {
  let actions!: ReturnType<typeof useComposerSends>;
  function Composer() {
    const deps: Partial<ComposerSendsDeps> = {
      agent: "claude", paneId: pane, paneRef: { current: pane }, machineId: "local", queueOwner: paneStorageId("local", pane),
      socketRef: { current: { connected: true } as HerdrSocket }, sessionRef: { current: null }, pendingScopeRef: { current: "scope" },
      heldRef: { current: false }, secretRef: { current: null }, observeRef: { current: false }, draftHeldForRef: { current: null },
      stillOpenRef: { current: null }, stillOpenNotedRef: { current: false }, chatNavigation: { current: 0 }, setChatLocalSend: () => {},
      ended: false, heldByOpenQueue: false, answering: null, pendingAnswer: null, settings: { autoSendQueued: false },
      knownOutcomes: () => [], inputRowNow: () => "ready", showSentCommand: (_pane, text) => { shown.push(text); },
      submitComposerMessage: () => Promise.resolve(answer),
      ...extra,
    };
    actions = useComposerSends(deps as ComposerSendsDeps);
    return null;
  }
  renderToStaticMarkup(createElement(Composer));
  return actions;
}

it.each([
  ["unconfirmed", { ok: true, unconfirmed: true } as const],
  ["confirmed", { ok: true } as const],
])("a composer send the bridge answered %s keeps its text only while nothing confirmed it", async (kind, answer) => {
  const saved = savedStorage();
  const pane = `legacy-send-${kind}`, owner = paneStorageId("local", pane), shown: string[] = [];
  try {
    const result = await sends(pane, answer, shown).composerSend("deploy the fix");
    // the box lets it go either way: the message did leave
    expect(result).toBe(true);
    if (kind === "unconfirmed") {
      expect(pendingMessages.read(owner)).toMatchObject([{ text: "deploy the fix", state: "uncertain", serverOwned: false, error: { code: "submit_unconfirmed" } }]);
      // a reload keeps it, not confirmed, never as a copy to send again
      expect(new PendingMessageStore(() => saved.storage).read(owner)).toMatchObject([{ text: "deploy the fix", state: "uncertain" }]);
      expect(shown).toEqual([]);
    } else {
      expect(pendingMessages.read(owner)).toEqual([]);
      expect(shown).toEqual(["deploy the fix"]);
    }
  } finally {
    for (const message of pendingMessages.read(owner)) pendingMessages.removeCopy(owner, message.id);
    saved.restore();
  }
});

it.each([
  ["unconfirmed", { ok: true, unconfirmed: true } as const],
  ["confirmed", { ok: true } as const],
])("Send now of a held copy the bridge answered %s removes its recovery row only on a receipt", async (kind, answer) => {
  const saved = savedStorage();
  const pane = `legacy-held-${kind}`, owner = paneStorageId("local", pane), shown: string[] = [];
  const message = { id: `held-${kind}`, request_id: 1, text: "held follow-up", state: "held" as const, created_at: "2026-10-28T00:00:00Z" };
  try {
    // a copy kept since a connection that held it: this one sends it again by its id
    new PendingMessageStore(() => saved.storage).accept(owner, message, "earlier");
    expect(pendingMessages.read(owner)).toMatchObject([{ id: message.id, state: "held", serverOwned: false }]);
    await sends(pane, answer, shown, { pendingScopeRef: { current: "now" } }).actOnPending(message.id, "steer");
    if (kind === "unconfirmed") {
      expect(pendingMessages.read(owner)).toMatchObject([{ id: message.id, text: "held follow-up", state: "uncertain", error: { code: "submit_unconfirmed" } }]);
      expect(new PendingMessageStore(() => saved.storage).read(owner)).toMatchObject([{ id: message.id, state: "uncertain" }]);
      expect(shown).toEqual([]);
    } else {
      expect(pendingMessages.read(owner)).toEqual([]);
      expect(shown).toEqual(["held follow-up"]);
    }
  } finally {
    pendingMessages.removeCopy(owner, message.id);
    saved.restore();
  }
});
