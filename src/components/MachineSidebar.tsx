import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Download, Monitor, Plus, Settings, SlidersHorizontal, X } from "lucide-react";
import type { Machine, MachineState, MachineUpdate } from "../../shared/machines.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { answerMachineSetup, machineRequest } from "../lib/api.ts";
import { describeProgress } from "../lib/bridgeProgress.ts";
import { keepDismissed, noticeKey, readDismissed, waitingMachines, writeDismissed } from "../lib/machineNotice.ts";
import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { Sidebar } from "./Sidebar.tsx";
import { AgentSidebar } from "./AgentSidebar.tsx";
import { SidebarActivityProvider, type SidebarActivity } from "../lib/sidebarActivity.tsx";
import { filterSuggestions, machineFilter, sidebarFilter, type SidebarBranchLabels } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider, useSidebarFilter } from "../lib/sidebarFilterContext.ts";
import { UsageMeters } from "./UsageMeters.tsx";
import "./Machines.css";
import { useT } from "../lib/i18n.ts";
import { requestSettingsPage } from "../lib/paletteSettings.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { machineErrorText, saysHerdrAway } from "../lib/userError.ts";

/** The PC header's state word; "connected" is the quiet default and shows as a dot alone, every other state also writes its word under the name. */
export const STATE_WORD: Readonly<Record<MachineState, string>> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  error: "Connection error",
};

/** `activity`: App's live counters per PC and finishes looked at here; both sidebar lists draw from it.
 *  `machines` are the PCs this device shows; `hiddenCount` says how many it keeps out (Settings → Remote PCs) */
