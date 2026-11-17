/**
 * The first-run setup guide (lib/setupGuideFlow.ts), drawn as a dialog over the app: it opens on the
 * steps, then a Done screen whose Start opens the first workspace. The agent step checks the PC for
 * coding agents, then shows every one as a tile whatever it found: an installed one is picked by a tap,
 * a missing one has its Install (the user's tap is the consent: the official installer runs in a
 * terminal tab while a ring turns on the tile). Start opens the first workspace with the one picked;
 * the agent asks for its own sign-in when it first starts. Its footer's Start now, finish setup later
 * starts on Done's Start (Continue three times, then Start); Set up later closes it. Plan usage is turned on for
 * accounts already signed in. Done keeps Connect your phone beside Start: it leads with the Ovis relay
 * where it can (lib/setupGuideFlow.ts phoneWay): a tap turns it on, then its pairing QR code shows right
 * there, and a browser in only because nothing is paired yet pairs itself first, as turning the relay
 * on closes the device gate. Use Tailscale or Wi-Fi instead, or a page where the relay cannot lead,
 * shows the page's own QR code and address (that browser pairs itself first too, as Settings → Phone's
 * Pair this device now does; Settings → Phone where the page has no phone-reachable address). It adds
 * no server route. The dialog follows Orca's and Linear's first runs (a centred 16:9 card over the app
 * with a step at a time) rather than the Claude and Codex apps' page in the main area: the app behind it
 * stays visible, and the card's height never moves between steps.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { ArrowRight, Bell, BellRing, Check, ChevronLeft, Circle, CircleCheck, Copy, ExternalLink, TriangleAlert, Folder, Gauge, Globe, Info, KeyRound, LoaderCircle, Network, Play, RefreshCw, RotateCw, Smartphone, Wifi, X } from "lucide-react";

import type { AgentCatalogEntry, AgentCatalogRow } from "../../shared/agent-catalog.ts";
import type { HealthAuth, PairingCode, RemoteAccess } from "../../shared/protocol.ts";
import type { SecurityFacts } from "../lib/useAccess.ts";
import { ApiError, createWorkspace, fetchAgentCatalog, fetchDevices, fetchRemoteAccess, fetchUsage, startPairing } from "../lib/api.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { createRequest, newSessionLaunch } from "../lib/newSession.ts";
import { pairThisBrowser, UnconfirmedPairing } from "../lib/pairing.ts";
import { isLoopbackHost, phonePlan } from "../lib/phone.ts";
import { recentDirectories } from "../lib/recent-directories.ts";
import { useSettings, type Settings } from "../lib/settings.ts";
import { useAlertFilters } from "../lib/alertFilters.ts";
import { alertMeWhenChips } from "./AlertChips.tsx";
import { pageNotifications, showTestNotification, type NotificationState } from "../lib/notifications.ts";
import { refreshPushHealth, usePushHealth, type PushActionResult } from "../lib/pushHealth.ts";
import { pickTheme, rowFor, THEME_IDS, type Mode, type ThemeId } from "../lib/themes.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { agentRows, checkList, foundAgents, installedHere, phoneBoxMode, phoneBoxOpensFirst, phoneBoxStays, phoneWay, openInFolder, preferredAgent, relayStep, settleDelay, setupView, signedInAgents, turnsUsageOn, type CheckStatus, type GuideEvent, type GuideState, type PcCheck, type PhoneBoxOpening } from "../lib/setupGuideFlow.ts";
import { focusInOtherModal, nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { inRelayShell, useRelay, type RelayState } from "../lib/useRelay.ts";
import { browserStorage, USAGE_ARMED_KEY } from "../lib/firstHints.ts";
import { useOtherDevice, useSignedInUsage } from "../lib/useSetupGuide.ts";
import { userErrorMessage, userFailure } from "../lib/userError.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentTile } from "./AgentTile.tsx";
import { OvisMark } from "./OvisMark.tsx";
import { ChipToggles, Segmented } from "./SettingsControls.tsx";
import { ThemeCard, THEME_NAMES } from "./ThemeCard.tsx";
import { themeLabel } from "./ThemeFiles.tsx";
import { repairFailureText } from "./PushHealthNotice.tsx";
import { inNativeApp } from "../lib/nativeApp.ts";
import { desktopUpdateBridge } from "../lib/desktopUpdate.ts";
import { alertsFailed, alertsHere, alertsSurfaces, type AlertsHere as AlertsAnswer } from "../lib/setupGuideFlow.ts";
import { pushSupported, registeredPushEndpoint } from "../lib/push.ts";
import { confirmation } from "../lib/pushConfirm.ts";
import { AlertsChecking, ALERTS_CHECK_GIVE_UP_MS, useLongerThan } from "./AlertsChecking.tsx";
import { chosenTheme } from "../lib/customThemes.ts";
import { TelemetryNotice } from "./TelemetryControls.tsx";
import { UsageSignInDialog } from "./UsageSignInDialog.tsx";
import { QrCode } from "./QrCode.tsx";
import { copyText } from "../lib/clipboard.ts";
import { failureText, RelayPairing, statusText } from "./RelayPanel.tsx";
import "./SetupGuide.css";

/** the catalog's agents, named in the check's lines before the PC answers */
type KnownAgent = Pick<AgentCatalogEntry, "id" | "name" | "kind">;
/** where Start opens the first workspace when this browser has no recent folder: the server's home */
const HOME = "~";

export interface SetupGuideProps {
  state: GuideState;
  /** stepped aside for a pane the user went to: kept mounted, so what runs goes on */
  hidden?: boolean;
  dispatch: (event: GuideEvent) => void;
  /** Set up later, the close button or Escape, or the first workspace opened */
  onClose: () => void;
  /** shows the tab an install or sign-in runs in */
  onOpenTerminal: (paneId: string) => void;
  /** Connect your phone where the guide cannot show its QR code: the Settings page that pairs it */
  onOpenSettings: (page: "devices") => void;
  /** the line about anonymous usage counts: its sentence opens Settings → About, where the switch is */
  onOpenTelemetry: () => void;
  /** how this browser got in: one in only because nothing is paired yet pairs itself first (Connect your phone) */
  auth: HealthAuth | null;
  /** the server's access facts: whether turning the relay on closes the open device gate (Connect your phone) */
  security: SecurityFacts;
  /** this browser paired itself (Connect your phone): the app reads its access again */
  onPaired: () => void;
  /** turns this device's alerts on, asking the browser first (App's enableNotifications) */
  onEnableAlerts: () => Promise<PushActionResult>;
  /** Settings is open over the guide: the paired devices are read again when it closes */
  settingsOpen?: boolean;
  /** this device has a push subscription (App's pushOn): alerts reach it with no tab open */
  pushOn?: boolean;
  /** this device's notification permission as App keeps it: it changes with the browser's answer */
  notifications: NotificationState;
  /** Start pressed: a tab the guide asked to show before it is not shown over what Start opens */
  onStarting?: () => void;
  /** the first workspace opened: its pane, and whether the agent started in it */
  onOpened: (paneId: string, agentStarted: boolean) => void;
}

