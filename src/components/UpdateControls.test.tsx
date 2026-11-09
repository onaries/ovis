import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { UpdateStatus } from "../../shared/update.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import { SettingsBare } from "./SettingsControls.tsx";
import { UpdateControls } from "./UpdateControls.tsx";

Object.assign(globalThis, { __APP_VERSION__: "0.4.22" });

const blocked: UpdateStatus = {
  managed: true, auto_update: false, phase: "idle", current_revision: "c4418bca", latest_revision: "c4418bca",
  current_version: "0.4.22", latest_version: "0.4.22", available: false, checked_at: null,
  blocked_reason: "Switch the source checkout to main to update.", error: null,
};

const updates = (status: UpdateStatus): UpdatesModel => ({
  status, error: null, busy: false, needsReload: false, reload: null, notes: null, installed: null,
  request: async () => undefined, failure: null, offered: null,
} as unknown as UpdatesModel);

function render(bare: boolean): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, null,
      createElement(SettingsBare.Provider, { value: bare }, createElement(UpdateControls, { updates: updates(blocked) }))));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

const heading = (html: string): string => /<h3 id="settings-updates-title"[^>]*>/.exec(html)?.[0] ?? "";

// About joins its sections into one card (herdr-app's About list): a caption between two of its
// rows splits that card in two. The full section (a blocked check, an install, a failure) keeps its
// name for a link and a screen reader there, out of sight like the compact line's.
describe("the Updates section's heading", () => {
  it("is out of sight inside About's joined card", () => {
    expect(heading(render(true))).toContain('class="visually-hidden"');
  });

  it("stays a visible caption on a page with captions", () => {
    const shown = heading(render(false));
    expect(shown).not.toBe("");
    expect(shown).not.toContain("visually-hidden");
  });
});
