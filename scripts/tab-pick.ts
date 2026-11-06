import type { Page } from "playwright-core";

/**
 * Opens a tab as a user does at the page's width: a phone's header title lists the workspace's tabs
 * (TabStrip's sheet), a wider screen clicks the tab in its strip.
 */
export async function pickTab(page: Page, tabId: string): Promise<void> {
  const title = page.locator(".app-header .context-tabs");
  if (!(await title.isVisible())) {
    await page.locator(`.tab-strip [role="tab"][data-tab-id="${tabId}"]`).click();
    return;
  }
  await title.click();
  const sheet = page.locator(".row-sheet");
  await sheet.locator(`.row-sheet-item[data-item="tab:${tabId}"]`).click();
  await sheet.waitFor({ state: "detached" });
}
