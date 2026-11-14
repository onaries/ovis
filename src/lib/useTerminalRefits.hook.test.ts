import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Terminal } from "@xterm/xterm";
import { fontSettled } from "./fontFamily.ts";
import { useTerminalRefits, type TerminalRefitsDeps } from "./useTerminalRefits.ts";
import { HerdrSocket } from "./ws.ts";

/** A WebSocket the test opens, recording what the client sends; opening it again is the connection made again. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static last: FakeSocket;
  readyState = FakeSocket.CONNECTING;
  readonly sent: { type: string; [key: string]: unknown }[] = [];
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly url: string) { FakeSocket.last = this; }
  addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = FakeSocket.OPEN; for (const listener of this.listeners.get("open") ?? []) listener({}); }
}

const PANE = "w1:p1";
/** one theme for every render, as the settings give it: the theme is set again only when it changes */
const COLORS = {} as TerminalRefitsDeps["colors"];

describe("useTerminalRefits under the inbox mode's list", () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let client: HerdrSocket;
  let socket: FakeSocket;
  const termRef: RefObject<Terminal | null> = { current: null };

  beforeEach(() => {
    for (const key of ["IS_REACT_ACT_ENVIRONMENT", "WebSocket", "window", "document"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    // the page in use: a pane shown again sizes its pty only then
    Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", hasFocus: () => true, addEventListener() {}, removeEventListener() {} } });
    termRef.current = null;
    client = new HerdrSocket("ws://test/ws");
    client.connect();
    socket = FakeSocket.last;
    socket.open();
    // shown, the pane sized the pty: it holds the size
    client.attach(PANE, 100, 30);
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    client.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    saved.clear();
  });

  const ref = <T,>(current: T): RefObject<T> => ({ current });
  function Probe({ covered }: { covered: boolean }) {
    const deps: TerminalRefitsDeps = {
      activeRef: ref(false), autoSelected: false, baseFontRef: ref(13), pinchingRef: ref(false), fontSettledRef: ref(fontSettled()),
      chatView: false, chatViewRef: ref(false), coarseRef: ref(false), covered, findOpenRef: ref(false), fitRef: ref(null), fittedRef: ref(() => {}),
      fixedGridRef: ref(false), follow: false, followCursorRef: ref(() => {}), keyboardHoldsRef: ref(() => false), narrowFont: false,
      narrowFontFitted: ref(false), observeRef: ref(false), colors: COLORS, paneRef: ref(PANE), peekRef: ref(null),
      sharedGridRef: ref(null), shown: true, sizesPty: () => true, socketRef: ref(client), termRef, terminalFontFamily: "", terminalFontSize: 13,
    };
    useTerminalRefits(deps);
    return null;
  }
  const draw = async (covered: boolean): Promise<void> => {
    await act(async () => {
      if (renderer) renderer.update(createElement(Probe, { covered }));
      else renderer = create(createElement(Probe, { covered }));
    });
  };
  /** the frames sent since `from` that attach or size the pane */
  const sizing = (from: number) => socket.sent.slice(from).filter((frame) => ["attach", "resize", "release-size"].includes(frame.type));

  it("attaches a pane the list covers keeping the pty's size when the connection comes back, and asks for its grid as it is shown", async () => {
    await draw(false);
    await draw(true);
    const from = socket.sent.length;
    socket.open();
    expect(sizing(from)).toEqual([{ type: "attach", pane_id: PANE, cols: 100, rows: 30, flow_control: "ack", receipt_resume_id: expect.any(String), keep_size: true }]);
    termRef.current = { cols: 100, rows: 30 } as Terminal;
    const shown = socket.sent.length;
    await draw(false);
    expect(sizing(shown)).toEqual([{ type: "resize", pane_id: PANE, cols: 100, rows: 30 }]);
  });

  it("sends nothing for a pane the list covers and shows again in the box it had, the connection unbroken", async () => {
    await draw(false);
    const from = socket.sent.length;
    await draw(true);
    termRef.current = { cols: 100, rows: 30 } as Terminal;
    await draw(false);
    expect(sizing(from)).toEqual([]);
  });
});