interface Props { machines: Machine[]; hiddenCount?: number; selectedMachineId: string; selectedPaneId: string | null; activity: SidebarActivity; actions: AppActions; watching?: boolean; /** a phone's drawer is out: closing it clears the filter */ drawerOpen?: boolean; onSelect(machineId: string, paneId: string | null): void; onNew(machineId: string): void; onSetup(machine: Machine, update?: boolean): void }
export function MachineSidebar(props: Props) {
  const t = useT();
  const { canInstall, installed, install, help } = useInstallPrompt();
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  const activity = props.activity;
  // the filter's query lives here and nowhere else: not in storage, not in the address, not past this
  // mount (lib/sidebarFilter.ts). The branch each roster row says comes up from the rosters, which read it.
  const [query, setQuery] = useState("");
  const filterId = useId();
  const suggestionsId = useId();
  const filterInput = useRef<HTMLInputElement>(null);
  const [branchLabels, setBranchLabels] = useState<SidebarBranchLabels>(() => new Map());
  const reportBranches = useCallback((machineId: string, branches: ReadonlyMap<string, string>) => setBranchLabels((current) => {
    const before = current.get(machineId);
    if (before !== undefined && before.size === branches.size && [...branches].every(([id, branch]) => before.get(id) === branch)) return current;
    if (before === undefined && branches.size === 0) return current;
    const next = new Map(current);
    if (branches.size === 0) next.delete(machineId); else next.set(machineId, branches);
    return next;
  }), []);
  const filter = useMemo(() => sidebarFilter(query, props.machines, { machineId: props.selectedMachineId, paneId: props.selectedPaneId }, t, branchLabels), [query, props.machines, props.selectedMachineId, props.selectedPaneId, t, branchLabels]);
  const filterView = useMemo(() => ({ filter, reportBranches }), [filter, reportBranches]);
  // the field offers the labels the rows show, as the browser's own suggestions: nothing typed is kept
  const suggestions = useMemo(() => filterSuggestions(props.machines, branchLabels), [props.machines, branchLabels]);
  const clearFilter = () => { setQuery(""); filterInput.current?.focus(); };
  // Escape in the field clears it; an empty field's Escape is left to the page (a phone's drawer closes on it)
  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || query === "" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    setQuery("");
  };
  const drawerOpen = props.drawerOpen === true;
  const hiddenCount = props.hiddenCount ?? 0;
  useEffect(() => { if (!drawerOpen) setQuery(""); }, [drawerOpen]);
  // the roster's wait is a live region that is in the list from its first render, clipped while empty (never
  // display: none), and its words land a frame after it (lib/useAnnouncedText.ts)
  const loadingWords = useAnnouncedText(props.machines.length === 0 ? t("Loading PCs…") : null);
  // a PC whose roster has not come was not searched: the line says the answer is only of the PCs that answered
  const unanswered = props.machines.some((machine) => machine.snapshot === null);
  const noMatchWords = useAnnouncedText(filter.active && filter.matches === 0 && props.machines.length > 0 ? `${t(unanswered ? "No workspaces or agents match on the PCs that answered" : "No workspaces or agents match")}\n${t("Try other words, or clear the filter.")}` : null);
  // no top bar: a workspace starts from its PC's header, and Add PC lives in Settings → Remote PCs. The
  // filter above the lists is a row of the same grid, one field and its clear, never taller than a row.
  return <SidebarActivityProvider value={activity}><SidebarFilterProvider value={filterView}><div className="sidebar-shell">
    <div className="sidebar-filter" role="search" aria-label={t("Filter workspaces and agents")}>
      <label className="sidebar-filter-label" htmlFor={filterId}>{t("Filter")}</label>
      <input ref={filterInput} id={filterId} className="input sidebar-filter-input" type="search" value={query} aria-label={t("Filter workspaces and agents")} placeholder={t("Workspaces and agents")} list={suggestionsId} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search" onChange={(event) => setQuery(event.target.value)} onKeyDown={onFilterKeyDown} />
      <datalist id={suggestionsId}>{suggestions.map((label) => <option key={label} value={label} />)}</datalist>
      {query !== "" && <button type="button" className="sidebar-filter-clear" aria-label={t("Clear filter")} title={t("Clear filter")} onClick={clearFilter}><X aria-hidden="true" /></button>}
    </div>
    <div className="machine-list" aria-label={t("PCs and workspaces")}>
      <p className={noMatchWords === null ? "visually-hidden" : "tree-state sidebar-filter-empty"} role="status">{noMatchWords}</p>
      {props.machines.map((machine) => <MachineGroup key={machine.id} {...props} machine={machine} />)}
      <p className={loadingWords === null ? "visually-hidden" : "tree-state"} role="status">{loadingWords}</p>
      {/* a PC kept out on this device is said, with the way to show it again */}
      {hiddenCount > 0 && <button type="button" className="machine-hidden-note" title={t("Choose the PCs this device shows")} onClick={() => { requestSettingsPage({ page: "remote", section: "sidebar-pcs" }); props.actions.openSettings(); }}>{hiddenCount === 1 ? t("1 PC hidden on this device") : t("{n} PCs hidden on this device", { n: hiddenCount })}</button>}
    </div>
    <AgentSidebar machines={props.machines} selectedMachineId={props.selectedMachineId} selectedPaneId={props.selectedPaneId} stateWord={(machine) => t(STATE_WORD[machine.state])} watching={props.watching} onSelect={props.onSelect} />
    <footer className="sidebar-footer">
      {/* browsers without an install prompt (iOS, plain HTTP) get the steps instead */}
      {!installed && <button className="btn btn-ghost sidebar-footer-action" aria-expanded={canInstall ? undefined : installHelpOpen} onClick={() => { if (canInstall) void install(); else setInstallHelpOpen(!installHelpOpen); }}><Download aria-hidden="true" />{t("Install app")}</button>}
      {!installed && !canInstall && installHelpOpen && <p className="sidebar-install-help" role="status">{help}</p>}
      <div className="sidebar-footer-row">
        <button className="btn btn-ghost sidebar-footer-action sidebar-footer-settings" aria-label={t("Settings")} title={t("Settings (⌘⇧,)")} onClick={props.actions.openSettings}><Settings aria-hidden="true" /></button>
        <UsageMeters />
      </div>
    </footer>
  </div></SidebarFilterProvider></SidebarActivityProvider>;
}

