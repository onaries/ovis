/**
 * Its QR code is for a PC that an account was named for: before one is, the tab says to add the PC to the account
 * first and the PC makes no code. It waits for a press, tells the PC what it is for, and is for a PC in no account
 * only: once the PC joins one the PC takes its code back, the QR code leaves, and the tab says to sign in to that
 * account on the device instead. A Portal visitor gets no SSH tab, no switch,
 * no sign-in, no reset, no code and no relay group; a serve-only install shows Blocked with no switch and no
 * reset; a failed start says why; on a tailnet the relay's tab keeps its switch and Phones and devices shows
 * the Tailscale address; a device paired through the relay wears the via relay pill. GET /api/access is pinned
 * per context, and the account service is a route of the context with the sign-in an IndexedDB fixture, so
 * neither what Tailscale does on the PC running this nor account.ovis.sh changes the outcome.
 * All on pages the PC serves: that the hosted shell's Settings has no relay group is checked where the app
 * really runs under the shell, in relay-shell-browser-qa.ts (a page of the PC's own build given the shell's
 * meta boots the shell, not the app). Imported by ui-regression.ts; `startRelayFixture` also serves the
 * manual QA script.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page, Request, Response } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { createServer } from "../server/index.ts";
import { RelayService } from "../server/relay/service.ts";
import { UsageService } from "../server/usage.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import type { PairedDevice, PairingCode, RelayStatus, RemoteAccess } from "../shared/protocol.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { routeDrained } from "./drained-route.ts";
import { openSettingsPage } from "./settings-page.ts";

export interface RelayFixture {
  readonly origin: string;
  readonly relayPort: number;
  readonly stateDir: string;
  pendingCode(): string | null;
  joinAccount(account: string, label: string): Promise<void>;
  stop(): Promise<void>;
}

export function startRelayFixture(options: { serveOnly?: boolean } = {}): RelayFixture {
  const relay = startBunRelay({ port: 0 });
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-panel-"));
  const service = new RelayService({
    stateDir,
    relay: `wss://127.0.0.1:${relay.port}`,
    pairCodeRelay: `wss://127.0.0.1:${relay.port}`,
    connect: (url) => {
      const target = new URL(url);
      return new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    },
  });
  const server = createServer({
    port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false,
    tailscaleServeOnly: options.serveOnly ?? false, relay: service, usage: new UsageService(undefined, []), registerBridge: false,
    // the SSH tab reads a fixture, never the runner's own ssh config or Tailscale
    tailnetPcs: { readStatus: async () => null }, sshCandidates: { sshDir: join(stateDir, "no-ssh"), readStatus: async () => null },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    relayPort: relay.port,
    stateDir,
    pendingCode: () => server.context.services.devices.activePairing()?.code ?? null,
    async joinAccount(account, label) {
      const devices = server.context.services.devices;
      const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const key = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
      const paired = devices.pairRelayApproved(label, key, { path: "code" });
      assert.ok(paired, "the fixture's device was let in");
      assert.ok(devices.linkAccountKey(paired.device.id, key, key, account), "and linked itself to the account");
    },
    async stop() {
      await service.shutdown();
      server.stop();
      await relay.stop();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

const NO_TAILSCALE: RemoteAccess = { port: 0, tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null } };
const TAILNET: RemoteAccess = { port: 0, tailscale: { state: "running", dns_name: "pc.tail0000.ts.net", serving_url: "https://pc.tail0000.ts.net", serve_command: null, serve_url: null } };

const ACCOUNT_SERVICE = "https://account.ovis.sh";

const englishContext = async (browser: Browser, access: RemoteAccess = NO_TAILSCALE, { account = false } = {}): Promise<BrowserContext> => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  await context.route("**/api/access", (route) => route.fulfill({ json: access }));
  if (account) {
    const service = new FakeAccountService();
    service.offerLinkPage(["github", "google"]);
    // added by an init script, not by rewriting the page in a route: Chrome treats a page a route fulfilled as public,
    // and its local-network check then blocks the app's WebSocket to 127.0.0.1.
    await context.addInitScript((service) => document.addEventListener("DOMContentLoaded", () => {
      const meta = document.createElement("meta");
      meta.name = "ovis-pc-account-service";
      meta.content = service;
      document.head.append(meta);
    }), ACCOUNT_SERVICE);
    await context.route(`${ACCOUNT_SERVICE}/**`, async (route) => {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const path = new URL(route.request().url()).pathname;
      if (path === "/v1/pcs") return route.fulfill({ headers: cors, json: { pcs: [] } });
      if (path === "/link") return route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Sign-in fixture</title><p>Sign-in fixture</p><button onclick="fetch(`/approve${location.search}`, {method: \'POST\'})">Approve</button>' });
      if (path === "/approve") {
        const code = new URL(route.request().url()).searchParams.get("code");
        assert.ok(code);
        service.approveOnLinkPage(code, "acct_fixture", "github");
        return route.fulfill({ status: 204 });
      }
      if (!["/v1/providers", "/v1/signin/ovis/device", "/v1/token"].includes(path)) return route.fulfill({ status: 404, headers: cors, json: { error: { code: "not_found" } } });
      const body = route.request().postData();
      const response = await service.fetch(route.request().url(), {
        method: route.request().method(), headers: route.request().headers(), ...(body === null ? {} : { body }),
      });
      return route.fulfill({ status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors }, body: await response.text() });
    });
  }
  return context;
};

