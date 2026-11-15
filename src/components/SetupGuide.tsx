/**
 * The first-run setup guide (lib/setupGuideFlow.ts), drawn as a dialog over the app: a welcome, then the
 * steps, then a Done screen whose Start opens the first workspace. The agent step checks the PC for
 * coding agents, then shows every one as a tile whatever it found: an installed one is picked by a tap,
 * a missing one has its Install (the user's tap is the consent: the official installer runs in a
 * terminal tab while a ring turns on the tile). Start opens the first workspace with the one picked;
 * the agent asks for its own sign-in when it first starts. Its footer's Start now, finish setup later
 * starts it at once (two clicks from the welcome); Continue leads to Done. Plan usage is turned on for
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
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, CircleCheck, Folder, Gauge, Info, KeyRound, LoaderCircle, Play, RotateCw, Smartphone, Sparkles, SquareTerminal, X } from "lucide-react";

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
import { useSettings } from "../lib/settings.ts";
import { agentRows, checkList, foundAgents, installedHere, phoneBoxMode, phoneBoxOpensFirst, phoneBoxStays, phoneWay, openInFolder, preferredAgent, relayStep, settleDelay, setupView, signedInAgents, turnsUsageOn, type CheckStatus, type GuideEvent, type GuideState, type PcCheck, type PhoneBoxOpening } from "../lib/setupGuideFlow.ts";
import { focusInOtherModal, nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { inRelayShell, useRelay, type RelayState } from "../lib/useRelay.ts";
import { useSignedInUsage } from "../lib/useSetupGuide.ts";
import { userErrorMessage, userFailure } from "../lib/userError.ts";
import { AccountSection } from "./AccountSection.tsx";
import { AgentMark } from "./AgentMark.tsx";
import { AgentTile } from "./AgentTile.tsx";
import { OvisMark } from "./OvisMark.tsx";
import { TelemetryNotice } from "./TelemetryControls.tsx";
import { UsageSignInDialog } from "./UsageSignInDialog.tsx";
import { QrCode } from "./QrCode.tsx";
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
  /** I've used Ovis before, Skip setup, the close button or Escape, or the first workspace opened */
  onClose: () => void;
  /** shows the tab an install or sign-in runs in */
  onOpenTerminal: (paneId: string) => void;
  /** Connect your phone where the guide cannot show its QR code: the Settings page that pairs it */
  onOpenSettings: (page: "devices") => void;
  /** the welcome's line about anonymous usage counts: its sentence opens Settings → About, where the switch is */
  onOpenTelemetry: () => void;
  /** how this browser got in: one in only because nothing is paired yet pairs itself first (Connect your phone) */
  auth: HealthAuth | null;
  /** the server's access facts: whether turning the relay on closes the open device gate (Connect your phone) */
  security: SecurityFacts;
  /** this browser paired itself (Connect your phone): the app reads its access again */
  onPaired: () => void;
  /** Start pressed: a tab the guide asked to show before it is not shown over what Start opens */
  onStarting?: () => void;
  /** the first workspace opened: its pane, and whether the agent started in it */
  onOpened: (paneId: string, agentStarted: boolean) => void;
}

