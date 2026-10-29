import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { useWorktreeBranches } from "./useWorktreeBranches.ts";

const repository = { workspace_id: "w1", worktree: { repo_key: "repo", repo_name: "repo", repo_root: "/work/repo", checkout_path: "/work/repo", is_linked_worktree: false } } as WorkspaceInfo;
const snapshot = { workspaces: [repository], tabs: [], panes: [], agents: [] } as unknown as SessionSnapshot;

// Keep React, the hook, its cache and the API function real; only the network is a stand-in.
describe("useWorktreeBranches", () => {
  let renderer: ReactTestRenderer | null = null;
  /** while set, every listing is refused as a watching device's is (#2250) */
  let refused = false;
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  function Probe({ watching = false }: { watching?: boolean }) { useWorktreeBranches(snapshot, true, false, undefined, watching); return null; }
  /** Lets the read's promise chain finish: a bounded number of turns, each inside act. */
  const settle = async (done: () => boolean) => { for (let turn = 0; turn < 50 && !done(); turn++) await act(async () => { await Promise.resolve(); }); };

  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  beforeAll(() => {
    for (const key of ["document", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    // a page on screen: the poll runs only while it is
    Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} } });
  });
  afterAll(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  beforeEach(() => {
    jest.useFakeTimers();
    refused = false;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      if (refused) return Response.json({ error: { code: "read_only", message: "this device can only watch" } }, { status: 403 });
      return Response.json({ source: { repo_key: "repo" }, worktrees: [{ path: "/work/repo", branch: "main", is_detached: false, open_workspace_id: "w1" }] });
    }, { preconnect: globalThis.fetch.preconnect }));
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    fetchSpy.mockRestore();
    jest.useRealTimers();
  });

  it("asks a driving device's PC again on its next poll", async () => {
    await act(async () => { renderer = create(createElement(Probe)); });
    await settle(() => fetchSpy.mock.calls.length >= 1);
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await settle(() => fetchSpy.mock.calls.length >= 2);
    expect(fetchSpy.mock.calls.length).toBe(2);
  });

  it("does not ask again when the device may only watch (#2250)", async () => {
    refused = true;
    await act(async () => { renderer = create(createElement(Probe)); });
    await settle(() => fetchSpy.mock.calls.length >= 1);
    await settle(() => false);
    await act(async () => { jest.advanceTimersByTime(120_000); });
    await settle(() => false);
    expect(fetchSpy.mock.calls.length).toBe(1);
  });

  it("asks nothing while watching, and reads branches once the device may drive (#2250)", async () => {
    await act(async () => { renderer = create(createElement(Probe, { watching: true })); });
    await settle(() => false);
    await act(async () => { jest.advanceTimersByTime(60_000); });
    await settle(() => false);
    expect(fetchSpy.mock.calls.length).toBe(0);
    // a refusal seen before the page learns the role does not outlive the role either
    refused = true;
    await act(async () => { renderer!.update(createElement(Probe, { watching: false })); });
    await settle(() => fetchSpy.mock.calls.length >= 1);
    refused = false;
    await act(async () => { renderer!.update(createElement(Probe, { watching: true })); });
    await act(async () => { renderer!.update(createElement(Probe, { watching: false })); });
    await settle(() => fetchSpy.mock.calls.length >= 2);
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await settle(() => fetchSpy.mock.calls.length >= 3);
    expect(fetchSpy.mock.calls.length).toBe(3);
  });
});
