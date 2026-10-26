import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "../lib/i18n.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PendingMessages } from "./PendingMessages.tsx";

const render = (code: string, message: string, languages: string[], serverOwned = true, state: "held" | "uncertain" = "held"): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: languages });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PendingMessages, {
      messages: [{ id: "p1", request_id: 1, text: "ls", state, created_at: "2026-10-14T00:00:00.000Z", serverOwned, error: { code, message } }],
      connected: true, blocked: false, unsaved: false, isBusy: () => false,
      onSendNow: async () => {}, onDiscard: async () => {},
    }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("a pending row's refusal note", () => {
  it("says a held-input refusal in the reader's language, not the raw English reason", () => {
    const held = translate("ko", "Not sent: send or discard the held input first.");
    expect(held).not.toBe("Not sent: send or discard the held input first.");
    const html = render("held_input", "send or discard the held input first", ["ko"]);
    expect(html).toContain(held);
    expect(html).not.toContain("send or discard the held input first");
  });

  it("keeps Send now on a saved copy whose send never left the browser, and says it was not sent (regression #541)", () => {
    const note = translate("ko", "Not sent: the connection dropped before this message left. Send it again.");
    expect(note).not.toBe("Not sent: the connection dropped before this message left. Send it again.");
    const html = render("not_transmitted", "the connection dropped before this message was sent", ["ko"], false);
    expect(html).toContain(note);
    expect(html).toContain("pending-message-send");
    expect(html).not.toContain("the connection dropped before this message was sent");
  });

  it("says a resend refused before the bridge said what it supports in the reader's language (#1809)", () => {
    for (const language of ["ko", "ja", "zh"] as const) {
      const note = translate(language, "Not sent: this PC has not said yet what it supports. Send it again.");
      expect(note).not.toBe("Not sent: this PC has not said yet what it supports. Send it again.");
      const html = render("capabilities_unknown", "this PC has not said yet what it supports; nothing was sent", [language], false);
      expect(html).toContain(note);
      expect(html).toContain("pending-message-send");
      expect(html).not.toContain("this PC has not said yet what it supports; nothing was sent");
    }
  });

  it("shows the still-open note as the composer wrote it, once", () => {
    const note = translate("ko", "Not sent: {command} is still open in the terminal.", { command: "/btw" });
    const html = render("still_open", note, ["ko"]);
    expect(html).toContain(note);
    expect(html).not.toContain(translate("ko", "Not sent: {message}", { message: note }));
  });

  it("keeps the server's reason for other refusals", () => {
    expect(render("agent_blocked", "the agent is busy", ["en"])).toContain("Not sent: the agent is busy");
  });

  it("encodes a live Pi receipt as the existing non-resendable uncertain state", () => {
    const html = render("pi_transcript_pending", "waiting", ["en"], true, "uncertain");
    expect(html).toContain("Sent to Pi · waiting for transcript");
    expect(html).not.toContain("pending-message-send");
    expect(html).not.toContain("Discard saved copy");
  });
});
