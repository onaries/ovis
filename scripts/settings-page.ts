import type { Page } from "playwright-core";

/**
 * Waits for a sheet (Settings by default, or the palette) to finish rising: on a phone it rises from
 * the bottom edge, and a click aimed at it while it rises lands where its control was, not where it
 * is (on a loaded runner, the X's click landed on Settings' header under it, and Settings stayed open).
 */
export async function sheetRisen(page: Page, selector = ".settings-dialog"): Promise<void> {
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAnimations().length === 0, selector);
}

/**
 * Settings shows one page at a time: opens the one a check needs, in a dialog that is already
 * open or opening. A phone lists the pages first, and from another page the way there is back.
 */
export async function openSettingsPage(page: Page, name: string, backName = "Back to settings"): Promise<void> {
  const dialog = page.locator(".settings-dialog");
  await dialog.waitFor();
  await sheetRisen(page);
  const tab = dialog.getByRole("tab", { name, exact: true });
  if (await tab.count() === 0) await dialog.getByRole("button", { name: backName, exact: true }).click();
  await tab.click();
  await dialog.getByRole("tabpanel", { name, exact: true }).waitFor();
}