export function SetupGuide(props: SetupGuideProps) {
  const { state, onClose, hidden = false } = props;
  const t = useT();
  const machineId = useMachineId();
  // the PC check: GET /api/agent-catalog for the PC being set up, run once the guide is begun and on Look again
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
        setAnnounced(foundAgents(answer.agents).length > 0 ? t("Pick your coding agent") : t("Pick an AI coding helper"));
      }, settleDelay(startedAt, Date.now()));
    }, (error: unknown) => {
      if (ask !== asked.current) return;
      setCatalogError(userFailure(error).kind === "unknown" ? t("Couldn't load the installed agents. Try again.") : userErrorMessage(error).message);
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
  const begun = state.step !== "welcome";
  useEffect(() => {
    if (begun) loadCatalog();
    return () => { asked.current += 1; window.clearTimeout(settle.current); };
  }, [begun, machineId]); // eslint-disable-line react-hooks/exhaustive-deps
  const check: PcCheck = { checking, catalog, failed: catalogError !== null };
  const view = setupView(check);

  // the control the dialog gives the keyboard to when it opens: the welcome's first choice, or a step's title
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
  // the welcome and the steps swap in place (I'm new to Ovis, Back): the one shown takes the keyboard
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
  if (state.step === "welcome") body = <Welcome dispatch={props.dispatch} onClose={onClose} notice={notice} firstFocus={firstFocus} />;
  else if (view === "agents" && catalog !== null) body = <Steps catalog={catalog} ready={ready} machineId={machineId} reopened={state.reopened === true} dispatch={props.dispatch} onClose={onClose} onInstalled={agentInstalled} onLookAgain={loadCatalog} onOpenTerminal={props.onOpenTerminal} onOpened={props.onOpened} onOpenSettings={props.onOpenSettings} auth={props.auth} security={props.security} onStarting={props.onStarting} onPaired={props.onPaired} usageOn={turnsUsageOn(props.state)} phoneFirst={!phoneClosed && phoneBoxOpensFirst(props.state, isLoopbackHost(window.location.hostname))} onPhoneClosed={() => setPhoneClosed(true)} notice={notice} firstFocus={firstFocus} />;
  else body = <CheckStep reopened={state.reopened === true} dispatch={props.dispatch} onClose={onClose} notice={notice} firstFocus={firstFocus}>{view === "failed" ? <CheckFailed error={catalogError} onLookAgain={loadCatalog} /> : <Checking known={known} catalog={catalog} />}</CheckStep>;

  return (
    <div className="modal-scrim setup-scrim" hidden={hidden}>
      {/* stepped aside (hidden) it is no dialog: the app's checks for an open modal (typing, the drawer, Escape) must not
          find it, as the drawer and the docked WebPanel drop theirs */}
      <section ref={surface} className="modal setup-dialog" role={hidden ? undefined : "dialog"} aria-modal={hidden ? undefined : true} aria-labelledby={hidden ? undefined : "setup-dialog-name"} tabIndex={-1}>
        <header className="modal-header setup-head">
          <span className="setup-brand" id="setup-dialog-name"><OvisMark width={24} height={24} />{t("Set up Ovis")}</span>
          {/* the steps' list sits here once the guide has more than one step */}
          <span className="setup-head-middle" />
          <button type="button" className="icon-button" aria-label={t("Close setup")} title={t("Close setup")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <p className="visually-hidden" role="status">{announced}</p>
        {body}
      </section>
    </div>
  );
}

type FirstFocus = MutableRefObject<HTMLElement | null>;

function Welcome({ dispatch, onClose, notice, firstFocus }: Pick<SetupGuideProps, "dispatch" | "onClose"> & { notice: ReactNode; firstFocus: FirstFocus }) {
  const t = useT();
  // Not now folds the sign-in away for this welcome; Settings → Devices and PCs keeps it
  const [later, setLater] = useState(false);
  // Not now takes its box away: the keyboard's place goes to the first choice, not to the page
  const firstChoice = useRef<HTMLButtonElement>(null);
  const focusTarget = useCallback((node: HTMLButtonElement | null) => { firstChoice.current = node; firstFocus.current = node; }, [firstFocus]);
  return (
    <div className="modal-body setup-body">
      <div className="setup-main">
        <h2 id="setup-step-title" className="setup-title" tabIndex={-1}>{t("Welcome to Ovis")}</h2>
        <p className="setup-lead">{t("Is this your first time using Ovis?")}</p>
        <div className="setup-choices">
          <button ref={focusTarget} type="button" className="setup-choice setup-choice-primary" onClick={() => dispatch({ type: "begin" })}>
            <span className="setup-choice-icon"><Sparkles aria-hidden="true" /></span>
            <span className="setup-choice-text"><strong>{t("I'm new to Ovis")}</strong><span>{t("Ovis finds or installs an AI coding helper and opens your first project.")}</span></span>
            <ChevronRight aria-hidden="true" />
          </button>
          <button type="button" className="setup-choice" onClick={onClose}>
            <span className="setup-choice-icon"><ArrowRight aria-hidden="true" /></span>
            <span className="setup-choice-text"><strong>{t("I've used Ovis before")}</strong><span>{t("Skip the setup and go straight in")}</span></span>
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
        {/* the account's sign-in, as Settings → Devices and PCs has it; none where this page has no account service */}
        {!later && <AccountSection welcome={{
          lead: <p className="setup-muted">{t("Sign in to use this PC from your phone and your other PCs.")}</p>,
          later: <button type="button" className="setup-link" onClick={() => { setLater(true); firstChoice.current?.focus(); }}>{t("Not now")}</button>,
        }} />}
        <p className="setup-note"><Info aria-hidden="true" />{t("You can open this again any time from Settings → Agents.")}</p>
        {notice}
      </div>
      <aside className="setup-side" aria-labelledby="setup-plan-label">
        <span className="setup-label" id="setup-plan-label">{t("What setup does")}</span>
        <ul className="setup-list">
          <li className="setup-item"><SquareTerminal aria-hidden="true" /><span>{t("Finds the coding agents on this PC, or installs one.")}</span></li>
          <li className="setup-item"><Play aria-hidden="true" /><span>{t("Opens your first workspace with the agent you pick.")}</span></li>
        </ul>
      </aside>
    </div>
  );
}

/** The agent step's title, given the keyboard when the step is shown. */
function StepTitle({ children, firstFocus }: { children: ReactNode; firstFocus: FirstFocus }) {
  const ref = useCallback((node: HTMLHeadingElement | null) => { firstFocus.current = node; }, [firstFocus]);
  return <h2 ref={ref} id="setup-step-title" className="setup-title" tabIndex={-1}>{children}</h2>;
}

/** The agent step while the PC is checked, or when the check failed: nothing to pick yet, so nothing to continue with. */
function CheckStep({ reopened, dispatch, onClose, notice, firstFocus, children }: { reopened: boolean; dispatch: (event: GuideEvent) => void; onClose: () => void; notice: ReactNode; firstFocus: FirstFocus; children: ReactNode }) {
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
        <button type="button" className="btn btn-ghost" onClick={onClose}>{t("Skip setup")}</button>
        {!reopened && <button type="button" className="btn" onClick={() => dispatch({ type: "back" })}><ChevronLeft aria-hidden="true" />{t("Back")}</button>}
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
      <h2 id="setup-step-title" className="setup-title" tabIndex={-1}>{t("Checking this PC…")}</h2>
      <p className="setup-lead">{t("Looking for AI coding helpers that are already installed.")}</p>
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
      <h2 id="setup-step-title" className="setup-title" tabIndex={-1}>{t("Couldn't check this PC")}</h2>
      {error !== null && <p className="setup-error" role="alert">{error}</p>}
      <div className="setup-actions">
        <button type="button" className="btn btn-primary" onClick={onLookAgain}><RotateCw aria-hidden="true" />{t("Look again")}</button>
      </div>
    </>
  );
}

