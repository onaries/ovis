/**
 * The header's Chat/Terminal switch, for the browser scripts: both lenses on a track from 641px, and at
 * 640px and below one button to the other lens (components/LensToggle.tsx), whose `data-view` is the lens
 * shown (a terminal peek over the chat counts as the terminal).
 */
import type { Page } from "playwright-core";

export type Lens = "chat" | "terminal";

/** Opens `lens` from the header, by a click or a finger's tap; a phone's button is left alone when `lens` is shown. */
export async function openLens(page: Page, lens: Lens, how: "click" | "tap" = "click"): Promise<void> {
  const toggle = page.locator(".app-header .lens-toggle");
  if ((await toggle.count()) > 0) {
    if ((await toggle.getAttribute("data-view")) !== lens) await toggle[how]();
    return;
  }
  await page.locator(".app-header .view-switch").getByRole("button", { name: lens === "chat" ? "Chat" : "Terminal", exact: true })[how]();
}