function MachineGroup({ machine, ...props }: Props & { machine: Machine }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(`ovis:pc-collapsed:${machine.id}`) === "1"; } catch { return false; } });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(machine.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = machine.state === "connected";
  // a PC that waits on the user, or is updating, shows its notice in the state line's place
  const noticed = Boolean(machine.action_required || machine.updating);
  // the state line under the name is a live region in the group from its first render, kept through the
  // notice (clipped and empty while it shows): its word lands a frame after the line (lib/useAnnouncedText.ts),
  // and every later state change, or the notice clearing, at once
  const stateWord = useAnnouncedText(noticed ? null : t(STATE_WORD[machine.state]));
  // the Host's herdr is away (the server's words name the socket it tried): the step to take is on
  // that PC, not in this browser, so it follows the words
  const nextStep = !noticed && machine.kind === "local" && machine.error !== null && saysHerdrAway(machine.error) ? t("Start herdr on this PC, or check HERDR_SOCKET.") : null;
  // one request at a time: a double-clicked Disconnect/Connect can otherwise race and leave this
  // UI's idea of the state opposite the server's until the next refetch. The method in flight is
  // kept so only a removal marks Remove PC busy (Machines.css dims that one less)
  const [busy, setBusy] = useState<string | null>(null);
  // the state disables the buttons; the ref refuses a second click that lands before that render
  const inFlight = useRef(false);
  const mutate = async (method: string, body?: unknown) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(method);
    // The selected PC moves to this one before it is removed: the server tells every tab the
    // roster without it before it answers, and a selection on a PC the roster has dropped reads
    // as one removed elsewhere ("That link's PC is not set up here"). A failure puts it back.
    const leaving = method === "DELETE" && props.selectedMachineId === machine.id ? { pane: props.selectedPaneId } : null;
    if (leaving) props.onSelect("local", null);
    try { await machineRequest(`/${machine.id}`, method, body); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); if (leaving) props.onSelect(machine.id, leaving.pane); }
    finally { inFlight.current = false; setBusy(null); }
  };
  const actions: AppActions = { ...props.actions, selectPane: (id) => props.onSelect(machine.id, id), openNewSession: () => props.onNew(machine.id) };
  // the filter (lib/sidebarFilter.ts): a PC with nothing kept is hidden, its roster still mounted so the
  // branches it reads stay findable; a folded PC with a match or the selection in it is shown open, its saved
  // fold untouched; a PC kept for the selection alone is drawn as context
  const { filter } = useSidebarFilter();
  const filtered = machineFilter(filter, machine.id);
  // while a filter is on, the caret folds and opens the PC for the filter's time only: the saved fold is
  // written by an unfiltered list alone, and comes back as it was when the query is cleared
  const [filterFold, setFilterFold] = useState<boolean | null>(null);
  useEffect(() => { if (!filter.active) setFilterFold(null); }, [filter.active]);
  const hidden = filtered !== null && !filtered.shown;
  const matched = filtered !== null && (filtered.matched || filtered.matchedWorkspaces.size > 0 || filtered.matchedPanes.size > 0);
  const kept = filtered !== null && (matched || filtered.workspaces.size > 0 || filtered.panes.size > 0);
  const folded = filtered === null ? collapsed : filterFold ?? (collapsed && !kept);
  const context = filtered !== null && !matched;
  const toggle = () => {
    if (filtered !== null) { setFilterFold(!folded); return; }
    setCollapsed(!collapsed);
    try { localStorage.setItem(`ovis:pc-collapsed:${machine.id}`, collapsed ? "0" : "1"); } catch {}
  };
  // the PC's name is the head of its workspaces, and the caret beside its + the one fold over them
  return <section className={`machine-group${props.selectedMachineId === machine.id ? " is-current" : ""}${online ? "" : " is-offline"}${context ? " is-filter-context" : ""}`} hidden={hidden} aria-label={t("PC {name}", { name: machine.name })}>
    <header className="machine-header">
      <div className="machine-title">
        <span className="sidebar-mark" aria-hidden="true"><Monitor /></span>
        <span className="machine-name">{machine.name}</span>
        {/* the computer this app's server runs on; on a phone "this PC" read as the phone */}
        {machine.kind === "local" && <span className="machine-kind" title={t("The computer this app runs on")}>{t("Host")}</span>}
        <span className={`machine-dot is-${machine.action_required === "setup" ? "setup" : machine.state}`} title={machine.action_required === "setup" ? t("Setup needed") : t(STATE_WORD[machine.state])} aria-hidden="true" />
      </div>
      {machine.kind === "ssh" && <button className="sidebar-row-action machine-manage" aria-label={t("Manage {name}", { name: machine.name })} title={t("Manage PC")} aria-expanded={editing} onClick={() => { setEditing(!editing); setConfirmDelete(false); }}><SlidersHorizontal aria-hidden="true" /></button>}
      {/* the fold over this PC's workspaces sits beside the + */}
      <button className="sidebar-row-action machine-toggle" aria-expanded={!folded} aria-label={folded ? t("Expand {name}", { name: machine.name }) : t("Collapse {name}", { name: machine.name })} title={folded ? t("Expand {name}", { name: machine.name }) : t("Collapse {name}", { name: machine.name })} onClick={toggle}>{folded ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>
      <button className="sidebar-row-action machine-new" disabled={!online} aria-label={t("New workspace on {name}", { name: machine.name })} title={t("New workspace")} onClick={() => props.onNew(machine.id)}><Plus aria-hidden="true" /></button>
    </header>
    {/* connected is the norm and says nothing new; every other state is spelled out */}
    {noticed && <MachineActionNotice machine={machine} onSetup={props.onSetup} />}
    <p className={`machine-state is-${machine.state}${online || stateWord === null ? " visually-hidden" : ""}`} role="status" title={noticed || machine.error === null ? undefined : machineErrorText(machine.error, t)}>
      <span className="machine-state-word">{stateWord}</span>
      {!noticed && machine.error && <span className="machine-state-detail">{machineErrorText(machine.error, t)}</span>}
      {nextStep !== null && <span className="machine-state-next">{nextStep}</span>}
    </p>
    {editing && <div className="machine-controls">
      {machine.herdr_profile_id ? <p className="field-hint">{t("Managed by herdr. Rename, disable or remove it there.")}</p> : <form onSubmit={(e) => { e.preventDefault(); void mutate("PATCH", { name }); }}><label className="field"><span className="field-label">{t("PC name")}</span><input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label><button className="btn" type="submit" disabled={busy !== null}>{t("Rename")}</button></form>}
      {/* The first removal click only arms the action; the second is destructive. */}
      <div className="machine-control-buttons">
        {!machine.herdr_profile_id && <button className="btn" disabled={busy !== null} onClick={() => void mutate("PATCH", { enabled: !machine.enabled })}>{t(machine.enabled ? "Disconnect" : "Connect")}</button>}
        {!["setup", "connect"].includes(machine.action_required ?? "") && <button className="btn" disabled={!machine.enabled || !machine.target} onClick={() => props.onSetup(machine)}>{t("Reconnect / setup")}</button>}
        {machine.action_required !== "connect" && <button className="btn" disabled={!machine.enabled || !machine.target} onClick={() => props.onSetup(machine, true)}>{t("Update bridge…")}</button>}
        {!machine.herdr_profile_id && <button className="btn btn-danger" disabled={busy !== null} aria-busy={busy === "DELETE" || undefined} onClick={() => { if (confirmDelete) void mutate("DELETE"); else setConfirmDelete(true); }}>{t(confirmDelete ? "Confirm remove PC" : "Remove PC")}</button>}
      </div>
      {confirmDelete && <p className="field-hint">{t("Removes this registration. Remote sessions keep running.")}</p>}
    </div>}
    {error && <p className="machine-error" role="alert">{error}</p>}
    {/* under a filter a folded PC's roster is mounted, hidden, so the branches it reads can be found */}
    {(!folded || filtered !== null) && <div className={online ? "" : "machine-offline"} inert={!online} hidden={folded}>
      {!online && !machine.snapshot ? <p className="tree-state machine-empty" role="status">{t("No saved sessions")}</p> : <MachineContext.Provider value={machine.id}><Sidebar snapshot={machine.snapshot} online={online} selectedPaneId={props.selectedMachineId === machine.id ? props.selectedPaneId : null} actions={actions} watching={props.watching} /></MachineContext.Provider>}
    </div>}
  </section>;
}

