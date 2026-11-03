import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { Machine } from "../shared/machines.ts";
import type { UpdateStatus } from "../shared/update.ts";
import { openSettingsPage } from "./settings-page.ts";

/**
 * The lines under the header, on a phone: a release is installed from its line with one button
 * and shows its steps, the line for a PC that needs a bridge update can be closed for good, and a
 * checkout replaced under the server asks for a restart that a reload does not clear.
 * The update status and the waiting PC are answered here; nothing is installed.
 */
export async function checkUpdateNotice(browser: Browser, origin: string, shots?: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    await context.addInitScript(() => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const shot = async (name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };

    let status: UpdateStatus = {
      managed: true, auto_update: false, phase: "idle", current_revision: null, latest_revision: "b".repeat(40),
      current_version: "0.0.1", latest_version: "9.9.9", available: true, checked_at: new Date().toISOString(), blocked_reason: null, error: null, step: null,
      revision_bound_install: true,
    };
    let installs = 0;
    let checks = 0;
    await page.route("**/api/updates", (route) => route.fulfill({ json: status }));
    await page.route("**/api/updates/install", async (route) => {
      installs += 1;
      // as the updater does: an install starts with a check, which reports nothing available yet
      status = { ...status, phase: "checking", available: false };
      await route.fulfill({ status: 202, json: { accepted: true } });
    });
    await page.route("**/api/updates/check", async (route) => {
      checks += 1;
      status = { ...status, phase: "idle", available: true, error: null };
      await route.fulfill({ status: 202, json: { accepted: true } });
    });
    const pc: Machine = { id: "qa-pc", name: "QA PC", kind: "ssh", target: { destination: "qa@example.invalid" }, enabled: true, state: "error", error: null, action_required: "update_bridge", snapshot: null };
    let remote: Machine | null = null;
    // The real SSE roster would remove the synthetic PC between these polled snapshots.
    await context.route("**/api/machines/events", (route) => route.abort());
    await page.route("**/api/machines", async (route) => {
      const body = await (await route.fetch()).json() as { machines: Machine[] };
      await route.fulfill({ json: { ...body, machines: remote ? [...body.machines, remote] : body.machines } });
    });

    await page.goto(origin);
    const notice = page.locator(".update-notice").filter({ hasText: /Ovis|update|Step|Starting/i }).first();
    const fits = async (label: string) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: nothing overflows sideways`);
    // a release's line is one row on a phone: its sentence, its buttons and its bar share one top
    const oneLine = async (label: string) => assert.equal(await page.evaluate(() => {
      const line = document.querySelector(".update-notice.is-line");
      if (!line) return "no line";
      const rows = new Set([...line.querySelectorAll(":scope > *, .bridge-progress-step, .bridge-progress-bar")].map((item) => Math.round(item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2)));
      const text = line.querySelector(":scope > span, .bridge-progress-step > span");
      const wrapped = text ? text.getBoundingClientRect().height > parseFloat(getComputedStyle(text).fontSize) * 2 : false;
      return rows.size === 1 && !wrapped ? "one" : `rows ${[...rows].join(",")}${wrapped ? ", wrapped" : ""}`;
    }), "one", `${label}: the line is one row`);

    // one button, and no detour through Settings
    await page.getByText("Ovis v9.9.9 is available.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "View update", exact: true }).count(), 0, "the line has no View update button");
    // the line is the pane column's, never a bar across the window between the header and the sidebar
    assert.ok(await page.locator(".pane-column > .update-notice").count() > 0, "the notice is drawn in the pane column");
    assert.equal(await page.locator(":not(.pane-column) > .update-notice").count(), 0, "and nowhere else");
    await fits("available");
    await oneLine("available");
    await shot("1-available");
    // the line says it started as the button is pressed, before the request it sends is counted here
    const installAnswered = () => page.waitForResponse((response) => new URL(response.url()).pathname === "/api/updates/install");
    const firstInstall = installAnswered();
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await page.getByText("Starting the update…", { exact: true }).waitFor();
    await firstInstall;
    assert.equal(installs, 1, "one tap asks for the install");
    assert.equal(await page.getByRole("dialog", { name: "Settings" }).count(), 0, "Settings stays closed");

    status = { ...status, phase: "building", step: "build" };
    await page.getByText("Building the app", { exact: true }).waitFor();
    await page.getByText("Step 4 of 5", { exact: true }).waitFor();
    assert.equal(await notice.getByRole("progressbar").getAttribute("aria-valuenow"), "70");
    await fits("installing");
    await oneLine("installing");
    await shot("2-installing");
    status = { ...status, phase: "restarting", step: "restart" };
    await page.getByText("Step 5 of 5", { exact: true }).waitFor();

    // a failed install says so on the line, and the whole error is one tap away
    status = { ...status, phase: "error", step: null, available: true, error: "bun run build failed: fixture" };
    await page.getByText("The update could not be installed.", { exact: true }).waitFor();
    await fits("failed");
    await oneLine("failed");
    await shot("3-failed");
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await page.getByRole("dialog", { name: "Settings" }).getByText("bun run build failed: fixture").waitFor();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    const secondInstall = installAnswered();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByText("Starting the update…", { exact: true }).waitFor();
    await secondInstall;
    assert.equal(installs, 2, "Try again asks for the install again");
    // the check an install starts with fails: nothing is available any more, and the line still says so
    status = { ...status, phase: "error", available: false, error: "git fetch failed: fixture" };
    await page.getByText("The update could not be installed.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Details", exact: true }).waitFor();
    // the server refuses an install with nothing available: Try again looks for the release again
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByText("Ovis v9.9.9 is available.", { exact: true }).waitFor();
    assert.deepEqual([checks, installs], [1, 2], "Try again after a failed check asks for a check, not an install");
    status = { ...status, phase: "idle", available: false, error: null };
    await page.getByText("Ovis v9.9.9 is available.", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.locator(".update-notice").count(), 0, "an installed update leaves no line");
    console.log("PASS a release installs from its line with one button and shows its steps");

    // a PC whose bridge cannot be updated: its line closes, and stays closed
    const line = page.getByText("QA PC needs a bridge update to reconnect.", { exact: true });
    const dismissed = () => page.evaluate(() => localStorage.getItem("ovis:pc-notice-dismissed"));
    remote = pc;
    await line.waitFor();
    await fits("bridge update needed");
    await shot("4-bridge-update-needed");
    await page.locator(".update-notice").getByRole("button", { name: "Dismiss", exact: true }).click();
    await line.waitFor({ state: "hidden" });
    assert.equal(await dismissed(), JSON.stringify(["qa-pc:update_bridge"]));
    // a retry that fails brings the PC back to the same state: still closed, also after a reload
    remote = { ...pc, state: "reconnecting", action_required: null };
    await page.reload();
    await page.locator(".conn-live").waitFor();
    remote = pc;
    await page.reload();
    await page.locator(".conn-live").waitFor();
    assert.equal(await line.count(), 0, "the closed line stays closed through a failed retry and a reload");
    assert.equal(await dismissed(), JSON.stringify(["qa-pc:update_bridge"]));
    await shot("5-bridge-line-closed");
    // once the PC has connected, the next time it waits is news again
    remote = { ...pc, state: "connected", action_required: null };
    await page.waitForFunction(() => localStorage.getItem("ovis:pc-notice-dismissed") === null);
    remote = pc;
    await line.waitFor();
    console.log("PASS the line for a PC that needs a bridge update closes and stays closed until the PC connects");

    // a checkout replaced under the server: this tab is that checkout's build, and a reload cannot help
    remote = null;
    await page.reload();
    await page.locator(".conn-live").waitFor();
    // __APP_REVISION__ is replaced when the client is built, from the same checkout and command
    const tabRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(import.meta.dir, ".."), encoding: "utf8" }).trim();
    const restart = "Ovis was updated on this PC. Restart it there to load the update.";
    const howTo = (scope: typeof page | ReturnType<typeof page.locator>) => scope.getByRole("link", { name: "How to restart", exact: true });
    const updated = "App updated. Save unsent drafts before reloading.";
    const reloadButton = page.getByRole("button", { name: "Reload app", exact: true });
    status = { ...status, available: false, latest_revision: null, current_revision: "d".repeat(40), served_revision: tabRevision,
      blocked_reason: "The source checkout changed. Restart the app before updating." };
    await page.reload();
    await page.getByText(restart, { exact: true }).waitFor();
    assert.equal(await reloadButton.count(), 0, "the restart line offers no reload");
    assert.equal(await page.getByText(updated, { exact: true }).count(), 0, "and does not say the app updated");
    assert.match(await howTo(page).getAttribute("href") ?? "", /docs\/guide\.md#updates$/, "the line links to the restart commands");
    await fits("restart");
    await shot("6-restart-line");
    // what the reload button did before: the line is still there
    await page.reload();
    await page.getByText(restart, { exact: true }).waitFor();
    assert.equal(await reloadButton.count(), 0, "a reload leaves the restart line, without a reload button");
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "About");
    const settings = page.locator(".settings-dialog");
    await settings.getByText(restart, { exact: true }).waitFor();
    assert.equal(await settings.getByText(/until it is reloaded/).count(), 0, "Settings does not tell to reload either");
    assert.equal(await settings.getByRole("button", { name: "Reload app", exact: true }).count(), 0, "and has no reload button");
    assert.equal(await settings.getByText(status.blocked_reason!, { exact: true }).count(), 0, "one restart line: the check's own restart reason gives way to it");
    await howTo(settings).waitFor();
    await shot("7-restart-settings");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    // a blocker of its own stays beside the restart line: it still holds installs back after the restart
    const changed = status.blocked_reason;
    const dirty = "The source checkout has local changes. Commit or move them before updating.";
    status = { ...status, blocked_reason: dirty };
    await page.reload();
    await page.getByText(restart, { exact: true }).waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "About");
    await settings.getByText(restart, { exact: true }).waitFor();
    await settings.getByText(dirty, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    status = { ...status, blocked_reason: changed };
    // a pull without a build: the server serves its own build, which a reload does bring
    status = { ...status, served_revision: null };
    await page.reload();
    await page.getByText(updated, { exact: true }).waitFor();
    await reloadButton.waitFor();
    assert.equal(await page.getByText(restart, { exact: true }).count(), 0, "a checkout the tab was not built from keeps the reload line");
    // the server was restarted: it reports the commit the tab was built from, and the line goes
    status = { ...status, current_revision: tabRevision, served_revision: null, blocked_reason: null };
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await page.getByText(updated, { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.getByText(restart, { exact: true }).count(), 0, "a restarted server ends the restart line");
    status = { ...status, current_revision: "d".repeat(40), served_revision: null, available_client_revision: tabRevision };
    for (let reload = 0; reload < 2; reload++) {
      const readStatus = page.waitForResponse(response => new URL(response.url()).pathname === "/api/updates");
      await page.reload();
      await readStatus;
      await page.locator(".conn-live").waitFor();
      await page.keyboard.press("ControlOrMeta+Shift+Comma");
      await openSettingsPage(page, "About");
      assert.ok(status.current_revision);
      await page.getByText(new RegExp(status.current_revision.slice(0, 12))).first().waitFor();
      await page.getByText(updated, { exact: true }).waitFor({ state: "hidden" });
      assert.equal(await reloadButton.count(), 0, "the available browser build cannot reload onto a different one");
      assert.equal(await page.getByText(restart, { exact: true }).count(), 0, "an old browser build does not ask to restart again");
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
    }
    await shot("8-restarted-server-old-build");
    assert.deepEqual(errors, []);
    console.log("PASS a replaced checkout asks for a restart on the line and in Settings, and a reload does not clear it");
  } finally {
    await context.close();
  }
}