export function SetupGuide(props: SetupGuideProps) {
  const { state, onClose, hidden = false } = props;
  const t = useT();
  const machineId = useMachineId();
  // the PC check: GET /api/agent-catalog for the PC being set up, run as the guide opens and on Look again
  const [catalog, setCatalog] = useState<AgentCatalogRow[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [known, setKnown] = useState<readonly KnownAgent[]>([]);
  // the agents installed from the tiles: installed, before the PC is read again
  const [ready, setReady] = useState<readonly string[]>([]);
  // Connect your phone's box closed once (a tap, or withdrawn): the agents screen made anew (Look again) leaves it closed
  const [phoneClosed, setPhoneClosed] = useState(false);
  // said to a screen reader once the screen settles; its heading changes without focus
  const [announced, setAnnounced] = useState("");
  const asked = useRef(0);
  const settle = useRef<number | undefined>(undefined);
  const loadCatalog = (): void => {
    const ask = ++asked.current;
    const startedAt = Date.now();
    window.clearTimeout(settle.current);
    setCatalog(null);
    setCatalogError(null);
    // a check asked for again is the truth: an agent installed here earlier counts only if it still answers
    setReady([]);
    setAnnounced("");
    setChecking(true);
    // the catalog's names, kept out of the app's main bundle; without them the lines come with the answer
    import("../../shared/agent-catalog.ts").then((module) => setKnown(module.AGENT_CATALOG), () => {});
    fetchAgentCatalog(machineId).then((answer) => {
      if (ask !== asked.current) return;
      setCatalog(answer.agents);
      settle.current = window.setTimeout(() => {
        if (ask !== asked.current) return;
        setChecking(false);
        setAnnounced(foundAgents(answer.agents).length > 0 ? t("Pick an agent") : t("Install an agent"));
      }, settleDelay(startedAt, Date.now()));
    }, (error: unknown) => {
      if (ask !== asked.current) return;
      setCatalogError(userFailure(error).kind === "unknown" ? t("Couldn't load the agents.") : userErrorMessage(error).message);
      setChecking(false);
    });
  };
  // an agent installed from its tile: installed from now on, the PC read again for its version, and said
  const agentInstalled = (agent: string): void => {
    if (ready.includes(agent)) return;
    setReady((list) => list.includes(agent) ? list : [...list, agent]);
    setAnnounced(t("{agent} is ready", { agent: catalog?.find((row) => row.id === agent)?.name ?? agent }));
    const ask = ++asked.current;
    fetchAgentCatalog(machineId).then((answer) => { if (ask === asked.current) setCatalog(answer.agents); }, () => { /* Start works without the version */ });
  };
  useEffect(() => {
    loadCatalog();
    return () => { asked.current += 1; window.clearTimeout(settle.current); };
  }, [machineId]); // eslint-disable-line react-hooks/exhaustive-deps
  const check: PcCheck = { checking, catalog, failed: catalogError !== null };
  // the step shown: the head's step bar and the body follow it
  // opened again at a later step (the sidebar's Setup: N left) starts there
  const [page, setPage] = useState<GuidePage>(state.at ?? "agent");
  // left that step: a reload resumes where the user is (#3907 review)
  useEffect(() => { if (state.at !== undefined && page !== state.at) props.dispatch({ type: "moved" }); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = setupView(check);

  // the control the dialog gives the keyboard to when it opens: the step's title
  const firstFocus = useRef<HTMLElement | null>(null);
  const surface = useFocusTrap<HTMLElement>(!hidden, { initialFocus: firstFocus });
  // a phone's Back closes it, as it closes any sheet, rather than leaving the app with it open
  usePhoneSheetBack(onClose, !hidden);
  // Escape closes it, as its close button does: closing loses nothing (Settings → Agents opens it again).
  // A dialog over it (a sign-in) that holds the focus takes its own Escape
  useEffect(() => {
    if (hidden) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      // a dialog over it (a sign-in, a native one such as Add PC) takes its own Escape
      if (focusInOtherModal(surface.current) || nativeModalOver(surface.current)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [hidden, onClose, surface]);
  // the steps swap in place (Continue, Back): the one shown takes the keyboard
  const stepBefore = useRef(state.step);
  useEffect(() => {
    if (stepBefore.current === state.step) return;
    stepBefore.current = state.step;
    if (!hidden) firstFocus.current?.focus({ preventScroll: true });
  }, [state.step, hidden]);
  const viewBefore = useRef(view);
  // the close button holds the keyboard only because the dialog opened on the check: the first view after it takes
  // it once; later (Look again) a keyboard user who went to Close keeps their place
  const headHanded = useRef(false);
  useEffect(() => {
    if (viewBefore.current === view) return;
    viewBefore.current = view;
    // a dialog over the guide (Settings, a sign-in) keeps the keyboard: Escape there must not close the guide
    if (focusInOtherModal(surface.current)) return;
    // the control that had focus went with the view it was in, or the dialog opened on the check and gave it
    // to its close button: the new view's heading takes it
    const active = document.activeElement;
    const inHead = active !== null && active.closest(".setup-head") !== null;
    if (!hidden && (active === null || active === document.body || !surface.current?.contains(active) || (inHead && !headHanded.current))) document.getElementById("setup-step-title")?.focus({ preventScroll: true });
    headHanded.current = true;
  }, [view, hidden, surface]);

  // the page's own line about usage counts would be under the scrim: each step carries it while the guide is shown
  // a guide stepped aside (hidden) shows nothing, so its line neither shows nor counts as seen
  const notice = <TelemetryNotice inline enabled={!hidden} onOpen={props.onOpenTelemetry} />;
  let body: ReactNode;
  if (view === "agents" && catalog !== null) body = <Steps page={page} setPage={setPage} onEnableAlerts={props.onEnableAlerts} notifications={props.notifications} settingsOpen={props.settingsOpen} pushOn={props.pushOn} catalog={catalog} ready={ready} machineId={machineId} onClose={onClose} onInstalled={agentInstalled} onLookAgain={loadCatalog} onOpenTerminal={props.onOpenTerminal} onOpened={props.onOpened} onOpenSettings={props.onOpenSettings} auth={props.auth} security={props.security} onStarting={props.onStarting} onPaired={props.onPaired} usageOn={turnsUsageOn(props.state)} phoneFirst={!phoneClosed && phoneBoxOpensFirst(props.state, isLoopbackHost(window.location.hostname))} onPhoneClosed={() => setPhoneClosed(true)} notice={notice} firstFocus={firstFocus} />;
  else body = <CheckStep onClose={onClose} notice={notice} firstFocus={firstFocus}>{view === "failed" ? <CheckFailed error={catalogError} onLookAgain={loadCatalog} /> : <Checking known={known} catalog={catalog} />}</CheckStep>;

  return (
    <div className="modal-scrim setup-scrim" hidden={hidden}>
      {/* stepped aside (hidden) it is no dialog: the app's checks for an open modal (typing, the drawer, Escape) must not
          find it, as the drawer and the docked WebPanel drop theirs */}
      <section ref={surface} className="modal setup-dialog" role={hidden ? undefined : "dialog"} aria-modal={hidden ? undefined : true} aria-labelledby={hidden ? undefined : "setup-dialog-name"} tabIndex={-1}>
        <header className="modal-header setup-head">
          <span className="setup-brand" id="setup-dialog-name"><OvisMark width={24} height={24} />{t("Set up Ovis")}</span>
          {/* the steps' list sits here once the guide has more than one step */}
          {<StepList page={page} agent={catalog !== null && agentRows(catalog, ready).some((row) => installedHere(row, ready))} />}
          <button type="button" className="icon-button" aria-label={t("Close setup")} title={t("Close setup")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <p className="visually-hidden" role="status">{announced}</p>
        {body}
      </section>
    </div>
  );
}

type FirstFocus = MutableRefObject<HTMLElement | null>;

/** The agent step's title, given the keyboard when the step is shown. */
function StepTitle({ children, firstFocus }: { children: ReactNode; firstFocus: FirstFocus }) {
  const ref = useCallback((node: HTMLHeadingElement | null) => { firstFocus.current = node; }, [firstFocus]);
  return <h2 ref={ref} id="setup-step-title" className="setup-title" tabIndex={-1}>{children}</h2>;
}

/** The agent step while the PC is checked, or when the check failed: nothing to pick yet, so nothing to continue with. */
function CheckStep({ onClose, notice, firstFocus, children }: { onClose: () => void; notice: ReactNode; firstFocus: FirstFocus; children: ReactNode }) {
  const t = useT();
  return (
    <>
      <div className="modal-body setup-body setup-body-single">
        <div className="setup-main">
          {children}
          {notice}
        </div>
      </div>
      <footer className="modal-footer setup-foot">
        <button type="button" className="btn btn-ghost setup-later" title={t("Reopen it in Settings → Agents.")} onClick={onClose}>{t("Set up later")}</button>
        <button type="button" className="btn btn-primary" disabled>{t("Continue")}<ArrowRight aria-hidden="true" /></button>
      </footer>
      {/* the title lives in the children; the check's own heading takes the focus */}
      <FocusTitle firstFocus={firstFocus} />
    </>
  );
}

/** Points the dialog's first focus at #setup-step-title, wherever the step put it: before the dialog's own trap reads it. */
function FocusTitle({ firstFocus }: { firstFocus: FirstFocus }) {
  useLayoutEffect(() => { firstFocus.current = document.getElementById("setup-step-title"); });
  return null;
}

function checkLine(t: Translate, status: CheckStatus): ReactNode {
  switch (status.kind) {
    case "looking": return <><LoaderCircle aria-hidden="true" className="setup-spin" /><span className="visually-hidden">{t("Looking")}</span></>;
    case "installed": return <><Check aria-hidden="true" />{status.version === null ? t("Installed") : t("Installed · v{version}", { version: status.version })}</>;
    case "missing": return t("Not installed");
    case "unknown": return t("Can't tell");
  }
}

function Checking({ known, catalog }: { known: readonly KnownAgent[]; catalog: readonly AgentCatalogRow[] | null }) {
  const t = useT();
  const lines = checkList(known, catalog);
  return (
    <>
      <h2 id="setup-step-title" className="setup-title" tabIndex={-1}>{t("Looking for agents…")}</h2>
      {lines.length > 0 && (
        <ul className="setup-check" aria-busy={catalog === null}>
          {lines.map((line) => (
            <li key={line.id} data-status={line.status.kind}>
              <AgentMark agent={line.id} size={18} />
              <span className="setup-check-name">{line.name}</span>
              <span className="setup-check-status">{checkLine(t, line.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CheckFailed({ error, onLookAgain }: { error: string | null; onLookAgain: () => void }) {
  const t = useT();
  return (
    <>
      <h2 id="setup-step-title" className="setup-title" tabIndex={-1}>{t("Couldn't look for agents")}</h2>
      {error !== null && <p className="setup-error" role="alert">{error}</p>}
      <div className="setup-actions">
        <button type="button" className="btn btn-primary" onClick={onLookAgain}><RotateCw aria-hidden="true" />{t("Look again")}</button>
      </div>
    </>
  );
}

interface StepsProps extends Pick<StepState, "page" | "setPage">, Pick<SetupGuideProps, "onEnableAlerts" | "notifications" | "settingsOpen" | "pushOn" | "onOpenTerminal" | "onOpened" | "onOpenSettings" | "auth" | "security" | "onStarting" | "onPaired" | "onClose"> {
  /** the line about usage counts, at the end of the step's column */
  notice: ReactNode;
  /** a first run turns plan usage on for a signed-in account; a reopened guide leaves the setting alone */
  usageOn: boolean;
  /** a first run on the PC itself: Connect your phone's box is open from the start (phoneBoxOpensFirst) */
  phoneFirst: boolean;
  /** the box closed: Look again does not open it by itself again */
  onPhoneClosed: () => void;
  catalog: readonly AgentCatalogRow[];
  ready: readonly string[];
  machineId: string;
  /** an agent installed from its tile: installed from now on, before the PC is read again */
  onInstalled: (agent: string) => void;
  onLookAgain: () => void;
  firstFocus: FirstFocus;
}

/** The agent step and the Done screen: one place keeps the agent picked and what Start did, for both. */
function Steps({ page, setPage, onEnableAlerts, notifications, settingsOpen = false, pushOn = false, catalog, ready, machineId, notice, onClose, onInstalled, onLookAgain, onOpenTerminal, onOpened, onOpenSettings, auth, security, onStarting, onPaired, usageOn, phoneFirst, onPhoneClosed, firstFocus }: StepsProps) {
  const t = useT();
  const { settings, update } = useSettings();
  const agents = agentRows(catalog, ready);
  const installed = agents.filter((agent) => installedHere(agent, ready));
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = installed.find((agent) => agent.id === picked) ?? preferredAgent(installed, ready.at(-1) ?? null);
  // no agent left to start (Look again found none): Done has nothing to start, so the guide is back on the agents
  // (#3882). The theme and the phone stay reachable without one: Setup: N left reopens the guide there (#3907 review)
  // the step shown: the agents, or Done with its Start
  const pageBefore = useRef(page);
  useEffect(() => { if (page === "done" && chosen === null) setPage("agent"); }, [page, chosen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pageBefore.current === page) return;
    pageBefore.current = page;
    // the button pressed went with the step it was in: the new step's title takes the keyboard
    document.getElementById("setup-step-title")?.focus({ preventScroll: true });
  }, [page]);
  // the agents already signed in here: their plan usage is turned on as soon as they are seen, without a question
  // plan usage: nothing is read from the PC's sign-ins, nor turned on, before the user's own press on the agent step
  // (Continue), as main waited for I'm new to Ovis; Set up later from the first step reads nothing
  const [usageArmed, setUsageArmed] = useState(() => browserStorage()?.getItem(USAGE_ARMED_KEY) === "1");
  const armUsage = (): void => {
    setUsageArmed(true);
    try { browserStorage()?.setItem(USAGE_ARMED_KEY, "1"); } catch { /* not kept: the next press arms it again */ }
  };
  const signedIn = useSignedInUsage(ready, (refresh) => fetchUsage(refresh).then((report) => signedInAgents(report.providers)), settings.showUsage || !usageOn, () => update({ showUsage: true }), usageArmed);
  // Claude Code and Codex, installed here and not signed in yet: signed in from the guide, in the browser
  // (UsageSignInDialog). Accounts are read on the server's PC, so only its own guide offers it, and a
  // watching device signs in to nothing
  // signed in from here: the usage read that would say so may not come again while the guide is open
  const [signedHere, setSignedHere] = useState<readonly string[]>([]);
  const unsigned = machineId === "local" && auth?.role !== "watch" && signedIn !== null ? installed.filter((agent) => (agent.id === "claude" || agent.id === "codex") && !signedIn.includes(agent.id) && !signedHere.includes(agent.id)) : [];
  const [signingIn, setSigningIn] = useState<{ provider: "claude" | "codex"; default: true } | null>(null);
  // the tiles whose install runs: Look again waits for them (a fresh read would end their watch);
  // Start does not: an install runs on in its tab whatever the guide does
  const [installing, setInstalling] = useState<readonly string[]>([]);
  const busy = installing.length > 0;
  const onRunning = useCallback((id: string, running: boolean): void => setInstalling((list) => running ? (list.includes(id) ? list : [...list, id]) : list.filter((one) => one !== id)), []);
  // why an install did not finish, per agent: one tile's news never clears another's
  const [installErrors, setInstallErrors] = useState<Readonly<Record<string, string>>>({});
  const onInstallError = useCallback((id: string, message: string | null): void => setInstallErrors((errors) => {
    if ((errors[id] ?? null) === message) return errors;
    const next = { ...errors };
    if (message === null) delete next[id]; else next[id] = message;
    return next;
  }), []);
  const installedFromTile = (id: string): void => { onInstalled(id); setPicked(id); };
  // with an agent installed, the step lists those; the others wait behind Install another agent, as Settings → Agents has them
  const [moreShown, setMoreShown] = useState(false);
  const others = agents.filter((agent) => !installedHere(agent, ready));
  // a tile stays listed while its install runs or says why it failed: a tile that goes ends its install's watch
  const listed = installed.length === 0 || moreShown ? agents : agents.filter((agent) => installedHere(agent, ready) || installing.includes(agent.id) || agent.id in installErrors);
  const tilesRef = useRef<HTMLUListElement>(null);
  // the link that showed them goes: the first agent it showed takes the keyboard
  useEffect(() => {
    if (moreShown) tilesRef.current?.querySelector<HTMLElement>(".setup-tile[data-missing] button:not(:disabled)")?.focus({ preventScroll: true });
  }, [moreShown]); // eslint-disable-line react-hooks/exhaustive-deps
  // the first workspace opens in the folder this browser used last, else the server's home
  const folder = recentDirectories.read("local")[0] ?? HOME;
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the workspace made, when the agent did not start in it: opening it shows why, in its terminal
  const [madeWithout, setMadeWithout] = useState<string | null>(null);

  // a reply after the screen is gone (Escape, the guide closed in another tab) opens nothing
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const start = async (): Promise<void> => {
    if (madeWithout !== null) { onOpened(madeWithout, false); return; }
    if (opening || chosen === null) return;
    onStarting?.();
    setOpening(true);
    setError(null);
    const launch = newSessionLaunch({ agent: chosen.id, model: "", effort: "", prompt: "" }, settings);
    if ("fault" in launch) { setOpening(false); setError(t("{agent} can't start here. Use the sidebar.", { agent: chosen.name })); return; }
    try {
      const result = await openInFolder((directory) => createWorkspace(createRequest({ tab: null, directory, name: "" }, launch, null)), folder, HOME, (reason) => alive.current && reason instanceof ApiError && reason.code === "invalid_cwd");
      // the guide closed while it was being made (Escape): the workspace is in the sidebar, but nothing is closed or
      // picked for it, as the user may be somewhere else by now, or in a guide opened again
      if (!alive.current) return;
      if (result.agent_started === false) {
        setOpening(false);
        setMadeWithout(result.pane_id);
        setError(t("{agent} didn't start. Its terminal shows why.", { agent: chosen.name }) + (result.error?.message ? ` (${result.error.message})` : ""));
        return;
      }
      onOpened(result.pane_id, true);
    } catch (reason: unknown) {
      if (!alive.current) return;
      setOpening(false);
      setError(userFailure(reason).kind === "unknown" ? t("Couldn't open the workspace.") : userErrorMessage(reason).message);
    }
  };

  const locked = opening || madeWithout !== null;
  // Connect your phone: the relay's QR code, or the page's own and its address, right here
  // open from the start on a first run on the PC, where a phone is the next device to add
  const [phone, setPhoneState] = useState<PhoneBoxOpening | null>(phoneFirst ? "first-run" : null);
  const setPhone = (next: PhoneBoxOpening | null): void => { setPhoneState(next); if (next === null) onPhoneClosed(); };
  const startLabel = madeWithout !== null ? t("Open the workspace") : t("Start");
  const version = chosen?.state.installed === true ? chosen.state.version : null;
  const signInChosen = chosen !== null && unsigned.some((agent) => agent.id === chosen.id);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const drawnSide: Mode = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  const themeSummary = [t(settings.theme === "system" ? "System" : settings.theme === "dark" ? "Dark" : "Light"), drawnThemeName(t, settings, drawnSide)].filter(Boolean).join(" · ");
  // a device other than this browser: paired before the guide (the server's list), or from its box just now.
  // This browser pairing itself (onPaired) is not one
  // read again on each step that shows it, and when Settings closes (a device paired or removed there, opened from the box)
  const pairedBefore = useOtherDevice((page === "phone" || page === "done") && !settingsOpen, page);
  const [alertsFailure, setAlertsFailure] = useState<string | null>(null);
  const [pairedNow, setPairedNow] = useState<string | null>(null);
  // Settings closed: the list read again speaks for the devices, a name kept from the box would outlive its removal there
  const settingsBefore = useRef(settingsOpen);
  useEffect(() => {
    if (settingsBefore.current && !settingsOpen) setPairedNow(null);
    settingsBefore.current = settingsOpen;
  }, [settingsOpen]);
  const phoneName = pairedNow ?? pairedBefore;
  const alertFilters = useAlertFilters();
  // what alerts this computer gets, as Done names them: Settings → Alerts' chips that are on; none while alerts are off or refused
  // Any turn finished takes in the long ones, so the summary names it alone
  const alertKinds = alertMeWhenChips(t, settings, alertFilters, update, true).filter((chip) => chip.on && !(settings.alertDone === "always" && chip.label === t("Long turn finished"))).map((chip) => chip.label);
  // one rule for the step, Done and Setup: N left, from what the PC recorded of this browser's subscription; what the
  // last Turn on alerts came to is a line here only (lib/setupGuideFlow.ts alertsHere; #3894, #3907 reviews)
  const { health, checked, delivered } = usePushHealth();
  const alerts = alertsHere({ alertsOn: settings.alertsOn, notifications, desktop: desktopUpdateBridge() !== null, pushSupported: pushSupported(), pushOn, push: { checked, problem: health.problem, delivered }, confirmed: confirmation(registeredPushEndpoint()) });
  // a look that does not answer is tried again when the page comes back into view and on Try again; past a bound the
  // step and Done say it could not be checked, rather than Checking for ever
  const uncheckable = useLongerThan(alerts === "checking", ALERTS_CHECK_GIVE_UP_MS);
  const alertsDone = alertsSurfaces(alerts).done;
  const alertsSummary = alertsDone === "done" && alertKinds.length > 0 ? alertKinds.join(", ") : null;
  const usageNote = signedIn !== null && signedIn.length > 0 && (settings.showUsage || usageOn) && <p className="setup-note"><Gauge aria-hidden="true" />{t("Your plan usage shows in the sidebar.")}</p>;
  const errorLine = error !== null && <p className="setup-error" role="alert">{error}</p>;
  const signInDialog = signingIn && <UsageSignInDialog request={signingIn} onOpenTerminal={(paneId) => { setSigningIn(null); onOpenTerminal(paneId); }} onSignedIn={() => setSignedHere((done) => [...done, signingIn.provider])} onClose={() => setSigningIn(null)} />;

  // the theme and the phone need no agent (the sidebar's Setup: N left opens the guide at them on a PC with only a
  // shell); Start and Done do
  if (page === "theme") return (
    <>
      <ThemeStep firstFocus={firstFocus}>{errorLine}{notice}</ThemeStep>
      <footer className="modal-footer setup-foot">
        <button type="button" className="btn btn-ghost setup-later" title={t("Reopen it in Settings → Agents.")} onClick={onClose}>{t("Set up later")}</button>
        <button type="button" className="btn" disabled={locked} onClick={() => setPage("agent")}><ChevronLeft aria-hidden="true" />{t("Back")}</button>
        {madeWithout !== null
          ? <button type="button" className="btn btn-primary" onClick={() => void start()}><Play aria-hidden="true" />{t("Open the workspace")}</button>
          : <button type="button" className="btn btn-primary" disabled={locked} onClick={() => setPage("phone")}>{t("Continue")}<ArrowRight aria-hidden="true" /></button>}
      </footer>
    </>
  );

  if (page === "phone") return (
    <>
      <div className="modal-body setup-body">
        <div className="setup-main">
          <StepTitle firstFocus={firstFocus}>{t("Stay in touch")}</StepTitle>
          <AlertsPicture alerts={alerts} phoneName={phoneName} />
          <AlertsHere onEnable={onEnableAlerts} notifications={notifications} alerts={alerts} uncheckable={uncheckable} failure={alertsFailure} onFailure={setAlertsFailure} />
          {errorLine}
          {notice}
        </div>
        <aside className="setup-side setup-side-phone" aria-labelledby="setup-phone-label">
          <span className="setup-label" id="setup-phone-label">{t("On your phone")}</span>
          {phoneName !== null && <p className="setup-paired"><CircleCheck aria-hidden="true" />{t("{name} is connected.", { name: phoneName })}</p>}
          <PhonePanel auth={auth} security={security} onOpenSettings={() => onOpenSettings("devices")} onPaired={onPaired} onPhonePaired={setPairedNow} />
        </aside>
      </div>
      <footer className="modal-footer setup-foot">
        <button type="button" className="btn btn-ghost setup-later" title={t("Reopen it in Settings → Agents.")} onClick={onClose}>{t("Set up later")}</button>
        <button type="button" className="btn" disabled={locked} onClick={() => setPage("theme")}><ChevronLeft aria-hidden="true" />{t("Back")}</button>
        {madeWithout !== null
          ? <button type="button" className="btn btn-primary" onClick={() => void start()}><Play aria-hidden="true" />{t("Open the workspace")}</button>
          : chosen === null
            ? <button type="button" className="btn btn-primary" onClick={onClose}>{t("Done")}</button>
            : <button type="button" className="btn btn-primary" disabled={locked} onClick={() => setPage("done")}>{t("Continue")}<ArrowRight aria-hidden="true" /></button>}
      </footer>
    </>
  );

  if (page === "done" && chosen !== null) return (
    <>
      <div className="modal-body setup-body setup-body-single">
        <div className="setup-main">
          <StepTitle firstFocus={firstFocus}>{t("Ovis is ready")}</StepTitle>
          <p className="setup-lead">{folder === HOME
            ? t("{agent} starts in your home folder.", { agent: chosen.name })
            : t("{agent} starts in {folder}.", { folder, agent: chosen.name })}</p>
          <ul className="setup-list setup-summary">
            <li className="setup-item is-done"><CircleCheck role="img" aria-label={t("Done")} /><span className="setup-summary-row"><span className="setup-summary-name">{t("Agent")}</span><span>{version === null ? chosen.name : `${chosen.name} ${version}`}</span></span></li>
            <li className="setup-item is-done"><CircleCheck role="img" aria-label={t("Done")} /><span className="setup-summary-row"><span className="setup-summary-name">{t("Theme")}</span><span>{themeSummary}</span></span></li>
            <li className={phoneName !== null ? "setup-item is-done" : "setup-item"}>{phoneName !== null ? <CircleCheck role="img" aria-label={t("Done")} /> : <Circle role="img" aria-label={t("Not yet")} />}<span className="setup-summary-row"><span className="setup-summary-name">{t("Phone")}</span>
              {phoneName !== null ? <span>{phoneName}</span> : <span>{t("Later")} <button type="button" className="setup-link" disabled={locked} onClick={() => setPage("phone")}>{t("Connect now")}</button></span>}</span></li>
            <li className={alertsSummary === null ? "setup-item" : "setup-item is-done"}>{alertsSummary === null ? <Circle role="img" aria-label={t("Not yet")} /> : <CircleCheck role="img" aria-label={t("Done")} />}<span className="setup-summary-row"><span className="setup-summary-name">{t("Alerts")}</span><span>{alertsSummary ?? (alertsDone === "checking" ? (uncheckable ? t("Couldn't check alerts.") : t("Checking…")) : t("Alerts off"))}</span></span></li>
          </ul>
          {usageNote}
          {errorLine}
          {notice}
        </div>
      </div>
      <footer className="modal-footer setup-foot">
        <button type="button" className="btn" disabled={locked} onClick={() => setPage("phone")}><ChevronLeft aria-hidden="true" />{t("Back")}</button>
        <button type="button" className="btn btn-primary" disabled={opening} onClick={() => void start()}><Play aria-hidden="true" />{startLabel}</button>
      </footer>
    </>
  );

  return (
    <>
      <div className="modal-body setup-body">
        <div className="setup-main">
          {installed.length > 0 ? (
            <>
              <StepTitle firstFocus={firstFocus}>{t("Pick an agent")}</StepTitle>
              <p className="setup-lead">{t("Found on this PC.")}</p>
            </>
          ) : (
            <>
              <StepTitle firstFocus={firstFocus}>{t("Install an agent")}</StepTitle>
              <p className="setup-lead">{t("Nothing installs until you press Install.")}</p>
            </>
          )}
          <ul ref={tilesRef} className="setup-found" aria-label={t("Agents")}>
            {listed.map((agent) => (
              <AgentTile key={agent.id} agent={agent} has={installedHere(agent, ready)} picked={chosen?.id === agent.id} locked={locked} machineId={machineId}
                onPick={setPicked} onOpenTerminal={onOpenTerminal} onRunning={onRunning} onInstalled={installedFromTile} onError={onInstallError} />
            ))}
          </ul>
          {Object.values(installErrors).map((message) => <p key={message} className="setup-error" role="alert">{message}</p>)}
          {((installed.length > 0 && others.length > 0 && !moreShown) || (!busy && !locked)) && (
            <p className="setup-muted setup-again">
              {installed.length > 0 && others.length > 0 && !moreShown && <button type="button" className="setup-link" onClick={() => setMoreShown(true)}>{t("{count} more agents", { count: others.length })}</button>}
              {!busy && !locked && <span>{t("Installed one already?")} <button type="button" className="setup-link" onClick={onLookAgain}>{t("Look again")}</button></span>}
            </p>
          )}
          {errorLine}
          {notice}
        </div>
        <aside className="setup-side" aria-label={chosen !== null ? chosen.name : t("Agents")}>
          {chosen !== null ? (
            <>
              <div className="setup-agent-head"><AgentMark agent={chosen.id} size={24} /><strong>{chosen.name}</strong></div>
              <ul className="setup-list">
                <li className="setup-item is-done"><CircleCheck aria-hidden="true" /><span>{version === null ? t("Installed") : t("Installed · v{version}", { version })}</span></li>
                {signInChosen && (
                  <li className="setup-item"><KeyRound aria-hidden="true" /><span>{t("{agent} needs a sign-in.", { agent: chosen.name })}{" "}
                    <button type="button" className="setup-link" disabled={locked} onClick={() => setSigningIn({ provider: chosen.id as "claude" | "codex", default: true })}>{t("Sign in to {agent}", { agent: chosen.name })}</button></span></li>
                )}
                <li className="setup-item"><Folder aria-hidden="true" /><span>{folder === HOME ? t("Starts in your home folder.") : t("Starts in {folder}.", { folder })}</span></li>
              </ul>
              {usageNote}
            </>
          ) : (
            <>
              <p className="setup-muted">{t("Install one to begin.")}</p>
              {/* with nothing installed there is no Done yet: the phone can be connected from here meanwhile */}
              <span className="setup-label" id="setup-phone-label">{t("On your phone")}</span>
              <div className="setup-actions">
                <button type="button" className="btn" aria-expanded={phone !== null} onClick={() => setPhone(phone === null ? "tap" : null)}><Smartphone aria-hidden="true" />{t("Connect your phone")}</button>
              </div>
              {phone !== null && <PhoneBox opening={phone} auth={auth} security={security} onOpenSettings={() => { setPhone(null); onOpenSettings("devices"); }} onPaired={onPaired} onPhonePaired={setPairedNow} onWithdraw={() => setPhone(null)} />}
            </>
          )}
        </aside>
      </div>
      <footer className="modal-footer setup-foot">
        <button type="button" className="btn btn-ghost setup-later" title={t("Reopen it in Settings → Agents.")} onClick={onClose}>{t("Set up later")}</button>
        {madeWithout !== null
          ? <button type="button" className="btn btn-primary" onClick={() => void start()}><Play aria-hidden="true" />{t("Open the workspace")}</button>
          : <button type="button" className="btn btn-primary" disabled={chosen === null || locked || busy} onClick={() => { armUsage(); setPage("theme"); }}>{t("Continue")}<ArrowRight aria-hidden="true" /></button>}
      </footer>
      {signInDialog}
    </>
  );
}

/** The guide's steps; Done ends the list. */
type GuidePage = "agent" | "theme" | "phone" | "done";
interface StepState { page: GuidePage; setPage: (page: GuidePage) => void }
const STEPS: readonly Exclude<GuidePage, "done">[] = ["agent", "theme", "phone"];

/**
 * The head's step bar, as Orca's: a thin segment per step this user will see (Done only with an agent to start) and
 * "n / N"; the one shown is current, the ones before it done. Each segment keeps its step's name for a screen reader.
 * `agent`: an agent is installed here; the Agent step is not marked done without one (a guide reopened at a later step)
 */
function StepList({ page, agent }: { page: GuidePage; agent: boolean }) {
  const t = useT();
  const pages: readonly GuidePage[] = agent ? [...STEPS, "done"] : STEPS;
  const at = Math.max(0, pages.indexOf(page));
  const done = (step: GuidePage, index: number): boolean => index < at && (step !== "agent" || agent);
  const labels: Record<GuidePage, string> = { agent: t("Agent"), theme: t("Theme"), phone: t("Phone and alerts"), done: t("Done") };
  return (
    <div className="setup-steps-bar">
      <ol className="setup-steps" aria-label={t("Steps")}>
        {pages.map((step, index) => (
          <li key={step} className={done(step, index) ? "is-done" : index === at ? "is-current" : undefined} aria-current={index === at ? "step" : undefined}>
            <span className="visually-hidden">{labels[step]}</span>
          </li>
        ))}
      </ol>
      <span className="setup-steps-count" aria-hidden="true">{at + 1} / {pages.length}</span>
    </div>
  );
}

/**
 * A miniature of the app with made-up work in it: three agents in a sidebar (waiting, working, done), a chat turn
 * with code and a line of terminal. It is drawn in the page's own colours, and the theme step's picks change the
 * page's, so it always shows the theme chosen. A picture: nothing in it can be reached or read out.
 */
function ThemePreview() {
  const t = useT();
  const rows = [
    { agent: "claude", name: "checkout-api", status: "blocked" },
    { agent: "codex", name: "web-dashboard", status: "working" },
    { agent: "opencode", name: "docs-site", status: "done" },
  ] as const;
  return (
    <div className="setup-preview" aria-hidden="true" inert>
      <div className="setup-preview-side">
        {rows.map((row, index) => (
          <div key={row.name} className={index === 0 ? "setup-preview-row is-selected" : "setup-preview-row"}>
            <AgentMark agent={row.agent} size={14} />
            <span className="setup-preview-name">{row.name}</span>
            <span className={`badge badge-${row.status} sidebar-status`} data-status={row.status}>
              {row.status === "blocked" ? <span className="sidebar-status-mark">?</span> : <span className="sidebar-status-dot" />}
            </span>
          </div>
        ))}
      </div>
      <div className="setup-preview-pane">
        <div className="setup-preview-head">
          <span className="setup-preview-title"><AgentMark agent="claude" size={14} />{t("Idempotent payments")}</span>
          <span className="setup-preview-lens"><span className="is-on">{t("Chat")}</span><span>{t("Terminal")}</span></span>
        </div>
        <div className="setup-preview-chat">
          <p className="setup-preview-user">{t("Nice. Now add a metric for replayed requests.")}</p>
          <p>{t("Adding a counter next to the existing request metrics.")}</p>
          <pre className="setup-preview-code"><span className="is-keyword">const</span> replays = <span className="is-function">counter</span>(<span className="is-string">"replays_total"</span>);{"\n"}replays.<span className="is-function">inc</span>({"{ route }"});</pre>
        </div>
        <pre className="setup-preview-term"><span className="is-dim">$</span> bun test metrics{"\n"}<span className="is-pass">12 pass</span> · 0 fail</pre>
      </div>
    </div>
  );
}

/**
 * The alerts of this computer, in the phone and alerts step: Turn on alerts while the browser has not been asked,
 * the chips of Settings → Alerts' Alert me when (the same settings), and Send test, which shows one alert here at
 * once. The test is the page's own notification, as an open tab of Ovis shows its alerts, so it works in the
 * desktop app too, where web push does not reach; Settings → Alerts' test goes through the push service.
 */
function AlertsHere({ onEnable, notifications: state, alerts, uncheckable, failure, onFailure }: { onEnable: () => Promise<PushActionResult>; notifications: NotificationState; alerts: AlertsAnswer; uncheckable: boolean; failure: string | null; onFailure: (text: string | null) => void }) {
  const t = useT();
  const { settings, update } = useSettings();
  const filters = useAlertFilters();
  const [busy, setBusy] = useState<"enable" | "test" | null>(null);
  const [line, setLine] = useState<"sent" | "failed" | null>(null);
  const enable = async (): Promise<void> => {
    setBusy("enable");
    onFailure(null);
    // what Turn on alerts reports back: a push subscription that failed is said, as Settings → Alerts says it, and
    // the button stays to try again; alerts are not on while only an open tab could show them
    try {
      const result = await onEnable();
      // the desktop app shows its own notifications: only a refused permission keeps alerts off there (#3907 review)
      if (alertsFailed(result, desktopUpdateBridge() !== null) === false) { onFailure(null); return; }
      // still refused: the line says so, rather than the button doing nothing (#3894 review)
      onFailure(alertsFailureText(t, result));
    } finally { setBusy(null); }
  };
  const test = async (): Promise<void> => {
    setBusy("test");
    setLine(null);
    try { setLine(await showTestNotification(t("Test alert"), t("This is how alerts look.")) ? "sent" : "failed"); } finally { setBusy(null); }
  };
  const shown = alertsSurfaces(alerts).step;
  const on = shown === "send-test";
  return (
    <div className="setup-field setup-alerts">
      {shown === "note" ? <p className="setup-note"><Info aria-hidden="true" />{t("This address can't get alerts.")}</p>
        : state === "denied" ? (
          <>
            <p className="setup-note setup-note-blocked"><TriangleAlert aria-hidden="true" /><span><strong>{t("Alerts are blocked.")}</strong> {inNativeApp() ? t("Allow them in the phone's Settings.") : t("Allow them in your browser settings.")}</span></p>
            {/* the try again: the browser's answer is read anew */}
            <div className="setup-actions">
              <button type="button" className="btn" disabled={busy !== null} onClick={() => void enable()}><Bell aria-hidden="true" />{busy === "enable" ? t("Turning alerts on…") : t("Try again")}</button>
            </div>
          </>
        ) : shown === "checking" ? <AlertsChecking uncheckable={uncheckable} onRetry={() => void refreshPushHealth(true)} />
        : !on && (
          <div className="setup-actions">
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void enable()}><Bell aria-hidden="true" />{busy === "enable" ? t("Turning alerts on…") : t("Turn on alerts")}</button>
          </div>
        )}
      {/* Settings → Alerts' own chips, but Stopped on an error, which stays there */}
      <ChipToggles label={t("Alert me when")} chips={alertMeWhenChips(t, settings, filters, update, false)} />
      {on && pageNotifications() && (
        <div className="setup-actions">
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void test()}><BellRing aria-hidden="true" />{busy === "test" ? t("Sending…") : t("Send test")}</button>
        </div>
      )}
      {/* always in the document, empty until there is something to say: a live region */}
      <p className="setup-muted" role="status">{failure !== null ? failure : line === "sent" ? t("Sent. Check your screen.") : line === "failed" ? t("Couldn't send the test.") : null}</p>
    </div>
  );
}

/** How many of a side's own themes show before Show all themes: two rows of three. */
const THEMES_FIRST = 6;

/**
 * The theme step: the mode (System, Light, Dark, as Settings → Appearance has it) and the theme of the side drawn
 * now. A pick changes the whole app at once, the dialog and the app behind it, so the app itself is the preview;
 * the side panel shows the chosen theme larger. The theme is a shared setting: every device of this Ovis takes it.
 */
/** What Turn on alerts came to, as Settings → Alerts says it; null when alerts are on. */
function alertsFailureText(t: Translate, result: PushActionResult): string | null {
  if (result === "sent") return null;
  if (result === "permission") return inNativeApp() ? t("Allow them in the phone's Settings.") : t("Allow them in your browser settings.");
  if (result === "gone") return t("Alerts stopped here. Turn them on again.");
  if (result === "failed") return t("Couldn't send the test.");
  if (result === "unsupported") return t("This address can't get alerts.");
  return repairFailureText(t, result) ?? t("Couldn't send the test.");
}

/** The theme drawn on a side, by its name: a built-in one's, or an imported one's as Settings names it; null when an imported one is gone. */
function drawnThemeName(t: Translate, settings: Settings, side: Mode): string | null {
  if (settings.customThemes[side] === null) return t(THEME_NAMES[side === "dark" ? settings.darkTheme : settings.lightTheme]);
  const imported = chosenTheme(settings.customThemes, side);
  return imported === undefined ? null : themeLabel(t, imported, settings.customThemes.themes);
}

function ThemeStep({ firstFocus, children }: { firstFocus: FirstFocus; children: ReactNode }) {
  const t = useT();
  const { settings, update } = useSettings();
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const side: Mode = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  const [all, setAll] = useState(false);
  const cards = useRef<HTMLDivElement>(null);
  // an imported theme drawn on this side has no card here: none is checked, and a pick replaces it, as in Settings
  const current: ThemeId | null = settings.customThemes[side] === null ? (side === "dark" ? settings.darkTheme : settings.lightTheme) : null;
  const own = THEME_IDS.filter((id) => rowFor(id, side).mode === side);
  const others = THEME_IDS.filter((id) => rowFor(id, side).mode !== side);
  // a theme saved outside the first six keeps its card for as long as the step is open, though the keyboard moves off it
  // kept per side: a theme kept on the dark side is no stray card in the light list (#3894 review)
  const keptBySide = useRef(new Map<Mode, Set<ThemeId>>());
  const kept = keptBySide.current.get(side) ?? new Set<ThemeId>();
  keptBySide.current.set(side, kept);
  if (current !== null && !own.slice(0, THEMES_FIRST).includes(current)) kept.add(current);
  const shown = all ? [...own, ...others] : own.slice(0, THEMES_FIRST).concat([...own.slice(THEMES_FIRST), ...others].filter((id) => kept.has(id)));
  const pick = (id: ThemeId): void => update((latest) => ({ ...pickTheme(latest, side, id), customThemes: { ...latest.customThemes, [side]: null } }));
  // a radio group's arrows pick as they move
  const step = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0 && event.key !== "Home" && event.key !== "End") return;
    // the cards are `shown`, in its order
    const list = [...(cards.current?.querySelectorAll<HTMLElement>("[data-theme-card]") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? shown.length - 1 : (at + delta + shown.length) % shown.length;
    event.preventDefault();
    const id = shown[next];
    if (id !== undefined) pick(id);
    list[next]?.focus();
  };
  // the link that showed them goes: the first theme it showed takes the keyboard, as Install another agent's do
  const allBefore = useRef(all);
  useEffect(() => {
    if (allBefore.current === all) return;
    allBefore.current = all;
    const first = shown.find((id) => !own.slice(0, THEMES_FIRST).includes(id) && id !== current);
    if (first !== undefined) cards.current?.querySelector<HTMLElement>(`[data-theme-card="${first}"]`)?.focus({ preventScroll: false });
  }, [all]); // eslint-disable-line react-hooks/exhaustive-deps
  // the computer switching between light and dark under System redraws the other side's cards: a card that had the
  // keyboard and is gone hands it to the new side's checked card, or its first (#3885 review)
  const cardsHadFocus = useRef(false);
  const sideBefore = useRef(side);
  useLayoutEffect(() => {
    if (sideBefore.current === side) return;
    sideBefore.current = side;
    const group = cards.current;
    if (!cardsHadFocus.current || group === null || group.contains(document.activeElement)) return;
    (group.querySelector<HTMLElement>("[aria-checked='true']") ?? group.querySelector<HTMLElement>("[data-theme-card]"))?.focus();
  }, [side]);
  const sideLabel = t(side === "dark" ? "Dark theme" : "Light theme");
  return (
    <div className="modal-body setup-body">
      <div className="setup-main">
        <StepTitle firstFocus={firstFocus}>{t("Pick a look")}</StepTitle>
        <p className="setup-lead">{t("Change it later in Settings.")}</p>
        <div className="setup-field">
          <span className="setup-label" aria-hidden="true">{t("Theme")}</span>
          <Segmented label={t("Theme")} value={settings.theme} onChange={(theme) => update({ theme })} options={[{ value: "system", label: t("System") }, { value: "light", label: t("Light") }, { value: "dark", label: t("Dark") }]} />
          <p className="setup-muted">{settings.theme === "system" ? t(side === "dark" ? "Follows this computer. It is dark now." : "Follows this computer. It is light now.") : t("Every device gets this theme.")}</p>
        </div>
        <div className="setup-field">
          <span className="setup-label" aria-hidden="true">{sideLabel}</span>
          <div ref={cards} className="setup-theme-cards" role="radiogroup" aria-label={sideLabel} onKeyDown={step} onFocus={() => { cardsHadFocus.current = true; }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== null) cardsHadFocus.current = false; }}>
            {shown.map((id, index) => <ThemeCard key={id} card={id} name={t(THEME_NAMES[id])} row={rowFor(id, side)} side={side} checked={current === id} focusable={current === null ? index === 0 : current === id} onPick={() => pick(id)} />)}
          </div>
          {!all && <button type="button" className="setup-link" onClick={() => setAll(true)}>{t("Show all themes")}</button>}
        </div>
        {children}
      </div>
      <aside className="setup-side" aria-labelledby="setup-theme-preview">
        <span className="setup-label" id="setup-theme-preview">{t("Preview")}</span>
        <ThemePreview />
        <p className="setup-text">{[t(side === "dark" ? "Dark" : "Light"), drawnThemeName(t, settings, side)].filter(Boolean).join(" · ")}</p>
      </aside>
    </div>
  );
}

/** how often the guide looks for a phone that paired with the code it shows */
const PAIRING_POLL_MS = 3000;
// this browser paired itself from the guide on this page: a box opened again shows the QR (and says
// so) even before the app's access facts catch up
let pairedHere = false;

// the guide's code request, while it is out: a box closed and opened again joins it instead of
// sending a second one (each new code replaces the server's pending one)
let pairingOut: Promise<PairingCode> | null = null;
const guidePairingCode = (): Promise<PairingCode> => pairingOut ??= startPairing().finally(() => { pairingOut = null; });

interface PhoneBoxProps {
  /** a tap, or by itself on a first run on the PC (phoneBoxStays) */
  opening: PhoneBoxOpening;
  /** a box that came open by itself where the relay cannot lead: it closes again */
  onWithdraw: () => void;
  auth: HealthAuth | null;
  security: SecurityFacts;
  onOpenSettings: () => void;
  /** this browser paired itself: the app reads its access again */
  onPaired: () => void;
  /** another device paired with the code shown here: its name */
  onPhonePaired: (name: string) => void;
}

/**
 * Connect your phone: the Ovis relay first where it can lead here (phoneWay), with a quiet way to the
 * page's own QR code and address (PhoneQr), which is all the box shows where the relay cannot lead.
 * The relay is asked about only while the box is open.
 */
function PhoneBox({ opening, onWithdraw, auth, security, onOpenSettings, onPaired, onPhonePaired }: PhoneBoxProps) {
  const t = useT();
  const relay = useRelay();
  // Use Tailscale or Wi-Fi instead: the other ways, until the box is closed (a tap of its own)
  const [other, setOther] = useState(false);
  const way = other ? "other" : phoneWay(relay, inRelayShell(), auth);
  // the relay led in this box once (phoneBoxStays)
  const led = useRef(false);
  if (way === "relay") led.current = true;
  const stays = phoneBoxStays(other ? "tap" : opening, way, led.current);
  useEffect(() => { if (!stays) onWithdraw(); }, [stays]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!stays) return null;
  // the relay's first answer may never come (it keeps failing): the other ways stay one tap away meanwhile
  if (way === "wait") return (
    <div className="setup-phone-relay">
      <p className="setup-muted"><LoaderCircle aria-hidden="true" className="setup-spin" /></p>
      <button type="button" className="setup-link setup-phone-other" onClick={() => setOther(true)}>{t("Use Tailscale or Wi-Fi instead")}</button>
    </div>
  );
  if (way === "other") return <PhoneQr auth={auth} onOpenSettings={onOpenSettings} onPaired={onPaired} onPhonePaired={onPhonePaired} />;
  // as Settings → Phone works it out: the relay closes a gate still open with no token set (server/relay/service.ts)
  const closesGate = security.state === "known" && security.summary.pairing_gate === "open" && !security.summary.token_configured;
  return <RelayBox relay={relay} auth={auth} closesGate={closesGate} onPaired={onPaired} onPhonePaired={onPhonePaired} onOther={() => setOther(true)} />;
}

/**
 * The relay's part of Connect your phone: one line on what it does and the button that turns it on (the
 * user's tap is the consent), its state while it connects, a start that failed with Try again, and its
 * pairing QR code once it is online (RelayPairing, as Settings shows it). Turning it on closes a device
 * gate still open, which would shut out a browser in only because nothing is paired yet (auth via
 * "open": a LAN or tailnet address, never the PC's loopback), so that browser pairs itself first.
 */
function RelayBox({ relay, auth, closesGate, onPaired, onPhonePaired, onOther, onBusy, tight = false }: { relay: RelayState; auth: HealthAuth | null; closesGate: boolean; onPaired: () => void; onPhonePaired: (name: string) => void; onOther?: () => void; onBusy?: (busy: boolean) => void; tight?: boolean }) {
  const t = useT();
  const { status, pending, request } = relay;
  const [turning, setTurning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairedSelf, setPairedSelf] = useState(false);
  // a start under way may close the device gate and spend a code another way shows: the step's tabs wait for it
  const starting = pending || turning;
  useEffect(() => { onBusy?.(starting); }, [starting]); // eslint-disable-line react-hooks/exhaustive-deps
  if (status === null) return null;
  const step = relayStep(status);
  const busy = pending || turning;
  const start = async (): Promise<void> => {
    if (busy) return;
    setTurning(true);
    setError(null);
    try {
      if (auth?.via === "open" && !pairedHere) {
        await pairThisBrowser();
        pairedHere = true;
        setPairedSelf(true);
        onPaired();
      }
      await request("start");
    } catch (reason: unknown) {
      setError(reason instanceof UnconfirmedPairing ? t("Couldn't connect this browser. Turn on cookies.") : failureText(reason));
    } finally { setTurning(false); }
  };
  return (
    <div className="setup-phone-relay">
      {step === "off" && (
        <>
          {!tight && <p className="setup-phone-relay-lead">{t("Reach this PC from anywhere.")}</p>}
          {closesGate && <p className="setup-muted">{t("New browsers will then need a code.")}</p>}
          <div className="setup-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void start()}><Smartphone aria-hidden="true" />{t("Turn on")}</button>
          </div>
        </>
      )}
      {step === "starting" && <p className="setup-muted setup-phone-relay-state" role="status">{status.phase === "connecting" && <LoaderCircle aria-hidden="true" className="setup-spin" />}{statusText(t, status)}</p>}
      {step === "not-started" && (
        <>
          <p className="setup-error" role="alert">{t("Couldn't turn it on: {message}", { message: status.error ?? "" })}</p>
          <div className="setup-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void start()}><RotateCw aria-hidden="true" />{t("Try again")}</button>
          </div>
        </>
      )}
      {step === "online" && (tight ? <TightRelayQr onPhonePaired={onPhonePaired} /> : <RelayQr onPhonePaired={onPhonePaired} />)}
      {pairedSelf && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("This browser is connected first.")}</span>}
      {/* a failed start's reason shows once, in its own line, when the relay says it did not start; any other failure (a retry's own pairing) shows here */}
      {error !== null && (step !== "not-started" || error !== status.error) && <p className="setup-error" role="alert">{error}</p>}
      {/* not while the relay starts: its start closes the gate, which would spend the other way's pairing code */}
      {onOther !== undefined && <button type="button" className="setup-link setup-phone-other" disabled={busy} onClick={onOther}>{t("Use Tailscale or Wi-Fi instead")}</button>}
    </div>
  );
}

/**
 * The relay's pairing QR code in the guide (RelayPairing, as Settings shows it), and the phone that
 * used it: its code is single-use, so once a new device is listed the QR gives way to Paired and New
 * code, as the address QR does (PhoneQr). Devices listed when it opened are the ones before it.
 */
function RelayQr({ onPhonePaired }: { onPhonePaired: (name: string) => void }) {
  const t = useT();
  const [paired, setPaired] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (paired !== null) return;
    let live = true;
    let asked = false;
    let known: ReadonlySet<string> | null = null;
    const look = (): void => {
      if (asked) return;
      asked = true;
      void fetchDevices().then((devices) => {
        if (!live) return;
        if (known === null) { known = new Set(devices.map((device) => device.id)); return; }
        const fresh = devices.find((device) => !known!.has(device.id));
        if (fresh !== undefined) { setPaired(fresh.label); onPhonePaired(fresh.label); }
      }, () => { /* asked again on the next turn */ }).finally(() => { asked = false; });
    };
    look();
    const poll = window.setInterval(look, PAIRING_POLL_MS);
    return () => { live = false; window.clearInterval(poll); };
  }, [paired]); // eslint-disable-line react-hooks/exhaustive-deps
  if (paired !== null) return (
    <p className="setup-phone-relay-state">
      <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("Paired: {name}.", { name: paired })}</span>{" "}
      <button type="button" className="setup-link" onClick={() => { setPaired(null); setRound((count) => count + 1); }}>{t("New code")}</button>
    </p>
  );
  return <RelayPairing key={round} />;
}

/**
 * Connect your phone, right in the guide: a QR code that opens this app on the phone with a fresh
 * pairing code filled in, and the address beside it (phoneBoxMode). A browser in only because nothing
 * is paired yet pairs itself first, as Settings → Phone's Pair this device now does, so the phone
 * paired next does not shut it out. Settings → Phone takes over where this page has no address a
 * phone can open (the PC's own loopback) or the server does not say how this browser got in.
 */
function PhoneQr({ auth, onOpenSettings, onPaired, onPhonePaired, given, large = false, shown = true }: { auth: HealthAuth | null; onOpenSettings: () => void; onPaired: () => void; onPhonePaired: (name: string) => void; given?: string; large?: boolean; shown?: boolean }) {
  const t = useT();
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetchRemoteAccess().then((answer) => { if (live) setAccess(answer); }, () => { if (live) setAccess(null); });
    return () => { live = false; };
  }, []);
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext, shell: inRelayShell() }, access ?? null);
  // where a phone can open this app now, as Settings → Phone works it out
  const address = given ?? (access === undefined ? undefined : plan.kind === "here" || plan.kind === "served" ? plan.url : isLoopbackHost(window.location.hostname) ? null : window.location.origin);
  // the QR, this browser paired first, or Settings → Phone (phoneBoxMode); once paired here, the QR
  // even before the app reads its access again
  const mode = phoneBoxMode(address, pairedHere && auth?.via === "open" ? { ...auth, via: "device" } : auth);
  useEffect(() => { if (mode === "settings") onOpenSettings(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // a pairing code for the QR, asked for by the user each time (opening the box, New code): never
  // renewed behind their back, where it would replace a code Settings → Phone shows. Used by a phone
  // (a device paired since) or run out, it is gone.
  const [code, setCode] = useState<PairingCode | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const [asking, setAsking] = useState(0);
  // a code request out: New code waits for it (a second one could replace the code the first shows)
  const [requesting, setRequesting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // this browser paired itself first (it was in only because nothing was paired yet)
  const [agreed, setAgreed] = useState(false);
  // hidden behind another way's tab: the PC keeps one pairing code at a time, and that way (or Settings) may replace
  // this one, so its code goes, and its device check with it; back in view, New code asks for one on a press
  // a phone that paired while it was hidden is said once it is shown again (one read of the devices)
  const dropped = useRef(false);
  const shownNow = useRef(shown);
  shownNow.current = shown;
  useEffect(() => {
    if (!shown) { if (code !== null) dropped.current = true; setCode(null); return; }
    if (!dropped.current) return;
    dropped.current = false;
    let live = true;
    fetchDevices().then((devices) => {
      const fresh = devices.find((device) => !(before.current?.has(device.id) ?? true));
      if (live && fresh !== undefined) { setPaired(fresh.label); onPhonePaired(fresh.label); }
    }, () => { /* unknown: New code stays offered */ });
    return () => { live = false; };
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = mode === "qr" || (mode === "pair-self" && (!large || pairedHere || agreed));
  // the devices paired before this code: a new id among them later is the phone that used it
  const before = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    setRequesting(true);
    setFailure(null);
    // read before the code and right after it: a device that paired in between used an older code
    // (one Settings showed); one missed this way only goes unconfirmed, never claimed wrongly
    void (async () => {
      if (mode === "pair-self" && !pairedHere) {
        await pairThisBrowser();
        pairedHere = true;
        onPaired();
      }
      const first = await fetchDevices();
      // closed or asked again meanwhile: no code requested for a box nobody sees
      if (!live) return;
      const fresh = await guidePairingCode();
      const after = await fetchDevices();
      // hidden meanwhile: another way may take a newer code, so this answer is not shown later (#3970)
      if (!live || !shownNow.current) return;
      before.current = new Set([...first, ...after].map((device) => device.id));
      setCode(fresh);
    })().catch((error: unknown) => { if (live) { setCode(null); setFailure(error instanceof UnconfirmedPairing ? t("Couldn't connect this browser. Turn on cookies.") : userFailure(error).kind === "unknown" ? t("Couldn't make a code. Try again.") : userErrorMessage(error).message); } }).finally(() => { if (live) setRequesting(false); });
    return () => { live = false; };
  }, [ready, asking]);
  useEffect(() => {
    if (code === null) return;
    let live = true;
    let asked = false;
    const expiry = window.setTimeout(() => { if (live) setCode(null); }, Math.max(0, Date.parse(code.expires_at) - Date.now()));
    // a phone that paired with it: said, and the code is spent (one read at a time)
    const look = (): void => {
      if (asked) return;
      asked = true;
      void fetchDevices().then((devices) => {
        if (!live) return;
        const fresh = devices.find((device) => !(before.current?.has(device.id) ?? true));
        if (fresh !== undefined) { setPaired(fresh.label); setCode(null); onPhonePaired(fresh.label); }
      }, () => { /* asked again on the next turn */ }).finally(() => { asked = false; });
    };
    look();
    const poll = window.setInterval(look, PAIRING_POLL_MS);
    return () => { live = false; window.clearTimeout(expiry); window.clearInterval(poll); };
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  if (large && mode === "pair-self" && !pairedHere && !agreed) return (
    <div className="setup-method-step">
      <p className="setup-text">{t("New browsers will then need a code.")}</p>
      <div><button type="button" className="btn" onClick={() => setAgreed(true)}>{t("Show QR code")}</button></div>
    </div>
  );
  if (!ready || typeof address !== "string") return <p className="setup-muted"><LoaderCircle aria-hidden="true" className="setup-spin" /></p>;
  // the line under the address: the paired phone, this browser paired first, or what failed
  const value = code === null ? address : `${address.replace(/\/$/, "")}/?pair=${code.code}`;
  if (large) return (
    <QrPanel value={value} label={code === null ? t("Open this address on your phone") : t("QR code that pairs a phone with code {code}", { code: code.code })} address={address}>
      {paired !== null && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("Paired: {name}.", { name: paired })}</span>}
      {pairedHere && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("This browser is connected first.")}</span>}
      {failure !== null && <span className="setup-error" role="alert">{failure}</span>}
      {code === null && <button type="button" className="btn" aria-disabled={requesting || undefined} onClick={() => { if (requesting) return; setPaired(null); setAsking((count) => count + 1); }}><RefreshCw aria-hidden="true" />{failure !== null ? t("Try again") : t("New code")}</button>}
    </QrPanel>
  );
  return (
    <div className="setup-phone-qr">
      <QrCode value={value} label={code === null ? t("Open this address on your phone") : t("QR code that pairs a phone with code {code}", { code: code.code })} size={136} />
      <div className="setup-phone-qr-text">
        {paired !== null && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("Paired: {name}.", { name: paired })}</span>}
        {pairedHere && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("This browser is connected first.")}</span>}
        {failure !== null && <span className="setup-error" role="alert">{failure}</span>}
        <span>{t("Open this address on your phone")}</span>
        <code>{address}</code>
        {code !== null ? <span>{t("Pairing code")} <strong>{code.code}</strong></span>
          : <button type="button" className="setup-link" aria-disabled={requesting || undefined} onClick={() => { if (requesting) return; setPaired(null); setAsking((count) => count + 1); }}>{t("New code")}</button>}
      </div>
    </div>
  );
}

/** Over the pane while the guide stands aside for a tab the user opened from it. */
export function SetupGuideResume({ onResume }: { onResume: () => void }) {
  const t = useT();
  return (
    <p className="setup-resume" role="status">
      <span>{t("Setup isn't finished.")}</span>
      <button type="button" className="btn btn-ghost" onClick={onResume}>{t("Back to setup")}</button>
    </p>
  );
}

// ---- the phone's side of the phone and alerts step: the app, the way to connect, its QR code ----

/** The App Store and Google Play pages of the Ovis app. */
const STORES = {
  "app-store": { url: "https://apps.apple.com/app/id6824664162", badge: `${import.meta.env.BASE_URL}store-badges/app-store-en.svg`, width: 120, height: 40 },
  "google-play": { url: "https://play.google.com/store/apps/details?id=sh.ovis.app", badge: "google-play", width: 135, height: 52 },
} as const;
type Store = keyof typeof STORES;
type PhoneMethod = "relay" | "wifi" | "tailscale";

/** Google Play's badge in the app's language (its own artwork per language); the App Store's is the US one. */
function badgeSrc(store: Store, language: string): string {
  if (store === "app-store") return STORES["app-store"].badge;
  const lang = language.startsWith("ko") ? "ko" : language.startsWith("ja") ? "ja" : language.startsWith("zh") ? "zh-cn" : "en";
  return `${import.meta.env.BASE_URL}store-badges/google-play-${lang}.png`;
}

/**
 * A private IPv4 LAN address or a .local name this page was opened at (a phone on the same Wi-Fi opens it too), else
 * null. Deliberately narrow: an IPv6 link-local address needs a zone a phone's browser cannot type, and a bare machine
 * name may not resolve on a phone; those pages keep the line that sends the user to another way.
 */
function wifiAddress(): string | null {
  const host = window.location.hostname;
  const lan = /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local");
  return lan ? window.location.origin : null;
}

/** A large QR code with the address under it, a copy button and what the phone's camera does with it. */
function QrPanel({ value, label, address, scanLine, children }: { value: string; label: string; address: string; scanLine?: string; children?: ReactNode }) {
  const t = useT();
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="setup-qr-panel">
      <QrCode value={value} label={label} size={168} />
      <div className="setup-qr-panel-text">
        <p className="setup-qr-scan">{scanLine ?? t("Scan with your phone's camera.")}</p>
        <div className="setup-qr-address">
          <code>{address}</code>
          <button type="button" className="icon-button" aria-label={t("Copy address")} title={t("Copy address")} onClick={() => void copyText(address).then(setCopied)}><Copy aria-hidden="true" /></button>
        </div>
        {children}
        <span className="setup-muted" role="status">{copied === true ? t("Copied") : null}</span>
      </div>
    </div>
  );
}

/**
 * The relay's QR code in the step, tight: the QR code and its one line; New code, a link without a code, a code to
 * type and this PC's ID wait behind Other ways, which takes the QR code's place rather than making the step taller.
 */
function TightRelayQr({ onPhonePaired }: { onPhonePaired: (name: string) => void }) {
  const t = useT();
  const [more, setMore] = useState(false);
  return (
    <div className={more ? "setup-relay-tight is-more" : "setup-relay-tight"}>
      <RelayQr onPhonePaired={onPhonePaired} />
      <button type="button" className="setup-link setup-relay-more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? t("Back to QR") : t("Other ways")}</button>
    </div>
  );
}

/** A store's page as a QR code (the user is at a PC: the phone scans it), and its link in a new tab. */
function StoreQr({ store }: { store: Store }) {
  const t = useT();
  const { url } = STORES[store];
  const name = store === "app-store" ? "App Store" : "Google Play";
  return (
    <QrPanel value={url} label={t("QR code that opens {store}", { store: name })} address={url} scanLine={t("Scan to open {store}.", { store: name })}>
      <a className="setup-link" href={url} target="_blank" rel="noreferrer noopener">{t("Open {store}", { store: name })} <ExternalLink aria-hidden="true" /></a>
    </QrPanel>
  );
}

/** The two store badges: each shows its store's QR code (`shown`), as the method buttons show theirs. */
function StoreBadges({ shown, onShow }: { shown: Store | null; onShow: (store: Store) => void }) {
  const t = useT();
  const { settings } = useSettings();
  const language = settings.language === "system" ? navigator.language : settings.language;
  return (
    <div className="setup-stores">
      {(["app-store", "google-play"] as const).map((store) => (
        <button key={store} type="button" className="setup-store" aria-pressed={shown === store} onClick={() => onShow(store)}>
          <img src={badgeSrc(store, language)} alt={store === "app-store" ? t("Download on the App Store") : t("Get it on Google Play")} width={STORES[store].width} height={STORES[store].height} />
        </button>
      ))}
    </div>
  );
}

interface MethodProps {
  auth: HealthAuth | null;
  security: SecurityFacts;
  onOpenSettings: () => void;
  onPaired: () => void;
  onPhonePaired: (name: string) => void;
  /** the relay is starting (Turn on pressed, its answer not in yet): the other ways wait, as they did beside it before */
  onRelayBusy?: (busy: boolean) => void;
}

/** What a method shows once picked: its QR code, or the one step it needs first, or why it cannot here. Nothing starts until its own button is pressed. */
function MethodPanel({ method, shown = true, ...props }: MethodProps & { method: PhoneMethod; shown?: boolean }) {
  const t = useT();
  const relay = useRelay();
  // each return into view after another way was shown: the PC keeps one pairing code, which that way may have
  // replaced, so the relay's box is drawn afresh and asks for an offer carrying the PC's current code
  const [returns, setReturns] = useState(0);
  const wasShown = useRef(shown);
  useEffect(() => {
    if (shown && !wasShown.current) setReturns((count) => count + 1);
    wasShown.current = shown;
  }, [shown]);
  if (method === "relay") {
    if (phoneWay(relay, inRelayShell(), props.auth) === "other") return <p className="setup-note"><Info aria-hidden="true" />{t("Not available on this PC.")}</p>;
    if (relay.status === null) return <p className="setup-muted"><LoaderCircle aria-hidden="true" className="setup-spin" /></p>;
    const closesGate = props.security.state === "known" && props.security.summary.pairing_gate === "open" && !props.security.summary.token_configured;
    return <RelayBox key={returns} tight relay={relay} auth={props.auth} closesGate={closesGate} onPaired={props.onPaired} onPhonePaired={props.onPhonePaired} onBusy={props.onRelayBusy} />;
  }
  if (method === "wifi") {
    const address = wifiAddress();
    if (address === null) return <p className="setup-note"><Info aria-hidden="true" />{t("No Wi-Fi address to show here. Use Anywhere instead.")}</p>;
    return <PhoneQr given={address} large shown={shown} auth={props.auth} onOpenSettings={props.onOpenSettings} onPaired={props.onPaired} onPhonePaired={props.onPhonePaired} />;
  }
  return <TailscaleMethod shown={shown} {...props} />;
}

/** Tailscale: the HTTPS address it already serves this PC at, the one command that makes it, or why it cannot. */
function TailscaleMethod(props: MethodProps & { shown?: boolean }) {
  const t = useT();
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    fetchRemoteAccess().then((answer) => { if (live) setAccess(answer); }, () => { if (live) setAccess(null); });
    return () => { live = false; };
  }, []);
  if (access === undefined) return <p className="setup-muted"><LoaderCircle aria-hidden="true" className="setup-spin" /></p>;
  // Tailscale's own address, never the page's: `shell: true` skips phonePlan's "this page itself" answer (an HTTPS page,
  // the relay app), which Settings → Phone gives and this tab must not
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext, shell: true }, access);
  if (plan.kind === "here" || plan.kind === "served") return <PhoneQr given={plan.url} large shown={props.shown ?? true} auth={props.auth} onOpenSettings={props.onOpenSettings} onPaired={props.onPaired} onPhonePaired={props.onPhonePaired} />;
  if (plan.kind === "command") return (
    <div className="setup-method-step">
      <p className="setup-text">{t("Run this once on this PC.")}</p>
      <div className="setup-qr-address">
        <code>{plan.command}</code>
        <button type="button" className="icon-button" aria-label={t("Copy")} title={t("Copy")} onClick={() => void copyText(plan.command).then(setCopied)}><Copy aria-hidden="true" /></button>
      </div>
      <span className="setup-muted" role="status">{copied ? t("Copied") : null}</span>
    </div>
  );
  return <p className="setup-note"><Info aria-hidden="true" />{plan.kind === "stopped" ? t("Tailscale isn't running.") : plan.kind === "missing" ? t("Tailscale isn't installed.") : t("Couldn't check for Tailscale.")}</p>;
}

