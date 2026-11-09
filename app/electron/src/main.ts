/**
 * Ovis for the desktop: one window on the Ovis server this app runs itself, on the herdr-core
 * (`hc`) and Bun it carries. Until the server answers, or when it stops, the window shows the
 * connection screen (renderer/connect.html) with what failed. Closing the window keeps Ovis in
 * the tray; Quit stops the server. The core and its terminals keep running, as for every hc client.
 */
import { app, BrowserWindow, ipcMain, Menu, nativeImage, powerMonitor, powerSaveBlocker, session, shell, Tray, type MenuItemConstructorOptions } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import { choosePort, coreEnv, endLeftover, installCore, isFile, layout, openLog, processCommand, processStartSync, readSaved, serverEnv, startCore, startServer, stopServer, writeSaved, type RunningServer } from "./children.ts";
import { accountServiceOf, startLoopbackSignIn, type LoopbackSignIn } from "./accountSignIn.ts";
import { awakeLabel, DESKTOP_ACTIVITY_FILE, holdAwake, readAwakeSettings, readWorking, writeAwakeSettings, type AwakeSettings } from "./awake.ts";
import { checkForUpdates, debInstallCommand, updateChannel, updatePlan } from "./updates.ts";
import { extractedAppDir, othersRunFrom } from "./appimage.ts";
import { desktopLocale, desktopText } from "./text.ts";
import { hideWindow } from "./windowClose.ts";

type StepState = "pending" | "ok" | "failed";
export interface Status {
  core: StepState;
  server: StepState | "stopped";
  detail: string;
  versions: { hc: string; bun: string } | null;
}

const resources = app.isPackaged ? join(process.resourcesPath, "ovis") : process.env["OVIS_DESKTOP_STAGE"] || join(app.getAppPath(), "stage");
const programs = layout(resources);
const versions = (() => {
  try { return JSON.parse(readFileSync(join(resources, "versions.json"), "utf8")) as { hc: string; bun: string }; } catch { return null; }
})();
const logs = join(app.getPath("userData"), "logs");
const savedPath = join(app.getPath("userData"), "desktop.json");
const stateDir = process.env["OVIS_STATE_DIR"] || join(app.getPath("userData"), "server");
// from the app's root (this folder, or app.asar): the bundler fixes __dirname to where it was built
const connectPage = join(app.getAppPath(), "renderer", "connect.html");
const connectPageUrl = pathToFileURL(connectPage).href;
const preload = join(app.getAppPath(), "out", "preload.js");
const iconPath = app.isPackaged ? join(process.resourcesPath, "icon.png") : join(app.getAppPath(), "..", "assets", "icon-only.png");

let window: BrowserWindow | null = null;
/** cancels a close's hide that waits for the window to leave full screen (windowClose.ts) */
let cancelHide: (() => void) | null = null;
let tray: Tray | null = null;
let server: RunningServer | null = null;
/** the start or restart in progress; another one asked for meanwhile is dropped */
let busy: Promise<void> | null = null;
/** the server being started, before it says where it listens */
let spawning: ChildProcess | null = null;
let quitting = false;
let stopped = false;
let updateReady: (() => void) | null = null;
let status: Status = { core: "pending", server: "pending", detail: "", versions };
const awakePath = join(app.getPath("userData"), "awake.json");
let awake = readAwakeSettings(awakePath);
/** the powerSaveBlocker held while an agent works (awake.ts), and how many worked when last read */
let awakeBlocker: number | null = null;
let awakeWorking = 0;
/** the tray's and the menu bar's words, in the app's language once it is ready (app.getLocale()) */
let text = desktopText("en");

const accountService = accountServiceOf(process.env);

/** The sign-ins that service offers: OVIS_ACCOUNT_PROVIDERS (GitHub alone without it), so Apple shows only once it is set up. */
const accountProviders = (process.env["OVIS_ACCOUNT_PROVIDERS"] ?? "").split(",").map((name) => name.trim()).filter((name) => name === "github" || name === "google" || name === "apple");

function serverOrigin(): string | null {
  return server ? new URL(server.url).origin : null;
}

function ours(url: string): boolean {
  try { return new URL(url).origin === serverOrigin(); } catch { return false; }
}

function openOutside(url: string): void {
  try {
    if (["http:", "https:", "mailto:"].includes(new URL(url).protocol)) void shell.openExternal(url);
  } catch { /* not an address */ }
}

function setStatus(next: Partial<Status>): void {
  status = { ...status, ...next };
  window?.webContents.send("ovis:status", status);
  rebuildTrayMenu();
}

function showConnect(): void {
  if (window && !window.webContents.getURL().startsWith("file:")) void window.loadFile(connectPage);
}

function showWindow(): void {
  cancelHide?.();
  cancelHide = null;
  if (!window) createWindow();
  window!.show();
  window!.focus();
}