interface StepsProps extends Pick<SetupGuideProps, "onOpenTerminal" | "onOpened" | "onOpenSettings" | "auth" | "security" | "onStarting" | "onPaired" | "onClose" | "dispatch"> {
  /** opened again from Settings: no welcome to go back to */
  reopened: boolean;
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
function Steps({ catalog, ready, machineId, reopened, notice, dispatch, onClose, onInstalled, onLookAgain, onOpenTerminal, onOpened, onOpenSettings, auth, security, onStarting, onPaired, usageOn, phoneFirst, onPhoneClosed, firstFocus }: StepsProps) {
  const t = useT();
  const { settings, update } = useSettings();
  const agents = agentRows(catalog, ready);
  const installed = agents.filter((agent) => installedHere(agent, ready));
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = installed.find((agent) => agent.id === picked) ?? preferredAgent(installed, ready.at(-1) ?? null);
  // the step shown: the agents, or Done with its Start
  const [page, setPage] = useState<"agent" | "done">("agent");
  const pageBefore = useRef(page);
  useEffect(() => {
    if (pageBefore.current === page) return;
    pageBefore.current = page;
    // the button pressed went with the step it was in: the new step's title takes the keyboard
    document.getElementById("setup-step-title")?.focus({ preventScroll: true });
  }, [page]);
  // the agents already signed in here: their plan usage is turned on as soon as they are seen, without a question
  const signedIn = useSignedInUsage(ready, (refresh) => fetchUsage(refresh).then((report) => signedInAgents(report.providers)), settings.showUsage || !usageOn, () => update({ showUsage: true }));
  // Claude Code and Codex, installed here and not signed in yet: signed in from the guide, in the browser
  // (UsageSignInDialog). Accounts are read on the server's PC, so only its own guide offers it, and a
  // watching device signs in to nothing
  // signed in from here: the usage read that would say so may not come again while the guide is open
  const [signedHere, setSignedHere] = useState<readonly string[]>([]);
  const unsigned = machineId === "local" && auth?.role !== "watch" ? installed.filter((agent) => (agent.id === "claude" || agent.id === "codex") && !signedIn.includes(agent.id) && !signedHere.includes(agent.id)) : [];
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
    if ("fault" in launch) { setOpening(false); setError(t("{agent} can't start from here. Open a workspace from the sidebar instead.", { agent: chosen.name })); return; }
    try {
      const result = await openInFolder((directory) => createWorkspace(createRequest({ tab: null, directory, name: "" }, launch, null)), folder, HOME, (reason) => alive.current && reason instanceof ApiError && reason.code === "invalid_cwd");
      // the guide closed while it was being made (Escape): the workspace is in the sidebar, but nothing is closed or
      // picked for it, as the user may be somewhere else by now, or in a guide opened again
      if (!alive.current) return;
      if (result.agent_started === false) {
        setOpening(false);
        setMadeWithout(result.pane_id);
        setError(t("The workspace opened, but {agent} did not start. Open it to see why in its terminal.", { agent: chosen.name }) + (result.error?.message ? ` (${result.error.message})` : ""));
        return;
      }
      onOpened(result.pane_id, true);
    } catch (reason: unknown) {
      if (!alive.current) return;
      setOpening(false);
      setError(userFailure(reason).kind === "unknown" ? t("Couldn't open the workspace. Try again.") : userErrorMessage(reason).message);
    }
  };