const signIn = (page: Page): Promise<void> => page.evaluate((service) => new Promise<void>((resolve, reject) => {
  const request = indexedDB.open("ovis-account", 1);
  request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const tx = request.result.transaction("account", "readwrite");
    tx.objectStore("account").put({ service, account: "fixture", provider: "github", access_token: "fixture-access", refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
    tx.oncomplete = () => { request.result.close(); resolve(); };
    tx.onabort = () => reject(tx.error);
  };
}), ACCOUNT_SERVICE);

export async function openPhoneSettings(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Devices and PCs");
}

function relayUi(page: Page) {
  const dialog = page.locator(".settings-dialog");
  const relayGroup = dialog.locator('[data-section="relay"]');
  const sheet = page.getByRole("dialog", { name: "Add a connection", exact: true });
  const relayTab = sheet.locator('[data-tab-panel="relay"]');
  const devicesTab = sheet.locator('[data-tab-panel="devices"]');
  return {
    dialog,
    connect: dialog.locator('[data-section="devices"]').getByRole("button", { name: "Add a connection", exact: true }),
    relayGroup,
    moreState: relayGroup.locator(".settings-row").first().locator(".settings-description"),
    moreSwitch: relayGroup.getByRole("switch", { name: "Ovis relay", exact: true }),
    moreReset: relayGroup.getByRole("button", { name: "Reset", exact: true }),
    async openMore(): Promise<void> {
      const fold = dialog.locator('.settings-fold[data-fold="more"]');
      if (await fold.getAttribute("open") === null) await fold.locator(":scope > summary").click();
      await relayGroup.waitFor();
    },
    sheet,
    tabs: sheet.locator(".connect-tabs [data-tab]"),
    async openTab(name: "ssh" | "devices" | "relay"): Promise<void> {
      await sheet.locator(`.connect-tabs [data-tab="${name}"]`).click();
      await sheet.locator(`[data-tab-panel="${name}"]`).waitFor();
    },
    relayTab,
    devicesTab,
    toggle: relayTab.getByRole("switch", { name: "Ovis relay", exact: true }),
    /** the switch's tooltip that turning the relay on closes the device gate */
    gateNote: relayTab.locator(".connect-relay-switch[title]"),
    wifiCode: devicesTab.locator(".connect-phone-code .compact-pair-code"),
    async closeSheet(): Promise<void> { await page.keyboard.press("Escape"); await sheet.waitFor({ state: "detached" }); },
  };
}

const isPost = (request: Request, path: string): boolean => request.method() === "POST" && new URL(request.url()).pathname === path;
const answered = (page: Page, path: string): Promise<Response> => page.waitForResponse((response) => isPost(response.request(), path));

const GATE_NOTE = "Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.";
const exactly = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const spaced = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

export async function checkRelayPanel(browser: Browser): Promise<void> {
  const fixtures: RelayFixture[] = [];
  const contexts: BrowserContext[] = [];
  const pageErrors: string[] = [];
  try {
    const fixture = startRelayFixture();
    fixtures.push(fixture);
    const relayState = async (): Promise<RelayStatus> => (await fetch(`${fixture.origin}/api/relay`)).json() as Promise<RelayStatus>;
    const context = await englishContext(browser, NO_TAILSCALE, { account: true });
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(page, fixture.origin);
    const ui = relayUi(page);
    const { dialog, connect, sheet, tabs, relayTab, devicesTab, toggle, gateNote, wifiCode, moreState, moreSwitch } = ui;
    const pairStart = () => answered(page, "/api/devices/pair/start");
    const startedCode = async (answer: Promise<Response>) => {
      const response = await answer;
      assert.equal(response.status(), 200, "the pairing code was started");
      return ((await response.json()) as PairingCode).code;
    };
    await ui.openMore();
    await moreState.filter({ hasText: "Off. Nothing goes through the relay." }).waitFor();
    assert.equal(await dialog.locator('[data-section="phone"]').count(), 0, "no separate phone group");
    assert.equal(await dialog.getByRole("switch", { name: "Ovis relay", exact: true }).count(), 1, "the settings page's one relay switch is in More settings");
    assert.equal(await moreSwitch.getAttribute("aria-checked"), "false", "the relay starts off");
    assert.equal(await dialog.getByRole("img").count(), 0, "the settings page itself shows no QR code");
    assert.equal((await relayState()).phase, "off");
    await dialog.locator('.settings-fold[data-fold="more"] > summary').click();

    await connect.click();
    await sheet.locator('[data-tab-panel="ssh"]').waitFor();
    assert.equal(await sheet.getByRole("group", { name: "How to connect", exact: true }).count(), 1, "the tabs are one labelled group");
    assert.deepEqual(await tabs.evaluateAll((buttons) => buttons.map((button) => [button.getAttribute("data-tab"), button.textContent, button.getAttribute("aria-pressed")])),
      [["ssh", "SSH", "true"], ["devices", "Phones and devices", "false"], ["relay", "Ovis relay", "false"]], "an owner's PC window gets SSH, Phones and devices and Ovis relay, opened on SSH");
    assert.equal(await sheet.locator(".connect-other, .connect-way, .connect-way-body, .connect-phone-relay, .tailnet-pcs").count(), 0, "no other ways fold, no ways list, no relay pairing QR code and no tailnet PCs");
    assert.equal(await sheet.getByRole("img", { name: "QR code that pairs a phone through the relay", exact: true }).count(), 0, "the sheet offers no relay pairing QR code");
    assert.equal((await relayState()).phase, "off", "opening the sheet turns nothing on");

    await ui.openTab("relay");
    const signInButton = relayTab.getByTestId("connect-signin").getByRole("button", { name: "Sign in to Ovis", exact: true });
    await signInButton.waitFor();
    const accountQr = relayTab.getByTestId("connect-account-qr");
    assert.equal(await relayTab.getByRole("switch").count(), 1, "signed out, the relay's tab has one switch");
    assert.equal(await accountQr.getByRole("switch", { name: "Ovis relay", exact: true }).count(), 1, "and it is the QR code's");
    assert.equal(await accountQr.getByRole("button", { name: "Show the QR code", exact: true }).count(), 0, "a relay that is off shows no QR code");
    const beforeSignIn = page.url();
    const opened = context.waitForEvent("page");
    await signInButton.click();
    const linkPage = await opened;
    await linkPage.waitForURL(`${ACCOUNT_SERVICE}/link?code=*`);
    await linkPage.getByText("Sign-in fixture", { exact: true }).waitFor();
    const waiting = relayTab.getByTestId("relay-signin-waiting");
    await waiting.waitFor();
    assert.equal(linkPage.url(), `${ACCOUNT_SERVICE}/link?code=${await waiting.locator("output").textContent()}`, "the new tab carries the sheet's code to the account service");
    assert.equal(await linkPage.evaluate(() => window.opener), null, "the account page has no opener");
    assert.equal(await sheet.isVisible(), true, "sign-in keeps Add a connection open");
    assert.equal(page.url(), beforeSignIn, "sign-in does not navigate the PC's page");
    assert.equal(await dialog.locator('.settings-fold[data-fold="more"]').getAttribute("open"), null, "sign-in leaves the Settings account group closed");
    await waiting.getByRole("button", { name: "Cancel", exact: true }).click();
    await linkPage.close();

    const approvalPage = context.waitForEvent("page");
    await signInButton.click();
    const approving = await approvalPage;
    await approving.waitForURL(`${ACCOUNT_SERVICE}/link?code=*`);
    await waiting.locator("a").focus();
    await approving.getByRole("button", { name: "Approve", exact: true }).click();
    await relayTab.getByRole("button", { name: "Open the account", exact: true }).waitFor();
    assert.equal(await sheet.evaluate((node) => node.contains(document.activeElement)), true, "approval keeps keyboard focus inside the sheet");
    assert.equal(await toggle.evaluate((node) => node === document.activeElement), true, "approval focuses the signed-in view's first control");
    await approving.close();

    await signIn(page);
    await openPhoneSettings(page, fixture.origin);
    await connect.click();
    await ui.openTab("relay");
    await toggle.waitFor();
    assert.equal(await sheet.getByRole("switch").count(), 1, "the sheet carries the relay's switch once");
    assert.equal(await toggle.getAttribute("aria-checked"), "false", "the sheet's switch shows the relay off");
    assert.equal(await sheet.getByRole("button", { name: "Turn on the relay", exact: true }).count(), 0, "one way to turn it on: the switch");
    assert.equal(await sheet.getByRole("button", { name: "Sign in to Ovis", exact: true }).count(), 0, "signed in, no sign-in");
    await relayTab.getByRole("button", { name: "Open the account", exact: true }).waitFor();
    assert.equal(await sheet.getByTestId("relay-owner-help").count(), 0, "the direct owner needs no relay restriction explanation");
    assert.equal(await gateNote.getAttribute("title"), GATE_NOTE, "with no token and nothing paired, the switch's tooltip says turning the relay on closes the gate");
    assert.equal(await relayTab.getByText(GATE_NOTE, { exact: true }).count(), 0, "and the sheet carries no warning paragraph for it");
    assert.equal(await page.getByText("A paired device gets in on its own until you revoke it here.").count(), 1, "the paired-device line is said once, in Devices");
    assert.equal(await sheet.getByRole("button", { name: /^Reset/ }).count(), 0, "the identity reset is in More settings, not in the sheet");

    await toggle.click();
    await moreState.filter({ hasText: "Online. No phone connected." }).waitFor({ state: "attached" });
    assert.equal((await relayState()).phase, "online", "the server's relay link is online");
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "the sheet's switch shows the relay on");
    await gateNote.waitFor({ state: "detached" });
    assert.equal(await sheet.getByRole("img", { name: "QR code that pairs a phone through the relay", exact: true }).count(), 0, "online, the sheet still offers no relay pairing QR code");

    const relayQr = sheet.getByRole("img", { name: "QR code that pairs a phone through the relay", exact: true });
    const showQr = accountQr.getByRole("button", { name: "Show the QR code", exact: true });
    await accountQr.getByText("Add this PC to your account first; then it can show its QR code.", { exact: true }).waitFor();
    assert.equal(await showQr.count(), 0, "a PC that no account was named for offers no QR code");
    const unnamed = await page.evaluate(async () => {
      const response = await fetch("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-no-account-only": "1" } });
      return [response.status, ((await response.json()) as { error: { code: string } }).error.code];
    });
    assert.deepEqual(unnamed, [409, "no_account_named"], "and the PC makes no code for it");
    assert.equal(fixture.pendingCode(), null, "no code is pending on the PC");
    const named = await fetch(`${fixture.origin}/api/account/relay-account`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-herdr-machine": "1", origin: fixture.origin },
      body: JSON.stringify({ account: "fixture" }),
    });
    assert.equal(named.status, 204, "the account is named for the PC");
    // the page reads the relay's state as Settings opens
    await openPhoneSettings(page, fixture.origin);
    await connect.click();
    await ui.openTab("relay");

    // the QR code waits for its press, and comes down with its code when another tab opens
    await showQr.waitFor();
    assert.equal(await accountQr.getByRole("switch").count(), 0, "signed in, the QR code's part repeats no switch");
    const offered = answered(page, "/api/relay/offer");
    await showQr.click();
    assert.equal((await offered).status(), 200, "the press asks for the offer");
    assert.equal((await offered).request().headers()["x-ovis-no-account-only"], "1", "and says it is for a PC in no account, so the PC makes none once it is in one");
    await relayQr.waitFor();
    assert.equal(await sheet.isVisible(), true, "the sheet stays open under its QR code");
    // the QR code alone: no code to type that could be read off the screen and typed on another device
    assert.equal(await accountQr.getByLabel("Code to type", { exact: true }).count(), 0, "the account QR code shows no code to type");
    // the QR code's code is redeemed through the relay only: sent to this PC's own address it pairs nobody, and the
    // QR code stays up with its code
    const qrCode = decodeOffer(((await (await offered).json()) as { url: string }).url)?.code;
    const scanned = await fetch(`${fixture.origin}/api/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-herdr-machine": "1", origin: fixture.origin },
      body: JSON.stringify({ code: qrCode, label: "Scanner" }),
    });
    assert.equal(scanned.status, 401, "the QR code's code pairs nobody at this PC's own address");
    assert.equal(fixture.pendingCode(), qrCode, "and it stays the code pending on the PC");
    assert.equal(await relayQr.count(), 1, "the QR code stays up");
    assert.equal(await sheet.isVisible(), true, "and the sheet stays open");
    const codeEnded = answered(page, "/api/devices/pair/cancel");
    await ui.openTab("ssh");
    assert.equal((await codeEnded).status(), 200, "another tab ends the QR code's pairing code");
    await ui.openTab("relay");
    await accountQr.getByRole("button", { name: "Show a new code", exact: true }).waitFor();
    assert.equal(await relayQr.count(), 0, "the QR code is down until it is asked for again");

    // the PC joins an account while its QR code is up, by a sign-in on the PC and an approval and not by a scan: the
    // PC takes the QR code's code back, the QR code leaves, and the tab says which account. A PC that is in an
    // account gets no QR code: the tab says to sign in to that account on the device instead
    const offeredLast = answered(page, "/api/relay/offer");
    await accountQr.getByRole("button", { name: "Show a new code", exact: true }).click();
    const lastCode = decodeOffer(((await (await offeredLast).json()) as { url: string }).url)?.code;
    await relayQr.waitFor();
    assert.equal(fixture.pendingCode(), lastCode, "the QR code's code is the one pending on the PC");
    await fixture.joinAccount("fixture", "Owner's phone");
    assert.equal(fixture.pendingCode(), null, "the PC took the QR code's code back as it joined the account");
    const joined = accountQr.getByTestId("connect-account-joined");
    await joined.getByText("This PC is in your account (fixture).", { exact: true }).waitFor();
    await joined.getByText("Added by Owner's phone.", { exact: true }).waitFor();
    assert.equal(await relayQr.count(), 0, "the QR code left as the PC joined an account");
    assert.equal(await sheet.isVisible(), true, "the sheet stays open to say which account the PC joined");
    assert.deepEqual(await joined.getByRole("button").allInnerTexts(), ["Done", "Not me: revoke every device"], "the account is this browser's own: Done, then Not me");
    await joined.getByRole("button", { name: "Done", exact: true }).click();
    await accountQr.getByText("This PC is in your Ovis account (fixture).", { exact: true }).waitFor();
    await accountQr.getByText("To add a device, sign in to this PC's account on it and open this PC there. A device this PC does not know yet is approved once, by picking the matching number on a device that is already a member of this PC.", { exact: true }).waitFor();
    await accountQr.getByText("This PC shows a QR code only while it is in no account.", { exact: true }).waitFor();
    assert.equal(await accountQr.getAttribute("data-account"), "mine", "the part says the PC is in this browser's account");
    assert.equal(await accountQr.getByRole("button").count(), 0, "a PC that is in an account offers no QR code");
    assert.equal(await relayTab.getByRole("button", { name: "Open the account", exact: true }).count(), 0, "and nothing says to add this PC to the account any more");
    assert.equal(await accountQr.evaluate((node) => node.contains(document.activeElement)), true, "the answered notice hands the focus to what the part says now");
    // the PC itself makes no such code any more, whatever page asks for it
    const refused = await page.evaluate(async () => {
      const response = await fetch("/api/relay/offer", { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-no-account-only": "1" } });
      return [response.status, ((await response.json()) as { error: { code: string } }).error.code];
    });
    assert.deepEqual(refused, [409, "in_account"], "the PC refuses the QR code's code once it is in an account");
    assert.equal(fixture.pendingCode(), null, "and makes none");
    await ui.closeSheet();
    const askedAgain: string[] = [];
    const noteOffer = (request: Request): void => { if (isPost(request, "/api/relay/offer") || isPost(request, "/api/relay/code")) askedAgain.push(new URL(request.url()).pathname); };
    page.on("request", noteOffer);
    await connect.click();
    await ui.openTab("relay");
    await accountQr.getByText("This PC is in your Ovis account (fixture).", { exact: true }).waitFor();
    assert.equal(await accountQr.getByRole("button").count(), 0, "opened again, a PC in an account still offers no QR code");
    assert.equal(await relayQr.count(), 0, "and shows none");
    assert.equal(await relayTab.getByRole("switch").count(), 0, "online and in the account, the tab has nothing to switch");
    page.off("request", noteOffer);
    assert.deepEqual(askedAgain, [], "the tab asked the PC for no code");

    const codeStart = pairStart();
    await ui.openTab("devices");
    const codeStarted = await startedCode(codeStart);
    await wifiCode.filter({ hasText: exactly(spaced(codeStarted)) }).waitFor();
    await devicesTab.evaluate((panel) => { (panel as HTMLElement & { kept?: boolean }).kept = true; });
    await ui.openTab("relay");
    assert.equal(await devicesTab.isHidden(), true, "another tab hides Phones and devices");
    await ui.openTab("devices");
    assert.equal(await devicesTab.evaluate((panel) => (panel as HTMLElement & { kept?: boolean }).kept === true), true, "Phones and devices is kept while the sheet is open, not mounted again");
    assert.equal(await wifiCode.innerText(), spaced(codeStarted), "back on Phones and devices, its code is the same");
    await ui.closeSheet();

    const thisPcId = dialog.getByTestId("this-pc").locator(".my-device-id");
    await thisPcId.waitFor();
    const idBefore = await thisPcId.innerText();
    const confirm = page.getByRole("alertdialog", { name: "Reset the relay identity?", exact: true });
    await ui.moreReset.click();
    await confirm.getByText("Phones paired through the relay will need to scan a new code.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await confirm.waitFor({ state: "detached" });
    assert.equal(await dialog.isVisible(), true, "Escape on the confirmation closes it, not Settings under it");
    await ui.moreReset.click();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    assert.equal(await thisPcId.innerText(), idBefore, "Escape and Cancel keep the relay identity");
    await ui.moreReset.click();
    await confirm.getByRole("button", { name: "Reset", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    await moreState.filter({ hasText: "Online. No phone connected." }).waitFor();
    await thisPcId.filter({ hasNotText: idBefore }).waitFor();

    await openPhoneSettings(page, fixture.origin);
    await moreState.filter({ hasText: "Online. No phone connected." }).waitFor({ state: "attached" });
    await connect.click();
    const pageStart = pairStart();
    await ui.openTab("devices");
    const pageCode = await startedCode(pageStart);
    await wifiCode.filter({ hasText: exactly(spaced(pageCode)) }).waitFor();
    const phonePaired = await fetch(`${fixture.origin}/api/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-herdr-machine": "1", origin: fixture.origin },
      body: JSON.stringify({ code: pageCode, label: "Wi-Fi phone" }),
    });
    assert.equal(phonePaired.status, 204, "the phone paired with the sheet's code");
    await sheet.waitFor({ state: "detached" });
    await dialog.locator('[data-section="devices"]').getByText("Paired: Wi-Fi phone.", { exact: true }).waitFor();

    // Even a Portal visitor with a saved drive role cannot control the relay (owner_only).
    const visitorContext = await englishContext(browser);
    contexts.push(visitorContext);
    const visitor = await visitorContext.newPage();
    const drainVisitorHealth = await routeDrained(visitor, "**/api/health*", async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { auth: Record<string, unknown> };
      await route.fulfill({ response, json: { ...body, auth: { ...body.auth, via: "portal", role: "drive" } } });
    });
    // a drain that fails too must not hide what the checks found: both errors are reported then
    let failure: { error: unknown } | undefined;
    try {
      const visitorMutations: string[] = [];
      await visitor.route("**/api/relay/**", (route) => {
        if (route.request().method() !== "POST") return route.continue();
        visitorMutations.push(new URL(route.request().url()).pathname);
        return route.fulfill({ status: 403, json: { error: { code: "owner_only", message: "Use the access token or a paired device." } } });
      });
      await openPhoneSettings(visitor, fixture.origin);
      const seen = relayUi(visitor);
      // the visitor's sheet holds only what it can use: Phones and devices, with no pairing code, no SSH and no relay
      // tab; More settings has no relay group for it
      await seen.connect.click();
      await seen.devicesTab.getByText("Open Ovis on the PC itself to add a connection.", { exact: true }).waitFor();
      assert.equal(await seen.sheet.locator(".connect-tabs").count(), 0, "a Portal visitor gets one way, so no tabs");
      assert.equal(await seen.relayTab.count(), 0, "nor the relay's tab");
      assert.equal(await seen.sheet.locator(".connect-phone-code").count(), 0, "a Portal visitor is offered no pairing code");
      assert.equal(await seen.sheet.locator(".compact-pair").count(), 0, "nor a code to type");
      assert.equal(await seen.sheet.getByRole("switch").count(), 0, "a Portal visitor gets no relay switch");
      assert.equal(await seen.sheet.getByRole("button", { name: "Sign in to Ovis", exact: true }).count(), 0, "nor the sign-in");
      assert.equal(await seen.sheet.getByRole("img").count(), 0, "a Portal visitor is shown no pairing offer");
      assert.equal(await seen.relayGroup.count(), 0, "a Portal visitor's More settings has no relay group");
      assert.deepEqual(visitorMutations, [], "a Portal visitor never requests an owner-only relay mutation");
    } catch (error) {
      failure = { error };
    }
    try {
      await drainVisitorHealth();
    } catch (drainError) {
      if (failure === undefined) throw drainError;
      throw new AggregateError([failure.error, drainError], "the Portal visitor's checks failed, and so did draining its health route");
    }
    if (failure !== undefined) throw failure.error;
    await visitorContext.close();

    await ui.openMore();
    await moreSwitch.click();
    await moreState.filter({ hasText: "Off." }).waitFor();
    assert.equal(await moreSwitch.getAttribute("aria-checked"), "false", "the switch shows the relay off");
    assert.equal((await relayState()).phase, "off", "the server's relay link is off");
    await connect.click();
    await ui.openTab("relay");
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false", "the sheet's switch is back, off");
    await ui.closeSheet();

    const tailnetFixture = startRelayFixture();
    fixtures.push(tailnetFixture);
    const tailnetRelay = async (): Promise<RelayStatus> => (await fetch(`${tailnetFixture.origin}/api/relay`)).json() as Promise<RelayStatus>;
    const tailnetContext = await englishContext(browser, TAILNET, { account: true });
    contexts.push(tailnetContext);
    const tailnet = await tailnetContext.newPage();
    tailnet.setDefaultTimeout(15_000);
    tailnet.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(tailnet, tailnetFixture.origin);
    await signIn(tailnet);
    await openPhoneSettings(tailnet, tailnetFixture.origin);
    const net = relayUi(tailnet);
    await net.moreState.filter({ hasText: "Off." }).waitFor({ state: "attached" });
    await net.connect.click();
    await net.openTab("relay");
    await net.toggle.waitFor();
    assert.equal(await net.toggle.getAttribute("aria-checked"), "false", "the relay's tab keeps its switch, off");
    assert.equal(await net.gateNote.getAttribute("title"), GATE_NOTE, "the switch keeps the gate note as its tooltip");
    await net.openTab("devices");
    await net.devicesTab.getByText("https://pc.tail0000.ts.net").first().waitFor();
    assert.equal((await tailnetRelay()).phase, "off", "opening the sheet turns nothing on");
    await net.openTab("relay");
    await net.toggle.click();
    await net.moreState.filter({ hasText: "Online." }).waitFor({ state: "attached" });
    assert.equal((await tailnetRelay()).phase, "online", "the sheet's switch turned the server's relay on");
    await net.closeSheet();
    await tailnetContext.close();

    const paired: PairedDevice = { id: "0123456789abcdef", label: "Pixel 9", role: "drive", created_at: new Date().toISOString(), last_seen_at: null, current: false, via_relay: true,
      connection: { route: "relay", relay: "wss://relay-ap.ovis.sh", rtt_ms: 148, since: new Date().toISOString() } };
    const away: PairedDevice = { id: "0123456789abcdee", label: "iPad", role: "drive", created_at: paired.created_at, last_seen_at: null, current: false, via_relay: true };
    await page.route("**/api/devices", (route) => route.request().method() === "GET" ? route.fulfill({ json: { devices: [paired, away] } }) : route.continue());
    await openPhoneSettings(page, fixture.origin);
    const row = page.locator(".devices-panel .devices-row").filter({ hasText: "Pixel 9" });
    await row.locator("[data-connection='connected']", { hasText: "Connected · Seoul relay · 148 ms" }).waitFor();
    await row.locator(".connection-slow", { hasText: "148 ms" }).waitFor();
    await page.locator(".devices-panel .devices-row").filter({ hasText: "iPad" }).locator("[data-connection='offline']", { hasText: "The app is closed, or its network is off." }).waitFor();

    const inUse: PairedDevice = { id: "0123456789abcded", label: "Chrome · Desk", role: "drive", created_at: paired.created_at, last_seen_at: new Date().toISOString(), current: true };
    await page.unroute("**/api/devices");
    await page.route("**/api/devices", (route) => route.request().method() === "GET" ? route.fulfill({ json: { devices: [paired, away, inUse] } }) : route.continue());
    await openPhoneSettings(page, fixture.origin);
    const devicesGroup = dialog.locator('[data-section="devices"]');
    assert.equal(await devicesGroup.getByText("Connected to this PC", { exact: true }).count(), 0, "the list carries no group title");
    const deviceRows = devicesGroup.locator(".devices-panel .devices-row");
    await deviceRows.first().filter({ hasText: "Chrome · Desk" }).locator(".devices-current", { hasText: "This device now" }).waitFor();
    assert.deepEqual(await deviceRows.locator(".settings-label").evaluateAll((labels) => labels.map((label) => label.firstChild?.textContent)), ["Chrome · Desk", "Pixel 9", "iPad"], "the device in use leads the one list");
    assert.equal(await devicesGroup.getByTestId("this-pc").count(), 1, "the PC's own name heads the list");
    const addConnection = devicesGroup.getByRole("button", { name: "Add a connection", exact: true });
    assert.ok((await addConnection.boundingBox())!.y > (await deviceRows.last().boundingBox())!.y, "Add a connection follows the list");
    assert.equal(await devicesGroup.getByText("Revoke every device", { exact: true }).count(), 0, "revoking every device is not on the page itself");
    assert.equal(await devicesGroup.locator("details.settings-details").count(), 0, "no explanation folds above the list");
    const more = dialog.locator('.settings-fold[data-fold="more"]');
    assert.equal(await more.getByText("Revoke every device", { exact: true }).count(), 1, "revoking every device is in More settings");
    const accountGroup = dialog.locator('[data-section="account"]');
    assert.equal(await accountGroup.count(), 1, "the Account group is drawn");
    assert.equal(await accountGroup.evaluate((group) => group.closest("details") === null), true, "the account is on the page itself, not folded into More settings");
    await page.unroute("**/api/devices");

    // serve-only: no switch anywhere, the reason in More settings, and no reset
    const serveOnly = startRelayFixture({ serveOnly: true });
    fixtures.push(serveOnly);
    const blockedContext = await englishContext(browser, NO_TAILSCALE, { account: true });
    contexts.push(blockedContext);
    const blockedPage = await blockedContext.newPage();
    blockedPage.setDefaultTimeout(15_000);
    blockedPage.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(blockedPage, serveOnly.origin);
    await signIn(blockedPage);
    await openPhoneSettings(blockedPage, serveOnly.origin);
    const blocked = relayUi(blockedPage);
    await blocked.openMore();
    await blocked.moreState.filter({ hasText: "Blocked: OVIS_TAILSCALE_SERVE_ONLY" }).waitFor();
    assert.equal(await blocked.moreSwitch.count(), 0, "a serve-only install shows no relay switch in More settings");
    assert.equal(await blocked.relayGroup.getByText("Reset relay identity", { exact: true }).count(), 0, "a serve-only install is offered no reset, which it would refuse");
    await blocked.connect.click();
    await blocked.openTab("relay");
    await blocked.relayTab.getByTestId("connect-signin").waitFor();
    assert.equal(await blocked.relayTab.getByText("Turn on the relay, then add this PC to your account.", { exact: true }).count(), 0, "a relay that cannot be turned on is not asked to be (More settings says why)");
    assert.equal(await blocked.sheet.getByRole("switch").count(), 0, "nor in the sheet");
    assert.equal(await blocked.relayTab.getByRole("img").count(), 0, "no offer on a blocked install");
    assert.equal(await blocked.sheet.getByRole("button", { name: /^Reset/ }).count(), 0, "nor a reset in the sheet");
    assert.equal(await blocked.gateNote.count(), 0, "a relay that cannot be turned on carries no note about turning it on");

    const unwritable = startRelayFixture();
    fixtures.push(unwritable);
    const savedChoice = join(unwritable.stateDir, "relay", "state.json");
    mkdirSync(savedChoice, { recursive: true });
    const failedContext = await englishContext(browser, NO_TAILSCALE, { account: true });
    contexts.push(failedContext);
    const failedPage = await failedContext.newPage();
    failedPage.setDefaultTimeout(15_000);
    failedPage.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(failedPage, unwritable.origin);
    await signIn(failedPage);
    await openPhoneSettings(failedPage, unwritable.origin);
    const failed = relayUi(failedPage);
    await failed.connect.click();
    await failed.openTab("relay");
    await failed.toggle.click();
    await failed.relayTab.getByRole("alert").filter({ hasText: "Could not start the relay." }).waitFor();
    assert.equal(await failed.toggle.getAttribute("aria-checked"), "false", "a start that failed leaves the switch off");
    rmSync(savedChoice, { recursive: true });
    await failed.toggle.click();
    await failed.moreState.filter({ hasText: "Online." }).waitFor({ state: "attached" });
    assert.equal((await (await fetch(`${unwritable.origin}/api/relay`)).json() as RelayStatus).phase, "online", "the switch turned the relay on once the cause was gone");
    assert.equal(await failed.relayTab.getByRole("alert").count(), 0, "no failure once it runs");
    assert.deepEqual(pageErrors, [], "the relay panel raises no page error");
    console.log("PASS Add a connection's tabs: SSH, Phones and devices (a kept pairing code that closes the sheet once used) and Ovis relay (the sign-in, then the switch); the relay turns off from More settings and resets the identity; a Portal visitor and a serve-only install get no switch; a relay-paired device says how it reaches the PC now, or that it is offline");
  } finally {
    for (const context of contexts) await context.close();
    for (const fixture of fixtures) await fixture.stop();
  }
}