function lifecycle(task: () => Promise<void>): Promise<void> {
  if (busy !== null || quitting) return busy ?? Promise.resolve();
  busy = task().finally(() => {
    busy = null;
    rebuildTrayMenu();
  });
  rebuildTrayMenu();
  return busy;
}

const start = () => lifecycle(launch);

const restart = () => lifecycle(async () => {
  const running = server;
  server = null;
  if (running) await stopServer(running);
  await launch();
});

async function launch(): Promise<void> {
  setStatus({ core: "pending", server: "pending", detail: "" });
  showConnect();
  let log: WriteStream | null = null;
  try {
    if (!isFile(programs.bun) || !isFile(programs.hc)) {
      setStatus({ core: "failed", detail: `This build has no bundled herdr-core and Bun in ${resources}. Build it with \`bun scripts/build.ts stage\` in app/electron.` });
      return;
    }
    let hc: string;
    try {
      log = openLog(join(logs, "ovis.log"));
      hc = await installCore(programs.hc, join(app.getPath("userData"), "bin"), coreEnv(process.env), log);
      await startCore(hc, coreEnv(process.env), log);
      setStatus({ core: "ok" });
    } catch (error) {
      setStatus({ core: "failed", detail: message(error) });
      return;
    }
    const saved = readSaved(savedPath);
    if (await endLeftover(saved.server)) await waitUntilEnded(saved.server!.pid, 10_000);
    const port = await choosePort(saved.port);
    // a quit during the steps above: no server is started for it
    if (quitting) return;
    try {
      // recorded as soon as it runs, so a crash of the app before it listens still leaves its pid behind
      const running = await startServer(programs, serverEnv(process.env, { hc, stateDir, port }), log, 60_000, (child) => {
        spawning = child;
        writeSaved(savedPath, { port, server: { pid: child.pid!, bun: programs.bun, started: processStartSync(child.pid!) } });
      });
      spawning = null;
      if (quitting) {
        await stopServer(running);
        writeSaved(savedPath, { port, server: null });
        return;
      }
      server = running;
      const runLog = log;
      void running.exited.then((code) => {
        runLog.end();
        if (server !== running) return;
        server = null;
        writeSaved(savedPath, { port, server: null });
        if (quitting) return;
        const how = code !== null ? `exit code ${code}` : `signal ${running.child.signalCode ?? "unknown"}`;
        setStatus({ server: "stopped", detail: `The Ovis server stopped (${how}). Its output is in the logs.` });
        showConnect();
      });
      setStatus({ server: "ok" });
    } catch (error) {
      spawning = null;
      writeSaved(savedPath, { port, server: null });
      setStatus({ server: "failed", detail: message(error) });
    }
  } finally {
    if (log && !server) log.end();
  }
  // a load that fails (or another one cut it short) leaves the server running and recorded
  if (server) await window?.loadURL(server.url).catch((error: unknown) => console.error(`Opening ${server?.url} failed: ${message(error)}`));
}

async function waitUntilEnded(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && await processCommand(pid) !== null) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** stops the server once; a quit (or an update's) waits for it, then goes ahead */
async function stopForQuit(): Promise<void> {
  quitting = true;
  // a server still starting ends now; the start in progress then returns
  spawning?.kill("SIGTERM");
  await busy;
  const running = server;
  if (running) await stopServer(running).catch(() => {});
  stopped = true;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 480,
    title: "Ovis",
    backgroundColor: "#12100e",
    autoHideMenuBar: true,
    show: false,
    ...(process.platform === "linux" ? { icon: iconPath } : {}),
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.once("ready-to-show", () => window?.show());
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    cancelHide?.();
    cancelHide = window ? hideWindow(window, process.platform) : null;
  });
  window.on("closed", () => { window = null; cancelHide = null; });
  guard(window.webContents);
  void window.loadFile(connectPage);
}

/**
 * The server's own pages may open more Ovis windows; any other address goes to the default browser.
 * A blank window a page opens to send somewhere next (a sign-in) is allowed: once it heads for
 * another address, that address opens in the default browser and the window closes.
 */
function guard(contents: Electron.WebContents, blank?: BrowserWindow): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (ours(url) || (url === "about:blank" && ours(contents.getURL()))) {
      return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: "#12100e", webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } } };
    }
    openOutside(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child, { url }) => guard(child.webContents, url === "about:blank" ? child : undefined));
  contents.on("will-navigate", (event, url) => {
    if (ours(url) || url === connectPageUrl) return;
    event.preventDefault();
    openOutside(url);
    blank?.close();
  });
}