  const locked = opening || madeWithout !== null;
  // Connect your phone: the relay's QR code, or the page's own and its address, right here
  // open from the start on a first run on the PC, where a phone is the next device to add
  const [phone, setPhoneState] = useState<PhoneBoxOpening | null>(phoneFirst ? "first-run" : null);
  const setPhone = (next: PhoneBoxOpening | null): void => { setPhoneState(next); if (next === null) onPhoneClosed(); };
  const startLabel = madeWithout !== null ? t("Open the workspace") : chosen !== null ? t("Start with {agent}", { agent: chosen.name }) : t("Start");
  const version = chosen?.state.installed === true ? chosen.state.version : null;
  const signInChosen = chosen !== null && unsigned.some((agent) => agent.id === chosen.id);
  const usageNote = signedIn.length > 0 && (settings.showUsage || usageOn) && <p className="setup-note"><Gauge aria-hidden="true" />{t("Plan usage will show in the sidebar for your signed-in accounts.")}</p>;
  const errorLine = error !== null && <p className="setup-error" role="alert">{error}</p>;
  const signInDialog = signingIn && <UsageSignInDialog request={signingIn} onOpenTerminal={(paneId) => { setSigningIn(null); onOpenTerminal(paneId); }} onSignedIn={() => setSignedHere((done) => [...done, signingIn.provider])} onClose={() => setSigningIn(null)} />;