/** Seconds since the stage began, ticking on this device: install and restart have no bytes to show. */
function useStageSeconds(update: MachineUpdate): number {
  const key = `${update.job_id}:${update.progress?.stage ?? ""}`;
  const [start, setStart] = useState(() => ({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }));
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (start.key !== key) setStart({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }); }, [key]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return Math.max(0, Math.round((now - start.at) / 1000));
}

/** A bridge install in words and a bar: the step, the bytes, and roughly how long is left. */
export function BridgeUpdateProgress({ update }: { update: MachineUpdate }) {
  const view = describeProgress(update.progress);
  const seconds = useStageSeconds(update);
  if (!view) return <p className="bridge-progress-step">{update.step}</p>;
  return <div className="bridge-progress">
    <p className="bridge-progress-step"><span>{view.label}</span><span className="bridge-progress-count">{view.step}</span></p>
    <div className="bridge-progress-bar" role="progressbar" aria-label={view.label} aria-valuemin={0} aria-valuemax={100} {...(view.percent === null ? {} : { "aria-valuenow": view.percent })}>
      <span className={view.percent === null ? "is-indeterminate" : ""} style={view.percent === null ? undefined : { width: `${view.percent}%` }} />
    </div>
    <p className="bridge-progress-detail">{view.detail ?? `${seconds} s`}</p>
  </div>;
}