/** The three ways to connect, as tabs: an icon, a name and when it fits. */
function methodFacts(t: Translate): { id: PhoneMethod; icon: ReactNode; name: string; when: string; recommended?: true }[] {
  return [
    { id: "relay", icon: <Globe aria-hidden="true" />, name: t("Anywhere"), when: t("Works away from home too."), recommended: true },
    { id: "wifi", icon: <Wifi aria-hidden="true" />, name: t("Same Wi-Fi"), when: t("At home or at work.") },
    { id: "tailscale", icon: <Network aria-hidden="true" />, name: "Tailscale", when: t("If you use Tailscale.") },
  ];
}

/** On a phone the page scrolls: the QR area a press filled comes into view, its QR code and line with it. */
function useShownInView(area: React.RefObject<HTMLElement | null>, shown: unknown): void {
  const narrow = useMediaQuery("(max-width: 640px)");
  // the step opens at its top: only a press afterwards brings its QR area into view
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const panel = area.current;
    if (shown === null || !narrow || panel === null) return;
    // to the top of the sheet: the QR code is drawn after the press, so the panel is followed as it grows, until the
    // user scrolls or touches the sheet themselves
    const step = panel.closest("li") ?? panel;
    const align = (): void => step.scrollIntoView({ block: "start" });
    align();
    const grows = new ResizeObserver(align);
    grows.observe(panel);
    const sheet = panel.closest(".setup-body");
    const stop = (): void => grows.disconnect();
    for (const kind of ["touchstart", "wheel", "pointerdown", "keydown"] as const) sheet?.addEventListener(kind, stop, { once: true, passive: true });
    return () => { grows.disconnect(); for (const kind of ["touchstart", "wheel", "pointerdown", "keydown"] as const) sheet?.removeEventListener(kind, stop); };
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The phone's side of the step, a short numbered path: the app (optional) with its badges on one line, the way as tabs, then its QR code. */
function PhonePanel(props: MethodProps) {
  const t = useT();
  const [method, setMethod] = useState<PhoneMethod>("relay");
  const [store, setStore] = useState<Store | null>(null);
  const facts = methodFacts(t);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const area = useRef<HTMLDivElement>(null);
  useShownInView(area, store ?? method);
  const [opened, setOpened] = useState<readonly PhoneMethod[]>([method]);
  useEffect(() => { setOpened((list) => list.includes(method) ? list : [...list, method]); }, [method]);
  // while the relay starts, no other way is picked (#3962 CodeRabbit): its start could close the gate and spend that way's code
  const [relayBusy, setRelayBusy] = useState(false);
  const pick = (next: PhoneMethod): void => { if (relayBusy && next !== method) return; setStore(null); setMethod(next); };
  const onKey = (event: ReactKeyboardEvent, index: number): void => {
    const next = event.key === "ArrowRight" ? (index + 1) % facts.length : event.key === "ArrowLeft" ? (index + facts.length - 1) % facts.length : null;
    if (next === null || relayBusy) return;
    event.preventDefault();
    pick(facts[next]!.id);
    tabs.current[next]?.focus();
  };
  return (
    <ol className="setup-path">
      <li className="setup-path-row">
        <span className="setup-path-head"><span className="setup-path-num" aria-hidden="true">1</span>{t("Get the app")}<span className="setup-muted setup-path-optional">{t("Optional")}</span></span>
        <StoreBadges shown={store} onShow={setStore} />
      </li>
      <li>
        <span className="setup-path-head" id="setup-path-ways"><span className="setup-path-num" aria-hidden="true">2</span>{t("Pick how to connect")}</span>
        <div className="setup-path-tabs" role="tablist" aria-labelledby="setup-path-ways">
          {facts.map((fact, index) => (
            <button key={fact.id} ref={(node) => { tabs.current[index] = node; }} type="button" role="tab" aria-disabled={relayBusy && fact.id !== method ? true : undefined} id={`setup-path-tab-${fact.id}`} aria-selected={store === null && method === fact.id} aria-controls="setup-path-panel" tabIndex={method === fact.id ? 0 : -1} className="setup-path-tab" onClick={() => pick(fact.id)} onKeyDown={(event) => onKey(event, index)}>
              {fact.icon}<span>{fact.name}</span>{fact.recommended && <span className="setup-badge">{t("Recommended")}</span>}
            </button>
          ))}
        </div>
        {store === null && <p className="setup-muted setup-path-hint">{facts.find((fact) => fact.id === method)!.when}</p>}
      </li>
      <li>
        <span className="setup-path-head"><span className="setup-path-num" aria-hidden="true">3</span>{t("Scan with your phone")}</span>
        <div id="setup-path-panel" role="tabpanel" aria-labelledby={`setup-path-tab-${method}`} className="setup-method-area" ref={area}>
          {store !== null && <StoreQr store={store} />}
          {/* a way once opened stays mounted while hidden: going back to it asks for no new code (one only on New code) */}
          {opened.map((way) => <div key={way} hidden={store !== null || way !== method}><MethodPanel method={way} shown={way === method} {...props} onRelayBusy={setRelayBusy} /></div>)}
        </div>
      </li>
    </ol>
  );
}

/** What an alert looks like, and where alerts go now: this computer (by the guide's one rule) and the phone. */
function AlertsPicture({ alerts, phoneName }: { alerts: AlertsAnswer; phoneName: string | null }) {
  const t = useT();
  return (
    <>
      <div className="setup-alert-sample" role="img" aria-label={t("A sample alert: Claude Code needs your input")}>
        <OvisMark width={28} height={28} />
        <span className="setup-alert-sample-text">
          <span className="setup-alert-sample-title">Claude Code · api-server</span>
          <span>{t("Needs your input")}</span>
        </span>
        <span className="setup-alert-sample-time">{t("now")}</span>
      </div>
      <ul className="setup-alert-where">
        <li><span className="setup-label">{t("This computer")}</span>{alerts === "on" ? t("Alerts are on.") : alerts === "checking" ? t("Checking…") : alerts === "unavailable" ? t("This address can't get alerts.") : t("Alerts are off.")}</li>
        <li><span className="setup-label">{t("Phone")}</span>{phoneName === null ? t("Alerts reach it once connected.") : t("Alerts reach {name} when it allows them.", { name: phoneName })}</li>
      </ul>
    </>
  );
}