  if (page === "done" && chosen !== null) return (
    <>
      <div className="modal-body setup-body">
        <div className="setup-main">
          <StepTitle firstFocus={firstFocus}>{t("Ovis is ready")}</StepTitle>
          <p className="setup-lead">{folder === HOME
            ? t("Ovis opens a workspace in your home folder and starts {agent}.", { agent: chosen.name })
            : t("Ovis opens a workspace in {folder} and starts {agent}.", { folder, agent: chosen.name })}</p>
          <ul className="setup-list setup-summary">
            <li className="setup-item is-done"><CircleCheck role="img" aria-label={t("Done")} /><span className="setup-summary-row"><span className="setup-summary-name">{t("Agent")}</span><span>{version === null ? chosen.name : `${chosen.name} ${version}`}</span></span></li>
          </ul>
          {usageNote}
          {errorLine}
          {notice}
        </div>
        <aside className="setup-side" aria-labelledby="setup-phone-label">
          <span className="setup-label" id="setup-phone-label">{t("On your phone")}</span>
          <p className="setup-text">{t("Scan a QR code with your phone's camera to see and answer your agents there.")}</p>
          <div className="setup-actions">
            <button type="button" className="btn" disabled={opening} aria-expanded={phone !== null} onClick={() => setPhone(phone === null ? "tap" : null)}><Smartphone aria-hidden="true" />{t("Connect your phone")}</button>
          </div>
          {phone !== null && <PhoneBox opening={phone} auth={auth} security={security} onOpenSettings={() => { setPhone(null); onOpenSettings("devices"); }} onPaired={onPaired} onWithdraw={() => setPhone(null)} />}
        </aside>
      </div>
      <footer className="modal-footer setup-foot">
        <button type="button" className="btn" disabled={locked} onClick={() => setPage("agent")}><ChevronLeft aria-hidden="true" />{t("Back")}</button>
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
              <StepTitle firstFocus={firstFocus}>{t("Pick your coding agent")}</StepTitle>
              <p className="setup-lead">{t("Found on this PC. The one you pick starts when setup ends.")}</p>
            </>
          ) : (
            <>
              <StepTitle firstFocus={firstFocus}>{t("Pick an AI coding helper")}</StepTitle>
              <p className="setup-lead">{t("Nothing is installed until you tap Install.")}</p>
            </>
          )}
          <ul ref={tilesRef} className="setup-found" aria-label={t("AI coding helpers")}>
            {listed.map((agent) => (
              <AgentTile key={agent.id} agent={agent} has={installedHere(agent, ready)} picked={chosen?.id === agent.id} locked={locked} machineId={machineId}
                onPick={setPicked} onOpenTerminal={onOpenTerminal} onRunning={onRunning} onInstalled={installedFromTile} onError={onInstallError} />
            ))}
          </ul>
          {Object.values(installErrors).map((message) => <p key={message} className="setup-error" role="alert">{message}</p>)}
          {((installed.length > 0 && others.length > 0 && !moreShown) || (!busy && !locked)) && (
            <p className="setup-muted setup-again">
              {installed.length > 0 && others.length > 0 && !moreShown && <button type="button" className="setup-link" onClick={() => setMoreShown(true)}>{t("Install another agent ({count})", { count: others.length })}</button>}
              {!busy && !locked && <span>{t("Already installed one?")} <button type="button" className="setup-link" onClick={onLookAgain}>{t("Look again")}</button></span>}
            </p>
          )}
          {errorLine}
          {notice}
        </div>
        <aside className="setup-side" aria-label={chosen !== null ? chosen.name : t("AI coding helpers")}>
          {chosen !== null ? (
            <>
              <div className="setup-agent-head"><AgentMark agent={chosen.id} size={24} /><strong>{chosen.name}</strong></div>
              <ul className="setup-list">
                <li className="setup-item is-done"><CircleCheck aria-hidden="true" /><span>{version === null ? t("Installed") : t("Installed · v{version}", { version })}</span></li>
                {signInChosen && (
                  <li className="setup-item"><KeyRound aria-hidden="true" /><span>{t("{agent} is not signed in yet.", { agent: chosen.name })}{" "}
                    <button type="button" className="setup-link" disabled={locked} onClick={() => setSigningIn({ provider: chosen.id as "claude" | "codex", default: true })}>{t("Sign in to {agent}", { agent: chosen.name })}</button></span></li>
                )}
                <li className="setup-item"><Folder aria-hidden="true" /><span>{folder === HOME ? t("Starts in your home folder (~).") : t("Starts in {folder}.", { folder })}</span></li>
              </ul>
              {usageNote}
            </>
          ) : (
            <>
              <p className="setup-muted">{t("Install one from its tile. Its official installer runs in a terminal tab, and you can go on meanwhile.")}</p>
              {/* with nothing installed there is no Done yet: the phone can be connected from here meanwhile */}
              <span className="setup-label" id="setup-phone-label">{t("On your phone")}</span>
              <div className="setup-actions">
                <button type="button" className="btn" aria-expanded={phone !== null} onClick={() => setPhone(phone === null ? "tap" : null)}><Smartphone aria-hidden="true" />{t("Connect your phone")}</button>
              </div>
              {phone !== null && <PhoneBox opening={phone} auth={auth} security={security} onOpenSettings={() => { setPhone(null); onOpenSettings("devices"); }} onPaired={onPaired} onWithdraw={() => setPhone(null)} />}
            </>
          )}
        </aside>
      </div>
      <footer className="modal-footer setup-foot">
        {madeWithout !== null ? null : chosen !== null
          ? <button type="button" className="btn btn-ghost" disabled={opening} onClick={() => void start()}>{t("Start now, finish setup later")}</button>
          : <button type="button" className="btn btn-ghost" onClick={onClose}>{t("Skip setup")}</button>}
        {!reopened && <button type="button" className="btn" disabled={locked || busy} onClick={() => dispatch({ type: "back" })}><ChevronLeft aria-hidden="true" />{t("Back")}</button>}
        {madeWithout !== null
          ? <button type="button" className="btn btn-primary" onClick={() => void start()}><Play aria-hidden="true" />{t("Open the workspace")}</button>
          : <button type="button" className="btn btn-primary" disabled={chosen === null || locked || busy} onClick={() => setPage("done")}>{t("Continue")}<ArrowRight aria-hidden="true" /></button>}
      </footer>
      {signInDialog}
    </>
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
  onPaired: () => void;
}