/** Retrying can't reconnect this PC: say what the user has to do, with the button that does it. */
function MachineActionNotice({ machine, onSetup }: { machine: Machine; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (request: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await request(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (machine.updating) {
    const updating = machine.updating;
    return <div className="machine-action is-updating" role="status">
      <p className="machine-action-text"><strong>{t("Updating the bridge")}</strong><span>{t("You can keep using the app; this PC reconnects when it is done.")}</span></p>
      <BridgeUpdateProgress update={updating} />
      <button type="button" className="btn" disabled={busy} onClick={() => void run(() => answerMachineSetup(updating.job_id, { action: "cancel" }))}>{t("Cancel update")}</button>
      {error && <p className="machine-error" role="alert">{error}</p>}
    </div>;
  }
  if (machine.action_required === "connect") return <div className="machine-action is-setup" role="status">
    <p className="machine-action-text"><strong>{t("Saved in herdr")}</strong><span>{t("Connect once to enable automatic reconnection. Installation and startup need separate approval.")}</span></p>
    <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Connect")}</button>
  </div>;
  // another app's bridge runs on this PC: neither an update from here nor an approval fixes that,
  // so it is named as what it is, with the server's reason and a plain reconnect
  if (machine.action_required === "bridge_conflict") return <div className="machine-action" role="alert">
    <p className="machine-action-text"><strong>{t("Bridge connection conflict")}</strong><span>{t("Update the apps connected to this PC to the same version, or disconnect the other app, then reconnect here. Sessions keep running.")}</span>{machine.error && <span className="machine-action-reason">{machineErrorText(machine.error, t)}</span>}</p>
    <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Reconnect")}</button>
  </div>;
  const update = machine.action_required === "update_bridge";
  return <div className={`machine-action${update ? "" : " is-setup"}`} role={update ? "alert" : "status"}>
    <p className="machine-action-text">
      <strong>{t(update ? "Bridge update needed" : "Setup needed")}</strong>
      <span>{t(update ? "This PC runs a bridge from a different version of Ovis. Update it to reconnect; herdr sessions keep running." : "Browser access uses a bridge on this PC. Review any installation or startup changes before connecting.")}</span>
      {/* the two generic reasons only repeat the sentence above */}
      {machine.error && !/different version|setup needs approval/.test(machine.error) && <span className="machine-action-reason">{machineErrorText(machine.error, t)}</span>}
    </p>
    {update ? <div className="machine-action-buttons">
      {/* a PC saved in herdr that has not connected yet is refused a direct update: its dialog connects first */}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => machineRequest(`/${encodeURIComponent(machine.id)}/update-bridge`, "POST").catch((e) => { if (!machine.herdr_profile_id) throw e; onSetup(machine, true); }))}>{t("Update bridge")}</button>
      {/* a PC that needs a password or a new host key goes through its dialog */}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onSetup(machine, true)}>{t("Sign in and update…")}</button>
    </div> : <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Set up web access")}</button>}
    {error && <p className="machine-error" role="alert">{error}</p>}
  </div>;
}

/** The app-wide line for PCs that wait on the user, so a closed drawer on a phone still says so. */
export function MachineActionBanner({ machines, onSetup }: { machines: Machine[]; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
  // a PC that cannot be updated right now would hold this line open for good: it can be closed,
  // and the PC's own row in the sidebar keeps saying what it needs
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    const kept = keepDismissed(dismissed, machines);
    if (kept.length !== dismissed.length) { setDismissed(kept); writeDismissed(kept); }
  }, [machines, dismissed]);
  const running = machines.find((machine) => machine.updating);
  if (running?.updating) {
    const view = describeProgress(running.updating.progress);
    return <div className="update-notice" role="status">
      <span>{t("Updating the bridge on {name}", { name: running.name })}{view ? ` · ${t(view.label)}${view.percent === null ? "" : ` ${view.percent}%`}` : "…"}</span>
    </div>;
  }
  const waiting = waitingMachines(machines, dismissed);
  const first = waiting[0];
  if (!first) return null;
  const conflict = first.action_required === "bridge_conflict";
  const update = first.action_required === "update_bridge";
  const others = waiting.length > 1 ? t(" (+{n} more)", { n: waiting.length - 1 }) : "";
  return <div className="update-notice" role="status">
    <span>{t(conflict ? "{name} has a bridge connection conflict{others}." : update ? "{name} needs a bridge update to reconnect{others}." : "{name} needs web access setup{others}.", { name: first.name, others })}</span>
    <button type="button" className="btn" onClick={() => update ? void machineRequest(`/${encodeURIComponent(first.id)}/update-bridge`, "POST").catch(() => onSetup(first, true)) : onSetup(first, false)}>{t(conflict ? "Reconnect" : update ? "Update bridge" : "Set up web access")}</button>
    <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => { const next = [...dismissed, ...waiting.map(noticeKey)]; setDismissed(next); writeDismissed(next); }}><X /></button>
  </div>;
}
