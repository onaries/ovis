/**
 * Settings → Devices and PCs: the Ovis relay against a local Bun relay (relay/bun.ts). The page's one relay
 * switch is in More settings → Ovis relay, whose row says the relay's state and which holds Reset relay
 * identity; the Connect a device dialog carries a switch of its own while the relay is off (with the gate note),
 * and says the state while it is not online. Online, the dialog shows the QR code of a fresh offer beside a code
 * to type, with Refresh and Copy: Refresh mints another code to type, and the offer asked for after it carries
 * the six-digit code that mint started. Same Wi-Fi under Other ways to connect starts a six-digit code, which
 * refreshes the offer with that code and ends the code to type, and a relay Refresh moves Same Wi-Fi's code
 * along with the offer (the server keeps one pending code). Reset relay identity asks first (Escape closes only
 * the confirmation) and gives the PC a new server id. A phone pairing with the offer's code closes the dialog.
 * A Portal visitor gets no switch, no reset, no code and no relay group; a failed start says why with Try again;
 * a serve-only install shows Blocked with no switch and no reset; on a tailnet the relay's switch still leads
 * and Tailscale waits under Other ways; a device paired through the relay wears the via relay pill. GET
 * /api/access is pinned per context, so what Tailscale does on the PC running this never changes the outcome.
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
import type { PairedDevice, PairingCode, RelayStatus, RemoteAccess } from "../shared/protocol.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { openSettingsPage } from "./settings-page.ts";

export interface RelayFixture {
  readonly origin: string;
  readonly relayPort: number;
  readonly stateDir: string;
  stop(): Promise<void>;
}

/** An Ovis server whose relay link reaches a local Bun relay: the advertised wss origin is dialled as the relay's plain ws port. */
export function startRelayFixture(options: { serveOnly?: boolean } = {}): RelayFixture {
  const relay = startBunRelay({ port: 0 });
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-panel-"));
  const service = new RelayService({
    stateDir,
    relay: `wss://127.0.0.1:${relay.port}`,
    // the code to type is held in a pairing room of the same local relay
    pairCodeRelay: `wss://127.0.0.1:${relay.port}`,
    connect: (url) => {
      const target = new URL(url);
      return new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    },
  });
  const server = createServer({
    port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false,
    tailscaleServeOnly: options.serveOnly ?? false, relay: service, usage: new UsageService(undefined, []), registerBridge: false,
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    relayPort: relay.port,
    stateDir,
    async stop() {
      await service.shutdown();
      server.stop();
      await relay.stop();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** What GET /api/access answers in a context: Tailscale missing (the relay's case), or serving the PC on a tailnet. */
const NO_TAILSCALE: RemoteAccess = { port: 0, tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null } };
const TAILNET: RemoteAccess = { port: 0, tailscale: { state: "running", dns_name: "pc.tail0000.ts.net", serving_url: "https://pc.tail0000.ts.net", serve_command: null, serve_url: null } };

const englishContext = async (browser: Browser, access: RemoteAccess = NO_TAILSCALE): Promise<BrowserContext> => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  await context.route("**/api/access", (route) => route.fulfill({ json: access }));
  return context;
};

/** The page open on Settings → Devices and PCs. */
export async function openPhoneSettings(page: Page, origin: string): Promise<void> {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Devices and PCs");
}

/** The relay's places on a page: More settings → Ovis relay, and the Connect a device dialog. */
function relayUi(page: Page) {
  const dialog = page.locator(".settings-dialog");
  const relayGroup = dialog.locator('[data-section="relay"]');
  const sheet = page.getByRole("dialog", { name: "Connect a device", exact: true });
  const relayRoute = sheet.locator(".connect-phone-relay");
  return {
    dialog,
    connect: dialog.locator('[data-section="devices"]').getByRole("button", { name: "Connect", exact: true }),
    relayGroup,
    // the Ovis relay row's description is the relay's state; read as text, so with More settings folded too
    moreState: relayGroup.locator(".settings-row").first().locator(".settings-description"),
    moreSwitch: relayGroup.getByRole("switch", { name: "Ovis relay", exact: true }),
    moreReset: relayGroup.getByRole("button", { name: "Reset", exact: true }),
    /** More settings, unfolded */
    async openMore(): Promise<void> {
      const fold = dialog.locator('.settings-fold[data-fold="more"]');
      if (await fold.getAttribute("open") === null) await fold.locator(":scope > summary").click();
      await relayGroup.waitFor();
    },
    sheet,
    relayRoute,
    sheetState: relayRoute.locator(".relay-status"),
    toggle: sheet.getByRole("switch", { name: "Ovis relay", exact: true }),
    qr: relayRoute.getByRole("img", { name: "QR code that pairs a phone through the relay", exact: true }),
    typed: relayRoute.locator(".compact-pair-code"),
    refresh: relayRoute.getByRole("button", { name: "Refresh", exact: true }),
    async closeSheet(): Promise<void> { await page.keyboard.press("Escape"); await sheet.waitFor({ state: "detached" }); },
  };
}

const isPost = (request: Request, path: string): boolean => request.method() === "POST" && new URL(request.url()).pathname === path;
const answered = (page: Page, path: string): Promise<Response> => page.waitForResponse((response) => isPost(response.request(), path));

/**
 * The relay offer the dialog asks for once a code to type is minted (Connect a device's Refresh, or its opening):
 * that mint started a six-digit code, which this offer carries. Armed before the action: an offer requested after
 * the mint's answer arrived, as the page's events come in order.
 */
function offerAfterMint(page: Page): Promise<Response> {
  let minted = false;
  const after = new Set<Request>();
  const onResponse = (response: Response) => { if (isPost(response.request(), "/api/relay/code")) minted = true; };
  const onRequest = (request: Request) => { if (minted && isPost(request, "/api/relay/offer")) after.add(request); };
  page.on("response", onResponse);
  page.on("request", onRequest);
  return page.waitForResponse((response) => after.has(response.request())).finally(() => {
    page.off("response", onResponse);
    page.off("request", onRequest);
  });
}

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
    const context = await englishContext(browser);
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(page, fixture.origin);
    const ui = relayUi(page);
    const { dialog, connect, sheet, relayRoute, sheetState, toggle, qr, typed, refresh, moreState, moreSwitch } = ui;
    const offerAnswer = () => answered(page, "/api/relay/offer");
    const pairStart = () => answered(page, "/api/devices/pair/start");
    const offerCode = async (answer: Promise<Response>) => {
      const offer = decodeOffer(((await (await answer).json()) as { url: string }).url);
      assert.ok(offer !== null && offer.code !== undefined, "the offer carries a pairing code");
      assert.match(offer.code, /^\d{6}$/, "the offer's code is a six-digit pairing code");
      return offer.code;
    };
    const startedCode = async (answer: Promise<Response>) => {
      const response = await answer;
      assert.equal(response.status(), 200, "the pairing code was started");
      return ((await response.json()) as PairingCode).code;
    };
    const mintedCode = async (answer: Promise<Response>) => {
      const response = await answer;
      assert.equal(response.status(), 200, "the code to type was minted");
      return ((await response.json()) as { code: string }).code;
    };
    // the relay's state and switch are in More settings; the old Phone group is gone
    await ui.openMore();
    await moreState.filter({ hasText: "Off. Nothing goes through the relay." }).waitFor();
    assert.equal(await dialog.locator('[data-section="phone"]').count(), 0, "no separate phone group");
    assert.equal(await dialog.getByRole("switch", { name: "Ovis relay", exact: true }).count(), 1, "the settings page's one relay switch is in More settings");
    assert.equal(await moreSwitch.getAttribute("aria-checked"), "false", "the relay starts off");
    assert.equal(await dialog.getByRole("img").count(), 0, "the settings page itself shows no QR code");
    assert.equal((await relayState()).phase, "off");
    // off, the dialog says so and carries the relay's switch
    await connect.click();
    await sheetState.filter({ hasText: "Off. Nothing goes through the relay." }).waitFor();
    assert.equal(await sheet.getByRole("switch").count(), 1, "the dialog carries the relay's switch once");
    assert.equal(await toggle.getAttribute("aria-checked"), "false", "the dialog's switch shows the relay off");
    assert.equal(await sheet.getByRole("button", { name: "Turn on the relay", exact: true }).count(), 0, "one way to turn it on: the switch");
    assert.equal(await sheet.getByTestId("relay-owner-help").count(), 0, "the direct owner needs no relay restriction explanation");
    const closesGate = sheet.getByText("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.", { exact: true });
    assert.equal(await closesGate.isVisible(), true, "with no token and nothing paired, the switch says turning the relay on closes the gate");
    assert.equal(await page.getByText("A paired device gets in on its own until you revoke it here.").count(), 1, "the paired-device line is said once, in Devices");
    assert.equal(await qr.count(), 0, "no offer while the relay is off");
    assert.equal(await sheet.getByRole("button", { name: /^Reset/ }).count(), 0, "the identity reset is in More settings, not in the dialog");

    // on: the server connects to the local relay, the QR code and a code to type come by themselves, and the state line goes
    const firstMint = answered(page, "/api/relay/code");
    const firstOffer = offerAfterMint(page);
    await toggle.click();
    await qr.waitFor();
    assert.equal((await relayState()).phase, "online", "the server's relay link is online");
    assert.equal(await toggle.count(), 0, "on, the dialog's switch goes: More settings turns it off");
    assert.equal(await sheetState.count(), 0, "online, the dialog shows the codes instead of the state");
    await closesGate.waitFor({ state: "detached" });
    const firstTyped = await mintedCode(firstMint);
    await typed.filter({ hasText: exactly(firstTyped) }).waitFor();
    const offeredUrl = ((await (await firstOffer).json()) as { url: string }).url;
    const offered = decodeOffer(offeredUrl);
    assert.ok(offered !== null, "the QR code is a pairing offer");
    assert.equal(offered.relay, `wss://127.0.0.1:${fixture.relayPort}`, "the offer names the relay the server uses");
    assert.match(offered.code ?? "", /^\d{6}$/, "the offer carries a one-time pairing code");
    await moreState.filter({ hasText: "Online. No phone connected." }).waitFor({ state: "attached" });

    // Refresh: a new code to type, then an offer carrying the six-digit code that mint started. Codes are random,
    // so two of them are never asserted different: each is matched to what the server just answered
    const refreshMint = answered(page, "/api/relay/code");
    const refreshOffer = offerAfterMint(page);
    await refresh.click();
    const refreshedTyped = await mintedCode(refreshMint);
    await typed.filter({ hasText: exactly(refreshedTyped) }).waitFor();
    await offerCode(refreshOffer);

    // Same Wi-Fi starts a six-digit code: the relay asks for its offer again, which carries that very code, and the
    // code to type, ended on the PC by it, goes
    const wifiCode = sheet.locator(".connect-way-body .connect-phone-code .compact-pair-code");
    await sheet.locator("details.connect-other > summary").click();
    const codeStart = pairStart();
    const resynced = offerAnswer();
    await sheet.locator(".connect-way", { hasText: "Same Wi-Fi" }).click();
    const codeStarted = await startedCode(codeStart);
    assert.equal(await offerCode(resynced), codeStarted, "a code Same Wi-Fi started refreshes the relay offer with that code");
    await wifiCode.filter({ hasText: exactly(spaced(codeStarted)) }).waitFor();
    await typed.filter({ hasText: exactly("…") }).waitFor();
    assert.equal(await relayRoute.getByRole("button", { name: "Copy", exact: true }).isDisabled(), true, "a six-digit code started elsewhere ends the code to type");

    // the relay's Refresh while Same Wi-Fi holds a code: Same Wi-Fi follows the offer, so the two stay equal
    const followedMint = answered(page, "/api/relay/code");
    const followedOffer = offerAfterMint(page);
    await refresh.click();
    await mintedCode(followedMint);
    const followed = await offerCode(followedOffer);
    await wifiCode.filter({ hasText: exactly(spaced(followed)) }).waitFor();
    await ui.closeSheet();

    // the identity reset, in More settings, asks first: Escape and Cancel change nothing (Escape leaves Settings
    // under it open), Reset gives the PC a new server id, and the next offer carries it
    const confirm = page.getByRole("alertdialog", { name: "Reset the relay identity?", exact: true });
    await ui.moreReset.click();
    await confirm.getByText("Phones paired through the relay will need to scan a new code.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await confirm.waitFor({ state: "detached" });
    assert.equal(await dialog.isVisible(), true, "Escape on the confirmation closes it, not Settings under it");
    await ui.moreReset.click();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    await ui.moreReset.click();
    await confirm.getByRole("button", { name: "Reset", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    await moreState.filter({ hasText: "Online. No phone connected." }).waitFor();
    const afterReset = offerAnswer();
    await connect.click();
    const rotated = decodeOffer(((await (await afterReset).json()) as { url: string }).url);
    assert.ok(rotated !== null && rotated.server_id !== offered.server_id, "the reset gives the PC a new relay identity");
    assert.notEqual(rotated.server_public_key, offered.server_public_key);
    await qr.waitFor();
    await ui.closeSheet();

    // a phone pairs with the code of a fresh page's offer, the one that follows the dialog's first code to type:
    // the page watches that code too, so the dialog closes and My devices names the phone
    await openPhoneSettings(page, fixture.origin);
    await moreState.filter({ hasText: "Online. No phone connected." }).waitFor({ state: "attached" });
    const pageOffer = offerAfterMint(page);
    await connect.click();
    const pageCode = await offerCode(pageOffer);
    await qr.waitFor();
    const relayPaired = await fetch(`${fixture.origin}/api/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-herdr-machine": "1", origin: fixture.origin },
      body: JSON.stringify({ code: pageCode, label: "Relay phone" }),
    });
    assert.equal(relayPaired.status, 204, "the phone paired with the offer's code");
    await sheet.waitFor({ state: "detached" });
    await dialog.locator('[data-section="devices"]').getByText("Paired: Relay phone.", { exact: true }).waitFor();

    // Even a Portal visitor with a saved drive role cannot control the relay (owner_only).
    const visitorContext = await englishContext(browser);
    contexts.push(visitorContext);
    const visitor = await visitorContext.newPage();
    await visitor.route("**/api/health*", async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { auth: Record<string, unknown> };
      await route.fulfill({ response, json: { ...body, auth: { ...body.auth, via: "portal", role: "drive" } } });
    });
    const visitorMutations: string[] = [];
    await visitor.route("**/api/relay/**", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      visitorMutations.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 403, json: { error: { code: "owner_only", message: "Use the access token or a paired device." } } });
    });
    await openPhoneSettings(visitor, fixture.origin);
    const seen = relayUi(visitor);
    // the visitor's dialog: the reason it cannot control the relay, no switch, no reset, no offer, no code to type,
    // and no Same Wi-Fi pairing code; More settings has no relay group for it
    await seen.connect.click();
    const visitorHelp = seen.sheet.getByTestId("relay-owner-help");
    await visitorHelp.waitFor();
    assert.ok((await visitorHelp.innerText()).trim().length > 0, "the explanation is not empty");
    assert.equal(await seen.sheet.getByRole("switch").count(), 0, "a Portal visitor gets no relay switch");
    assert.equal(await seen.sheet.getByRole("button", { name: /^Reset/ }).count(), 0, "nor the reset");
    assert.equal(await seen.relayRoute.getByRole("img").count(), 0, "a Portal visitor is shown no pairing offer");
    assert.equal(await seen.sheet.locator(".compact-pair").count(), 0, "nor a code to type");
    assert.equal(await seen.sheet.locator(".connect-way", { hasText: "Same Wi-Fi" }).count(), 0, "a Portal visitor is offered no pairing code");
    assert.equal(await seen.relayGroup.count(), 0, "a Portal visitor's More settings has no relay group");
    assert.deepEqual(visitorMutations, [], "a Portal visitor never requests an owner-only relay mutation");
    await visitorContext.close();

    // off from More settings: the offer goes with the connection, and both places say so
    await ui.openMore();
    await moreSwitch.click();
    await moreState.filter({ hasText: "Off." }).waitFor();
    assert.equal(await moreSwitch.getAttribute("aria-checked"), "false", "the switch shows the relay off");
    assert.equal((await relayState()).phase, "off", "the server's relay link is off");
    await connect.click();
    await sheetState.filter({ hasText: "Off." }).waitFor();
    assert.equal(await qr.count(), 0, "no offer while the relay is off");
    assert.equal(await refresh.count(), 0, "no code while the relay is off");
    assert.equal(await toggle.getAttribute("aria-checked"), "false", "the dialog's switch is back, off");
    await ui.closeSheet();

    // on a tailnet with the relay off, the relay's switch still leads the dialog, with the gate note (its own server:
    // the gate is still open there), Tailscale's address waits under Other ways, and the switch turns the relay on
    const tailnetFixture = startRelayFixture();
    fixtures.push(tailnetFixture);
    const tailnetRelay = async (): Promise<RelayStatus> => (await fetch(`${tailnetFixture.origin}/api/relay`)).json() as Promise<RelayStatus>;
    const tailnetContext = await englishContext(browser, TAILNET);
    contexts.push(tailnetContext);
    const tailnet = await tailnetContext.newPage();
    tailnet.setDefaultTimeout(15_000);
    tailnet.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(tailnet, tailnetFixture.origin);
    const net = relayUi(tailnet);
    await net.moreState.filter({ hasText: "Off." }).waitFor({ state: "attached" });
    await net.connect.click();
    await net.toggle.waitFor();
    assert.equal(await net.toggle.getAttribute("aria-checked"), "false", "the relay's switch leads the dialog, off");
    assert.equal(await net.sheet.getByText("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.", { exact: true }).isVisible(), true,
      "the switch keeps the gate note beside it");
    await net.sheet.locator("details.connect-other > summary").click();
    await net.sheet.locator(".connect-way", { hasText: "Tailscale" }).click();
    await net.sheet.locator(".connect-way-body").getByText("https://pc.tail0000.ts.net").first().waitFor();
    assert.equal((await tailnetRelay()).phase, "off", "opening the dialog turns nothing on");
    await net.toggle.click();
    await net.qr.waitFor();
    assert.equal((await tailnetRelay()).phase, "online", "the dialog's switch turned the server's relay on");
    await net.closeSheet();
    await tailnetContext.close();

    // a device paired through the relay wears the pill: My devices of the PC's page lists one (the
    // real pairing of a phone through the relay is relay-shell-browser-qa.ts's)
    const paired: PairedDevice = { id: "0123456789abcdef", label: "Pixel 9", role: "drive", created_at: new Date().toISOString(), last_seen_at: null, current: false, via_relay: true };
    await page.route("**/api/devices", (route) => route.request().method() === "GET" ? route.fulfill({ json: { devices: [paired] } }) : route.continue());
    await openPhoneSettings(page, fixture.origin);
    const row = page.locator(".devices-panel .devices-row").filter({ hasText: "Pixel 9" });
    await row.locator(".devices-via-relay", { hasText: "via relay" }).waitFor();

    // a start that fails before the link exists (the saved choice cannot be written): the switch stays off,
    // the reason shows, and Try again starts it once the cause is gone
    const unwritable = startRelayFixture();
    fixtures.push(unwritable);
    const savedChoice = join(unwritable.stateDir, "relay", "state.json");
    mkdirSync(savedChoice, { recursive: true });
    const failedContext = await englishContext(browser);
    contexts.push(failedContext);
    const failedPage = await failedContext.newPage();
    failedPage.setDefaultTimeout(15_000);
    failedPage.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(failedPage, unwritable.origin);
    const failed = relayUi(failedPage);
    await failed.connect.click();
    await failed.toggle.click();
    await failed.relayRoute.getByRole("alert").filter({ hasText: "The relay did not start: Could not start the relay." }).waitFor();
    assert.equal(await failed.toggle.getAttribute("aria-checked"), "false", "a start that failed leaves the switch off");
    await failed.sheetState.filter({ hasText: "Off." }).waitFor();
    rmSync(savedChoice, { recursive: true });
    await failed.relayRoute.getByRole("button", { name: "Try again", exact: true }).click();
    await failed.qr.waitFor();
    assert.equal((await (await fetch(`${unwritable.origin}/api/relay`)).json() as RelayStatus).phase, "online", "Try again turned the relay on");
    assert.equal(await failed.relayRoute.getByRole("button", { name: "Try again", exact: true }).count(), 0, "no retry once it runs");

    // serve-only: no switch anywhere, the reason in More settings and in the dialog, and no reset
    const serveOnly = startRelayFixture({ serveOnly: true });
    fixtures.push(serveOnly);
    const blockedContext = await englishContext(browser);
    contexts.push(blockedContext);
    const blockedPage = await blockedContext.newPage();
    blockedPage.setDefaultTimeout(15_000);
    blockedPage.on("pageerror", (error) => pageErrors.push(error.message));
    await openPhoneSettings(blockedPage, serveOnly.origin);
    const blocked = relayUi(blockedPage);
    await blocked.openMore();
    await blocked.moreState.filter({ hasText: "Blocked: OVIS_TAILSCALE_SERVE_ONLY" }).waitFor();
    assert.equal(await blocked.moreSwitch.count(), 0, "a serve-only install shows no relay switch in More settings");
    assert.equal(await blocked.relayGroup.getByText("Reset relay identity", { exact: true }).count(), 0, "a serve-only install is offered no reset, which it would refuse");
    await blocked.connect.click();
    await blocked.sheetState.filter({ hasText: "Blocked: OVIS_TAILSCALE_SERVE_ONLY" }).waitFor();
    assert.equal(await blocked.sheet.getByRole("switch").count(), 0, "nor in the dialog");
    assert.equal(await blocked.relayRoute.getByRole("img").count(), 0, "no offer on a blocked install");
    assert.equal(await blocked.sheet.getByRole("button", { name: /^Reset/ }).count(), 0, "nor a reset in the dialog");
    assert.equal(await blocked.sheet.locator(".connect-phone-gate").count(), 0, "a relay that cannot be turned on carries no note about turning it on");
    assert.deepEqual(pageErrors, [], "the relay panel raises no page error");
    console.log("PASS the relay turns on from Connect a device and off from More settings, offers a QR code and a code to type, and resets the identity; a relay-paired device wears the pill and serve-only blocks the switch");
  } finally {
    for (const context of contexts) await context.close();
    for (const fixture of fixtures) await fixture.stop();
  }
}