/**
 * Connect your phone: the Ovis relay first where it can lead here (phoneWay), with a quiet way to the
 * page's own QR code and address (PhoneQr), which is all the box shows where the relay cannot lead.
 * The relay is asked about only while the box is open.
 */
function PhoneBox({ opening, onWithdraw, auth, security, onOpenSettings, onPaired }: PhoneBoxProps) {
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
  if (way === "other") return <PhoneQr auth={auth} onOpenSettings={onOpenSettings} onPaired={onPaired} />;
  // as Settings → Phone works it out: the relay closes a gate still open with no token set (server/relay/service.ts)
  const closesGate = security.state === "known" && security.summary.pairing_gate === "open" && !security.summary.token_configured;
  return <RelayBox relay={relay} auth={auth} closesGate={closesGate} onPaired={onPaired} onOther={() => setOther(true)} />;
}

/**
 * The relay's part of Connect your phone: one line on what it does and the button that turns it on (the
 * user's tap is the consent), its state while it connects, a start that failed with Try again, and its
 * pairing QR code once it is online (RelayPairing, as Settings shows it). Turning it on closes a device
 * gate still open, which would shut out a browser in only because nothing is paired yet (auth via
 * "open": a LAN or tailnet address, never the PC's loopback), so that browser pairs itself first.
 */
function RelayBox({ relay, auth, closesGate, onPaired, onOther }: { relay: RelayState; auth: HealthAuth | null; closesGate: boolean; onPaired: () => void; onOther: () => void }) {
  const t = useT();
  const { status, pending, request } = relay;
  const [turning, setTurning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairedSelf, setPairedSelf] = useState(false);
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
      setError(reason instanceof UnconfirmedPairing ? t("Could not confirm this browser is paired. Check that cookies are enabled, then try again.") : failureText(reason));
    } finally { setTurning(false); }
  };
  return (
    <div className="setup-phone-relay">
      {step === "off" && (
        <>
          <p className="setup-phone-relay-lead">{t("Your phone's camera scans a QR code and reaches this PC from anywhere. End-to-end encrypted, nothing to install.")}</p>
          {closesGate && <p className="setup-muted">{t("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.")}</p>}
          <div className="setup-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void start()}><Smartphone aria-hidden="true" />{t("Turn on the Ovis relay")}</button>
          </div>
        </>
      )}
      {step === "starting" && <p className="setup-muted setup-phone-relay-state" role="status">{status.phase === "connecting" && <LoaderCircle aria-hidden="true" className="setup-spin" />}{statusText(t, status)}</p>}
      {step === "not-started" && (
        <>
          <p className="setup-error" role="alert">{t("The relay did not start: {message}", { message: status.error ?? "" })}</p>
          <div className="setup-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void start()}><RotateCw aria-hidden="true" />{t("Try again")}</button>
          </div>
        </>
      )}
      {step === "online" && <RelayQr />}
      {pairedSelf && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("This browser is paired first: other browsers now need pairing too.")}</span>}
      {/* a failed start's reason shows once, in its own line, when the relay says it did not start; any other failure (a retry's own pairing) shows here */}
      {error !== null && (step !== "not-started" || error !== status.error) && <p className="setup-error" role="alert">{error}</p>}
      {/* not while the relay starts: its start closes the gate, which would spend the other way's pairing code */}
      <button type="button" className="setup-link setup-phone-other" disabled={busy} onClick={onOther}>{t("Use Tailscale or Wi-Fi instead")}</button>
    </div>
  );
}