/** holds off system sleep while the setting is on and an agent works, and lets go as soon as none does */
function updateAwake(): void {
  const working = server ? readWorking(join(stateDir, DESKTOP_ACTIVITY_FILE)) : 0;
  const hold = holdAwake({ settings: awake, working, onBattery: powerMonitor.isOnBatteryPower(), serverRunning: server !== null });
  const changed = hold !== (awakeBlocker !== null) || (hold && working !== awakeWorking);
  awakeWorking = working;
  if (hold && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!hold && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = null;
  }
  if (changed) rebuildTrayMenu();
}

function setAwake(next: AwakeSettings): void {
  awake = next;
  try { writeAwakeSettings(awakePath, next); } catch (error) { console.error(`Saving ${awakePath} failed: ${message(error)}`); }
  updateAwake();
  rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const url = server?.url ?? null;
  const holding = awakeBlocker !== null ? awakeLabel(awakeWorking, text) : null;
  tray.setToolTip(holding ? `Ovis: ${holding}` : "Ovis");
  const items: MenuItemConstructorOptions[] = [
    ...(holding ? [{ label: holding, enabled: false }, { type: "separator" as const }] : []),
    { label: text("Open Ovis"), click: showWindow },
    { label: text("Open in Browser"), enabled: url !== null, click: () => url && openOutside(url) },
    { type: "separator" },
    {
      label: text("Keep Computer Awake"),
      submenu: [
        { label: text("While an Agent Is Working"), type: "checkbox", checked: awake.whileWorking, click: (item) => setAwake({ ...awake, whileWorking: item.checked }) },
        { label: text("Also on Battery"), type: "checkbox", checked: awake.onBattery, enabled: awake.whileWorking, click: (item) => setAwake({ ...awake, onBattery: item.checked }) },
      ],
    },
    { type: "separator" },
    { label: text("Restart Ovis Server"), enabled: busy === null, click: () => void restart() },
    ...(updateReady ? [{ label: text("Restart to Update"), click: updateReady }] : []),
    { type: "separator" },
    { label: text("Quit Ovis"), click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath).resize({ width: process.platform === "darwin" ? 18 : 24 });
  tray = new Tray(image);
  tray.setToolTip("Ovis");
  tray.on("click", showWindow);
  rebuildTrayMenu();
}

function createMenu(): void {
  const openInBrowser: MenuItemConstructorOptions = { label: text("Open in Browser"), click: () => server && openOutside(server.url) };
  const view: MenuItemConstructorOptions = {
    label: text("View"),
    submenu: [
      { label: text("Reload"), accelerator: "CmdOrCtrl+R", click: () => window?.webContents.reload() },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
  const template: MenuItemConstructorOptions[] = process.platform === "darwin"
    ? [{ role: "appMenu" }, { label: text("File"), submenu: [openInBrowser, { type: "separator" }, { role: "close" }] }, { role: "editMenu" }, view, { role: "windowMenu" }]
    : [{ label: text("File"), submenu: [openInBrowser, { type: "separator" }, { label: text("Quit"), accelerator: "CmdOrCtrl+Q", click: () => app.quit() }] }, { role: "editMenu" }, view];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function allowPermissions(): void {
  // the Ovis page may use the microphone (dictation, never the camera), the clipboard and notifications; nothing else asks
  const allowed = new Set(["clipboard-sanitized-write", "clipboard-read", "notifications", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (!ours(details.requestingUrl)) return callback(false);
    if (permission === "media") {
      const types = "mediaTypes" in details ? details.mediaTypes ?? [] : [];
      return callback(types.length > 0 && types.every((type) => type === "audio"));
    }
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) => {
    if (!ours(origin)) return false;
    if (permission === "media") return details.mediaType === "audio";
    return allowed.has(permission);
  });
}

/**
 * An update line, written to the app's log (logs/ovis.log) as well as its output: an app opened from
 * the desktop has nobody reading its output.
 */
function updateLog(line: string): void {
  console.log(line);
  try {
    mkdirSync(logs, { recursive: true });
    appendFileSync(join(logs, "ovis.log"), `${line}\n`);
  } catch (error) { console.error(`Writing to ${logs} failed: ${message(error)}`); }
}

async function startUpdates(): Promise<void> {
  let linuxPackage: string | null = null;
  try { linuxPackage = readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim(); } catch { /* not a Linux package */ }
  const plan = updatePlan({ packaged: app.isPackaged, env: process.env, platform: process.platform, builtWithFeed: existsSync(join(process.resourcesPath, "app-update.yml")),
    channel: updateChannel(process.env, stateDir), linuxPackage, execPath: process.execPath });
  if (!plan.enabled) {
    updateLog(`Updates are off: ${plan.reason}.`);
    return;
  }
  const updater = await import("electron-updater");
  // one privileged apt-get and nothing else. DebUpdater's own dpkg path follows any failure with
  // `apt-get install -f` (a cancelled prompt asked again, and a no-op repair restarted Ovis on its
  // old version); its apt path allows unauthenticated, downgraded and held packages.
  class OvisDebUpdater extends updater.DebUpdater {
    protected override doInstall(options: { isForceRunAfter: boolean }): boolean {
      const file = this.installerPath;
      if (file == null) {
        this.dispatchError(new Error("No downloaded update to install"));
        return false;
      }
      try {
        this.runCommandWithSudoIfNeeded(debInstallCommand(file, !this.isRunningAsRoot()));
      } catch (error) {
        this.dispatchError(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
      if (options.isForceRunAfter) app.relaunch();
      return true;
    }
  }
  const autoUpdater = plan.installer === "deb" ? new OvisDebUpdater() : plan.installer === "appimage" ? new updater.AppImageUpdater() : updater.autoUpdater;
  if (plan.feed) autoUpdater.setFeedURL({ provider: "generic", url: plan.feed });
  // beta-mac.yml and beta-linux.yml on beta, latest-*.yml otherwise; setting a channel allows downgrades, which stay off
  autoUpdater.channel = plan.channel === "beta" ? "beta" : "latest";
  autoUpdater.allowPrerelease = plan.channel === "beta";
  autoUpdater.allowDowngrade = false;
  updateLog(`Updates: ${plan.channel} channel.`);
  // a .deb installs behind a password prompt: only when asked from the tray, never on a plain quit
  if (plan.installer === "deb") autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("error", (error) => updateLog(`Update failed: ${message(error)}`));
  autoUpdater.on("update-downloaded", () => {
    // the .deb installs first and the app quits (stopping the server) only once it did, then starts again;
    // a cancelled prompt leaves the app and its server running. The AppImage starts its new copy at
    // once, so the server stops before.
    updateReady = plan.installer === "deb" ? () => autoUpdater.quitAndInstall() : () => void stopForQuit().then(() => autoUpdater.quitAndInstall());
    rebuildTrayMenu();
  });
  const check = () => void checkForUpdates(autoUpdater, updateLog);
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  ipcMain.handle("ovis:status", () => status);
  ipcMain.on("ovis:retry", (event) => {
    if (event.senderFrame?.url.startsWith("file:")) void (server ? restart() : start());
  });
  ipcMain.on("ovis:logs", (event) => {
    if (event.senderFrame?.url.startsWith("file:")) void shell.openPath(logs);
  });
  // signing in to the account (accountSignIn.ts): only the server's own pages may, and only to the account service named
  let signIn: LoopbackSignIn | null = null;
  ipcMain.on("ovis:account-service", (event) => {
    event.returnValue = ours(event.senderFrame?.url ?? "") && accountService !== null ? { service: accountService, providers: accountProviders } : null;
  });
  ipcMain.handle("ovis:account-start", async (event) => {
    if (!ours(event.senderFrame?.url ?? "") || accountService === null) throw new Error("Signing in is not offered here");
    signIn = await startLoopbackSignIn();
    return signIn.redirectUri;
  });
  ipcMain.handle("ovis:account-open", async (event, url: unknown) => {
    if (!ours(event.senderFrame?.url ?? "") || accountService === null || signIn === null) throw new Error("No sign-in is waiting");
    if (typeof url !== "string" || new URL(url).origin !== accountService) throw new Error("That is not the account service");
    const waiting = signIn;
    const state = new URL(url).searchParams.get("state");
    if (state === null) throw new Error("That sign-in names no state");
    waiting.expect(state);
    openOutside(url);
    try { return await waiting.returned; } finally { if (signIn === waiting) signIn = null; }
  });
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    // quit again only once this cancelled quit is over: a quit asked for inside it is dropped
    if (!quitting) void stopForQuit().then(() => setImmediate(() => app.quit()));
  });
  // an AppImage run unpacked (no FUSE) leaves its folder in the temporary folder: the server, the
  // last user of its files, has stopped by now (the core runs from its own copy). Another copy of the
  // same AppImage runs from the same folder: then it stays
  const unpacked = process.platform === "linux" ? extractedAppDir(process.env, process.execPath) : null;
  if (unpacked) {
    app.on("quit", () => {
      try {
        if (!othersRunFrom(unpacked, process.pid)) rmSync(unpacked, { recursive: true, force: true });
      } catch (error) {
        console.error(`Removing ${unpacked} failed: ${message(error)}`);
      }
    });
  }
  app.on("activate", showWindow);
  // the app stays in the tray with its window closed
  app.on("window-all-closed", () => {});
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
  void app.whenReady().then(() => {
    text = desktopText(desktopLocale(app.getLocale()));
    allowPermissions();
    createMenu();
    createWindow();
    createTray();
    setInterval(updateAwake, 5_000);
    powerMonitor.on("on-ac", updateAwake);
    powerMonitor.on("on-battery", updateAwake);
    void start().then(startUpdates);
  });
}
