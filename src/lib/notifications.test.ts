import { afterEach, describe, expect, it } from "bun:test";
import type { AgentStatus } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { alertStatus, alertsAllow, paneAlertsMuted, shouldNotifyStatus, showPaneEndedNotification, showPaneStatusNotification } from "./notifications.ts";

describe("alertStatus", () => {
  it("takes a pane at rest that waits on its turn's background work for working, and leaves the rest as they are", () => {
    expect(["done", "idle", "unknown"].map((status) => alertStatus(status, true))).toEqual(["working", "working", "working"]);
    expect(alertStatus("blocked", true)).toBe("blocked");
    expect(alertStatus("done", false)).toBe("done");
    expect(alertStatus("done", undefined)).toBe("done");
    // a wait that ends with no new turn is a finish
    expect(shouldNotifyStatus(alertStatus("done", true), alertStatus("done", false))).toBe(true);
  });
});

describe("shouldNotifyStatus", () => {
  it("notifies when a known pane becomes blocked", () => {
    expect(shouldNotifyStatus("working", "blocked")).toBe(true);
  });

  it("notifies when a known pane becomes done", () => {
    expect(shouldNotifyStatus("blocked", "done")).toBe(true);
  });

  it("does not notify for the busy baseline states", () => {
    expect(shouldNotifyStatus("idle", "working")).toBe(false);
    expect(shouldNotifyStatus("working", "idle")).toBe(false);
  });

  it("does not notify when the status does not change", () => {
    expect(shouldNotifyStatus("blocked", "blocked")).toBe(false);
  });

  it("does not notify on first sight of a pane", () => {
    // the app just opened or the pane is new: not news
    expect(shouldNotifyStatus(undefined, "blocked")).toBe(false);
  });

  it("carries unknown future statuses through without notifying", () => {
    expect(shouldNotifyStatus("working", "teleporting" as AgentStatus)).toBe(false);
  });
});

describe("alertsAllow", () => {
  it("lets through what the device chose, and nothing that is not an alert", () => {
    expect(alertsAllow({ input: true, done: "off" }, "blocked")).toBe(true);
    expect(alertsAllow({ input: false, done: "always" }, "blocked")).toBe(false);
    expect(alertsAllow({ input: false, done: "long" }, "done")).toBe(true);
    expect(alertsAllow({ input: true, done: "off" }, "done")).toBe(false);
    expect(alertsAllow({ input: true, done: "always" }, "working")).toBe(false);
  });
});

describe("paneAlertsMuted", () => {
  it("all four paths suppress only the keyed pane", () => {
    // one predicate for the in-app alert, the chime, the tab notification (App.tsx) and web push (server/push.ts):
    // the shared list keys a pane with its PC, so the same pane id on another PC is not muted with it
    const muted = [paneStorageId("local", "w1:p1"), paneStorageId("pc-2", "w1:p2")];
    expect(paneAlertsMuted(muted, "local", "w1:p1")).toBe(true);
    expect(paneAlertsMuted(muted, "pc-2", "w1:p1")).toBe(false);
    expect(paneAlertsMuted(muted, "local", "w1:p2")).toBe(false);
    expect(paneAlertsMuted(muted, "pc-2", "w1:p2")).toBe(true);
    // a bare remote pane id never matches its key
    expect(muted).not.toContain("w1:p2");
    // no list (an older server, or none heard yet) mutes nothing
    expect(paneAlertsMuted(null, "local", "w1:p1")).toBe(false);
    expect(paneAlertsMuted(undefined, "local", "w1:p1")).toBe(false);
    expect(paneAlertsMuted([], "local", "w1:p1")).toBe(false);
  });
});

describe("tab alerts shown through the worker", () => {
  const saved = { Notification: globalThis.Notification, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"), document: Object.getOwnPropertyDescriptor(globalThis, "document") };
  afterEach(() => {
    (globalThis as { Notification?: unknown }).Notification = saved.Notification;
    for (const key of ["navigator", "document"] as const) {
      const descriptor = saved[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  /** A hidden tab with a worker: what each alert asked the worker to show. */
  function hiddenTabWithWorker(): Array<{ data: unknown }> {
    const shown: Array<{ data: unknown }> = [];
    (globalThis as { Notification?: unknown }).Notification = { permission: "granted" };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: true } });
    const registration = { active: {}, showNotification: async (_title: string, options: { data: unknown }) => { shown.push({ data: options.data }); } };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { getRegistration: async () => registration } } });
    return shown;
  }

  it("names the pane's workspace, as the server's push does, so a tap after the pane ends opens it (public/sw.js)", async () => {
    const shown = hiddenTabWithWorker();
    showPaneEndedNotification("w1:p9", "Mac · claude", undefined, "local", "w1");
    showPaneStatusNotification("w2:p1", "Mac · codex", "blocked", undefined, "pc-2", "w2");
    showPaneStatusNotification("w3:p1", "Mac · codex", "done", undefined, "local");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown.map((entry) => entry.data)).toEqual([
      { pane_id: "w1:p9", machine_id: "local", workspace_id: "w1" },
      { pane_id: "w2:p1", machine_id: "pc-2", workspace_id: "w2" },
      { pane_id: "w3:p1", machine_id: "local" },
    ]);
  });
});