/**
 * The relay's pairing QR code in the guide (RelayPairing, as Settings shows it), and the phone that
 * used it: its code is single-use, so once a new device is listed the QR gives way to Paired and New
 * code, as the address QR does (PhoneQr). Devices listed when it opened are the ones before it.
 */
function RelayQr() {
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
        if (fresh !== undefined) setPaired(fresh.label);
      }, () => { /* asked again on the next turn */ }).finally(() => { asked = false; });
    };
    look();
    const poll = window.setInterval(look, PAIRING_POLL_MS);
    return () => { live = false; window.clearInterval(poll); };
  }, [paired]);
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
function PhoneQr({ auth, onOpenSettings, onPaired }: { auth: HealthAuth | null; onOpenSettings: () => void; onPaired: () => void }) {
  const t = useT();
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetchRemoteAccess().then((answer) => { if (live) setAccess(answer); }, () => { if (live) setAccess(null); });
    return () => { live = false; };
  }, []);
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext }, access ?? null);
  // where a phone can open this app now, as Settings → Phone works it out
  const address = access === undefined ? undefined : plan.kind === "here" || plan.kind === "served" ? plan.url : isLoopbackHost(window.location.hostname) ? null : window.location.origin;
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
  const ready = mode === "qr" || mode === "pair-self";
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
      if (!live) return;
      before.current = new Set([...first, ...after].map((device) => device.id));
      setCode(fresh);
    })().catch((error: unknown) => { if (live) { setCode(null); setFailure(error instanceof UnconfirmedPairing ? t("Could not confirm this browser is paired. Check that cookies are enabled, then try again.") : userFailure(error).kind === "unknown" ? t("Couldn't prepare phone pairing. Try again.") : userErrorMessage(error).message); } }).finally(() => { if (live) setRequesting(false); });
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
        if (fresh !== undefined) { setPaired(fresh.label); setCode(null); }
      }, () => { /* asked again on the next turn */ }).finally(() => { asked = false; });
    };
    look();
    const poll = window.setInterval(look, PAIRING_POLL_MS);
    return () => { live = false; window.clearTimeout(expiry); window.clearInterval(poll); };
  }, [code]);
  if (!ready || typeof address !== "string") return <p className="setup-muted"><LoaderCircle aria-hidden="true" className="setup-spin" /></p>;
  // the line under the address: the paired phone, this browser paired first, or what failed
  const value = code === null ? address : `${address.replace(/\/$/, "")}/?pair=${code.code}`;
  return (
    <div className="setup-phone-qr">
      <QrCode value={value} label={code === null ? t("Open this address on your phone") : t("QR code that pairs a phone with code {code}", { code: code.code })} size={136} />
      <div className="setup-phone-qr-text">
        {paired !== null && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("Paired: {name}.", { name: paired })}</span>}
        {pairedHere && <span className="setup-paired" role="status"><Check aria-hidden="true" />{t("This browser is paired first: other browsers now need pairing too.")}</span>}
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
      <span>{t("The setup guide is waiting for you.")}</span>
      <button type="button" className="btn btn-ghost" onClick={onResume}>{t("Back to setup")}</button>
    </p>
  );
}
