import { describe, expect, it } from "bun:test";
import { reserveOsc52Copy, type ClipboardAccess } from "./osc52Clipboard.ts";

class FakeItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

/** A clipboard that, like Safari's, waits for the item's text and keeps what it had when that fails. */
function fakeClipboard(initial: string) {
  const state = { text: initial, writes: [] as Promise<void>[] };
  const access = {
    ClipboardItem: FakeItem,
    clipboard: {
      write(items: FakeItem[]) {
        const write = (async () => {
          const blob = await items[0]!.items["text/plain"]!;
          state.text = await blob.text();
        })();
        state.writes.push(write);
        return write;
      },
    },
  } as unknown as ClipboardAccess;
  return { state, access };
}

describe("reserveOsc52Copy", () => {
  it("puts the pane's copy on the clipboard through the write the click started", async () => {
    const { state, access } = fakeClipboard("before");
    const reservation = reserveOsc52Copy(1000, access)!;
    expect(state.writes).toHaveLength(1);
    expect(await reservation.fulfil("한글 copy 📋")).toBe(true);
    expect(state.text).toBe("한글 copy 📋");
    expect(reservation.pending).toBe(false);
  });

  it("leaves the clipboard as it was when no copy comes in time", async () => {
    const { state, access } = fakeClipboard("before");
    const reservation = reserveOsc52Copy(5, access)!;
    await expect(state.writes[0]!).rejects.toThrow("no copy from the pane");
    expect(state.text).toBe("before");
    expect(await reservation.fulfil("late")).toBe(false);
    expect(state.text).toBe("before");
  });

  it("leaves the clipboard as it was once cancelled, and a later copy fills nothing", async () => {
    const { state, access } = fakeClipboard("before");
    const reservation = reserveOsc52Copy(1000, access)!;
    reservation.cancel();
    await expect(state.writes[0]!).rejects.toThrow("no copy from the pane");
    expect(await reservation.fulfil("after cancel")).toBe(false);
    expect(state.text).toBe("before");
  });

  it("fills only once", async () => {
    const { state, access } = fakeClipboard("before");
    const reservation = reserveOsc52Copy(1000, access)!;
    expect(await reservation.fulfil("first")).toBe(true);
    expect(await reservation.fulfil("second")).toBe(false);
    expect(state.text).toBe("first");
  });

  it("is not made where the clipboard cannot take a pending item", () => {
    expect(reserveOsc52Copy(1000, { clipboard: undefined, ClipboardItem: FakeItem as never })).toBeNull();
    expect(reserveOsc52Copy(1000, { clipboard: { write: async () => {} }, ClipboardItem: undefined })).toBeNull();
  });
});
