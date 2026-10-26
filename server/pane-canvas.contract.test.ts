import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { paneFocus, paneSplit, sessionSnapshot, tabCreate, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ApiError, PaneLayoutSnapshot, PaneSwapped, ServerMessage } from "../shared/protocol.ts";

describe("pane canvas: focus, explicit swap and dragged split ratio", () => {
  const state = mkdtempSync(join(tmpdir(), "ovis-canvas-contract-"));
  let server: ReturnType<typeof createServer>;
  let workspaceId: string;
  let tabId: string;
  let root: string;
  let right: string;
  let below: string;
  let anotherTab: string;
  const post = (path: string, body: unknown) => fetch(`http://localhost:${server.port}/api/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const current = async (): Promise<PaneLayoutSnapshot> => {
    const layout = (await sessionSnapshot()).layouts.find((candidate) => candidate.tab_id === tabId);
    if (!layout) throw new Error("owned tab has no layout");
    return layout;
  };
  const until = async (check: (layout: PaneLayoutSnapshot) => boolean): Promise<PaneLayoutSnapshot> => {
    const layout = await current();
    expect(check(layout)).toBe(true);
    return layout;
  };
  const within = <T>(promise: Promise<T>): Promise<T> => {
    const deadline = Promise.withResolvers<T>();
    const timer = setTimeout(() => deadline.reject(new Error("contract event did not arrive")), 10_000);
    return Promise.race([promise, deadline.promise]).finally(() => clearTimeout(timer));
  };

  beforeAll(async () => {
    server = createServer({ port: 0, stateDir: state });
    await within(server.focusReady);
    const created = await workspaceCreate({ cwd: state, label: "ovis-test-canvas" });
    workspaceId = created.workspace.workspace_id;
    root = created.root_pane.pane_id;
    tabId = created.root_pane.tab_id;
    right = (await paneSplit(root, "right", false)).pane_id;
    below = (await paneSplit(right, "down", false)).pane_id;
    anotherTab = (await tabCreate({ workspaceId })).root_pane.pane_id;
  });
  afterAll(async () => {
    server?.stop();
    if (workspaceId) await workspaceClose(workspaceId).catch(() => undefined);
    rmSync(state, { recursive: true, force: true });
  });

  it("focuses exactly the requested pane, workspace and tab and follows it while zoomed", async () => {
    expect(await (await post("pane/focus", { pane_id: right })).json()).toEqual({ ok: true });
    const snapshot = await sessionSnapshot();
    expect(snapshot.focused_pane_id).toBe(right);
    expect(snapshot.focused_workspace_id).toBe(workspaceId);
    expect(snapshot.focused_tab_id).toBe(tabId);
    await post("pane/zoom", { pane_id: root, mode: "on" });
    expect(await (await post("pane/focus", { pane_id: below })).json()).toEqual({ ok: true });
    await until((layout) => layout.zoomed && layout.focused_pane_id === below);
    await post("pane/zoom", { pane_id: below, mode: "off" });
    const missing = await post("pane/focus", { pane_id: "no-such-pane" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).error.code).toBe("pane_not_found");
  });

  it("swaps with the named pane and leaves other panes' geometry intact", async () => {
    await paneFocus(root);
    const before = await current();
    const rect = (layout: PaneLayoutSnapshot, id: string) => layout.panes.find((pane) => pane.pane_id === id)!.rect;
    const response = await post("pane/swap", { pane_id: root, target_pane_id: below });
    expect(response.status).toBe(200);
    expect((await response.json()) as PaneSwapped).toEqual({ ok: true, changed: true, reason: null, target_pane_id: below });
    const after = await until((layout) => rect(layout, root).x === rect(before, below).x && rect(layout, root).y === rect(before, below).y);
    expect(rect(after, root)).toEqual(rect(before, below));
    expect(rect(after, below)).toEqual(rect(before, root));
    expect(rect(after, right)).toEqual(rect(before, right));
    expect(after.focused_pane_id).toBe(root);
    for (const [target, reason] of [[root, "same_pane"], [anotherTab, "cross_tab"], ["missing-pane", "not_found"]]) {
      expect(await (await post("pane/swap", { pane_id: root, target_pane_id: target })).json()).toEqual({ ok: true, changed: false, reason, target_pane_id: target });
    }
  });

  it("keeps herdr focused in another workspace after an explicit swap, including refusals", async () => {
    const elsewhere = await workspaceCreate({ cwd: state, label: "ovis-test-canvas-focus" });
    try {
      await paneFocus(elsewhere.root_pane.pane_id);
      const focused = await sessionSnapshot();
      for (const target of [below, below, root, anotherTab, "missing-pane"]) {
        const response = await post("pane/swap", { pane_id: root, target_pane_id: target });
        expect(response.status).toBe(200);
        const after = await sessionSnapshot();
        expect(after.focused_pane_id).toBe(focused.focused_pane_id);
        expect(after.focused_tab_id).toBe(focused.focused_tab_id);
        expect(after.focused_workspace_id).toBe(focused.focused_workspace_id);
      }
    } finally {
      await workspaceClose(elsewhere.workspace.workspace_id);
    }
  });

  it("moves a named nested split without changing its parent and accepts the same ratio twice", async () => {
    const before = await current();
    expect(before.splits.length).toBe(2);
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await post("layout/ratio", { tab_id: tabId, path: [true], ratio: 0.7 });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    const after = await until((layout) => Math.abs(layout.splits[1]!.ratio - 0.7) < 0.0001);
    expect(after.splits[0]!.ratio).toBe(before.splits[0]!.ratio);
    expect(after.splits[1]!.id).toMatch(/_1$/);
    const leftBefore = before.panes.find((pane) => pane.pane_id === below)!.rect;
    expect(after.panes.find((pane) => pane.pane_id === below)!.rect).toEqual(leftBefore);
    const missing = await post("layout/ratio", { tab_id: tabId, path: [false], ratio: 0.5 });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).error.code).toBe("split_not_found");
    const unknown = await post("layout/ratio", { tab_id: "no-such-tab", path: [], ratio: 0.5 });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as ApiError).error.code).toBe("layout_not_found");
  });

  it("tells a browser where herdr's focus moved when herdr itself moved it", async () => {
    // Fresh, never-focused panes cannot match queued focus events from the preceding tests.
    const first = (await paneSplit(root, "right", false)).pane_id;
    const second = (await paneSplit(anotherTab, "right", false)).pane_id;
    const focused: string[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const opened = Promise.withResolvers<void>();
    socket.addEventListener("open", () => opened.resolve(), { once: true });
    socket.addEventListener("error", () => opened.reject(new Error("socket failed")), { once: true });
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerMessage;
      if (frame.type === "pane-focused") focused.push(frame.pane_id);
    });
    try {
      await within(opened.promise);
      for (const paneId of [first, second]) {
        const arrived = Promise.withResolvers<void>();
        const listener = (event: MessageEvent) => {
          const frame = JSON.parse(String(event.data)) as ServerMessage;
          if (frame.type === "pane-focused" && frame.pane_id === paneId) arrived.resolve();
        };
        socket.addEventListener("message", listener);
        try {
          await paneFocus(paneId);
          await within(arrived.promise);
        } finally { socket.removeEventListener("message", listener); }
      }
      expect(focused.slice(-2)).toEqual([first, second]);
    } finally {
      socket.close();
    }
  });
});
