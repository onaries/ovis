import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { FolderOpen, X } from "lucide-react";

import "./NewSessionDialog.css";

import type { AgentKind, SlashCommand } from "../../shared/protocol.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { ApiError } from "../lib/api.ts";
import { AddAgentPanel } from "./AddAgentPanel.tsx";
import { AgentPicker, rememberAgent, rememberedAgent } from "./AgentPicker.tsx";
import { DirectoryBrowser, homeRelative } from "./DirectoryBrowser.tsx";
import { RecentFolderChips } from "./RecentFolderChips.tsx";
import { Toggle } from "./SettingsControls.tsx";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useAgentSkills } from "../lib/useAgentSkills.ts";
import { useT } from "../lib/i18n.ts";
import { latestRead, READ_AGAIN_MS, READ_AGAIN_TIMES, readAgainUntil } from "../lib/latestRead.ts";
import { loadSettings, useSettings } from "../lib/settings.ts";
import { assignAgentGroup, folderAgentGroup, rememberFolderAgentGroup } from "../lib/namedAgentGroups.ts";
import { sidebarPinKey } from "../lib/sidebarPins.ts";
import { learnTabLabel } from "../lib/tabLabels.ts";
import { launchCapabilities, launchDefaults, modelSuggestions } from "../lib/agentLaunchMode.ts";
import { MAX_COMPOSER_CHARS } from "../lib/compose.ts";
import { createRequest, dialogLaunch, firstMessageOutcome, startNewSession } from "../lib/newSession.ts";
import { useMachineSessions } from "../lib/machineSessionContext.tsx";
import { composerDrafts } from "../lib/composerDraft.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { inFlightGuard } from "../lib/sessionHistory.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";
import { focusInOtherModal, nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { catchTypeAhead } from "../lib/typeAhead.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { passingFolder, recentDirectories } from "../lib/recent-directories.ts";
import { serverIdOfPath } from "../lib/shellMode.ts";

/** The dialog as New tab: the workspace the tab joins, whose folder it uses, and the number herdr will give it. */
export interface NewTabTarget {
  workspaceId: string;
  workspaceLabel: string;
  cwd: string | null;
  number: number;
}

export interface NewSessionDialogProps {
  open: boolean;
  machineName?: string;
  defaultCwd: string | null;
  /** set, the dialog makes a tab in that workspace instead of a workspace */
  tab?: NewTabTarget | null;
  onClose: () => void;
  /**
   * `agentStarted`: the pane runs the agent asked for, so it opens in an agent's lens; `messageWaits`: the
   * bridge queued the first message for the agent's first ready turn, or its text was kept in the chat's
   * message box when it was not queued, so the pane opens in the chat lens, where it shows
   */
  onCreated: (paneId: string, agentStarted: boolean, messageWaits?: boolean) => void;
  /** fields a link fills for this opening (`?new=`, lib/deepLink.ts); an agent herdr does not offer is left out */
  prefill?: DialogFields | null;
  /** what the fields say, a moment after they change, for the address */
  onDraft?: (fields: DialogFields) => void;
  /** the PC's open linked worktree checkouts: no project to offer among the recent folders */
  worktrees?: readonly string[];
  /** shows a pane of this dialog's PC in its terminal: an agent's install or sign-in tab, from Add another agent */
  onOpenPane?: (paneId: string) => void;
  /** this device only watches: a setup types into the PC's terminal, so Add another agent is not offered */
  watching?: boolean;
  /** Settings -> Custom agent groups: which grouped keys may stay as the new pane's group is saved (lib/namedAgentGroups.ts liveGroupKeys) */
  groupKept?: (groupOf: Readonly<Record<string, string>>) => ReadonlySet<string>;
}

export interface DialogFields {
  cwd: string | null;
  name: string | null;
  /** "" is a shell; null keeps the last agent picked */
  agent: string | null;
}

interface NewSessionDraft {
  cwd: string;
  cwdEdited: boolean;
  name: string;
  prompt: string;
}

const newSessionDrafts = new Map<string, NewSessionDraft>();

// the hosted shell keeps every server under one origin (/s/<server_id>/), so one tab's sessionStorage spans them:
// a draft is the server's it was typed for, never offered to the next one opened in that tab
function newSessionDraftKey(machineId: string, tab: NewTabTarget | null): string {
  const server = serverIdOfPath(window.location?.pathname ?? "") ?? "";
  return `${server}\n${machineId}\n${tab ? `tab:${tab.workspaceId}` : "workspace"}`;
}

function readNewSessionDraft(key: string): NewSessionDraft | null {
  const mem = newSessionDrafts.get(key);
  if (mem !== undefined) return mem;
  try {
    const raw = window.sessionStorage?.getItem(`ovis:new-session-draft:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NewSessionDraft>;
    if (typeof parsed.cwd === "string" && typeof parsed.name === "string" && typeof parsed.prompt === "string") {
      return { cwd: parsed.cwd, cwdEdited: parsed.cwdEdited === true, name: parsed.name, prompt: parsed.prompt };
    }
  } catch { /* private mode */ }
  return null;
}

function writeNewSessionDraft(key: string, draft: NewSessionDraft | null): void {
  if (draft === null || (!draft.cwdEdited && draft.name === "" && draft.prompt === "")) {
    newSessionDrafts.delete(key);
    try { window.sessionStorage?.removeItem(`ovis:new-session-draft:${key}`); } catch { /* private mode */ }
    return;
  }
  newSessionDrafts.set(key, draft);
  try { window.sessionStorage?.setItem(`ovis:new-session-draft:${key}`, JSON.stringify(draft)); } catch { /* private mode */ }
}

/** Reset in-memory NewSessionDialog drafts (for tests). */
export function clearNewSessionDrafts(): void {
  newSessionDrafts.clear();
  try {
    for (const key of Object.keys(window.sessionStorage ?? {})) {
      if (key.startsWith("ovis:new-session-draft:")) window.sessionStorage.removeItem(key);
    }
  } catch { /* private mode */ }
}

/** how long the fields rest before the address follows them: Safari refuses a burst of history writes */
const DRAFT_MS = 400;
/** recent folders offered: one row a phone swipes sideways; a wider screen fits what one row holds and lists the rest under "+N" */
const RECENT_FOLDERS_SHOWN = 8;

function directoryBasename(value: string): string {
  const trimmed = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed.split("/").pop() || value;
}

const skillToken = (skill: SlashCommand): string => `${skill.trigger ?? "/"}${skill.name}`;

/** `token` at `at` in `text`, a space on each side where it meets a word; the caret lands after it. */
export function insertToken(text: string, at: number, token: string): { text: string; caret: number } {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after === "" || !/^\s/.test(after) ? " " : "";
  const head = `${before}${lead}${token}${trail}`;
  return { text: `${head}${after}`.slice(0, MAX_COMPOSER_CHARS), caret: Math.min(head.length, MAX_COMPOSER_CHARS) };
}

export function NewSessionDialog({ open, defaultCwd, tab = null, onClose, onCreated, machineName, prefill = null, onDraft, worktrees = [], onOpenPane, watching = false, groupKept }: NewSessionDialogProps) {
  const t = useT();
  const { settings, update: updateSettings } = useSettings();
  const machineId = useMachineId();
  const { createTab, createWorkspace, fetchAgentKinds, fetchAgentCommands } = useMachineApi();
  const machineSessions = useMachineSessions();
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [agentKind, setAgentKind] = useState(rememberedAgent);
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  // whether the model and the effort shown are the reader's own: one that is not follows Settings > Agents, and
  // never goes on to another agent
  const modelEdited = useRef(false);
  const effortEdited = useRef(false);
  const [ultracode, setUltracode] = useState(false);
  const [prompt, setPrompt] = useState("");
  const cwdEdited = useRef(false);
  const draftKey = newSessionDraftKey(machineId, tab);
  // Settings -> Custom agent groups: the group the new pane goes in ("": none), the folder's last one until one is picked
  const groupNames = settings.agentNamedGroups ? settings.agentGroupNames : [];
  const [group, setGroup] = useState("");
  const [groupPicked, setGroupPicked] = useState(false);
  // the skills the picked agent would offer in the folder, before any process exists (GET /api/agent/commands)
  const skillFolder = tab ? tab.cwd : cwd.trim() || null;
  const [skills, setSkills] = useAgentSkills(open, agentKind, skillFolder, fetchAgentCommands, t);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UserError | null>(null);
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [createdPaneId, setCreatedPaneId] = useState<string | null>(null);
  /** the made pane runs the agent asked for: Open shows it in the agent's lens */
  const [createdStarted, setCreatedStarted] = useState(false);
  /** the first message was not queued and waits in the made pane's chat box: Open shows the chat */
  const [createdKept, setCreatedKept] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  // Add another agent shows in place of the fields, which keep what was typed
  const [adding, setAdding] = useState(false);
  // the PC's agents read again after a setup: nothing is started until the picker shows the result
  const [refreshing, setRefreshing] = useState(false);
  // counts openings and closings, so an answer for an earlier opening changes nothing
  const openings = useRef(0);
  // the agent list as read last: the read as the dialog opened may answer after the one an install asked for
  const agentReads = useRef(latestRead());
  const [recentFolders, setRecentFolders] = useState(() => recentDirectories.read(machineId));
  // folders kept before worktrees and temporary folders were left out are left out here too
  const shownFolders = recentFolders.filter((path) => !passingFolder(path, worktrees)).slice(0, RECENT_FOLDERS_SHOWN);
  const firstFieldRef = useRef<HTMLButtonElement>(null);
  const promptField = useRef<HTMLTextAreaElement>(null);
  // one Start at a time, whatever the fields' disabled state has rendered yet: a double tap sends one create
  const guard = useRef(inFlightGuard());
  // a path longer than its field is shown from its end, where the folder's name is, whenever it is
  // set for the user (the last folder, a pick from Browse or a recent chip) and when the field is
  // left; typing keeps the caret in view by itself
  const cwdField = useRef<HTMLInputElement>(null);
  const showPathEnd = (): void => {
    const field = cwdField.current;
    if (field !== null) field.scrollLeft = field.scrollWidth;
  };
  useLayoutEffect(() => {
    if (open && document.activeElement !== cwdField.current) showPathEnd();
  }, [open, cwd]);
  // once the tab is made the keyboard is the new tab's: never handed back to the tab the dialog was opened over
  const made = useRef(false);
  useEffect(() => { if (open) made.current = false; }, [open]);
  const surface = useFocusTrap<HTMLFormElement>(open, { initialFocus: firstFieldRef, shouldRestore: () => !made.current });
  useSheetSwipe(surface, pending ? null : onClose);
  const defaultCwdRef = useRef(defaultCwd);
  defaultCwdRef.current = defaultCwd;
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;

  // The previous launch may have left disabled fields: reset them before the opening paint, while keeping
  // an unsent draft from an earlier dismiss on the same target.
  useLayoutEffect(() => {
    if (!open) return;
    const filled = prefillRef.current;
    const saved = readNewSessionDraft(draftKey);
    const nextCwd = filled?.cwd ?? (saved?.cwdEdited ? saved.cwd : null) ?? defaultCwdRef.current ?? "";
    cwdEdited.current = Boolean(filled?.cwd || saved?.cwdEdited);
    setCwd(nextCwd);
    setName(filled?.name ?? saved?.name ?? "");
    setUltracode(false);
    setPrompt(saved?.prompt ?? "");
    setGroupPicked(false);
    setSkills(null);
    setError(null);
    setCwdError(null);
    setPending(false);
    setCreatedPaneId(null);
    setCreatedStarted(false);
    setCreatedKept(false);
    setBrowsing(false);
    setAdding(false);
    setRefreshing(false);
    setRecentFolders(recentDirectories.read(machineId));
    const remembered = rememberedAgent();
    const stored = filled?.agent ?? remembered;
    setAgentKind(stored);
    // the model and effort Settings > Agents sets for the agent, each still the reader's to change; none set is the agent's own
    const preset = launchDefaults(stored, settings);
    setModel(preset.model);
    setEffort(preset.effort);
    modelEdited.current = false;
    effortEdited.current = false;
    let cancelled = false;
    const latest = agentReads.current();
    void fetchAgentKinds()
      .then((next) => {
        if (cancelled || !latest()) return;
        setAgents(next);
        // a linked agent herdr does not offer gives way to the last one picked, as an unknown remembered one does to a shell
        if (stored && !next.some((agent) => agent.kind === stored)) {
          const kind = stored !== remembered && next.some((agent) => agent.kind === remembered) ? remembered : "";
          setAgentKind(kind);
          // what was chosen meanwhile for the agent that gave way goes as pickAgent's choices go
          const can = launchCapabilities(kind);
          const fallback = launchDefaults(kind, settings);
          modelEdited.current = false;
          setModel(fallback.model);
          const picked = effortEdited.current && fallback.effort === "";
          effortEdited.current = picked;
          setEffort((current) => fallback.effort !== "" ? fallback.effort : picked && can.efforts.includes(current) ? current : "");
          if (!can.ultracode) setUltracode(false);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled && latest()) setError(userErrorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // the folder's last group, as the folder changes, until the reader picks one
  const groupFolder = tab ? tab.cwd : cwd;
  const groupKey = groupNames.join("\n");
  useEffect(() => {
    if (open && !groupPicked) setGroup(folderAgentGroup(machineId, groupFolder, groupNames) ?? "");
  }, [open, groupPicked, machineId, groupFolder, groupKey]);

  useEffect(() => {
    if (!open) return;
    writeNewSessionDraft(draftKey, { cwd, cwdEdited: cwdEdited.current, name, prompt });
  }, [open, draftKey, cwd, name, prompt]);

  useEffect(() => {
    if (!open || !onDraft) return;
    const timer = window.setTimeout(() => onDraft({ cwd: cwd || null, name: name || null, agent: agentKind }), DRAFT_MS);
    return () => window.clearTimeout(timer);
  }, [open, onDraft, cwd, name, agentKind]);


  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // a native modal over it (Add PC, from the palette) takes its own Escape
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      // Settings opened over it with its shortcut holds the focus: its Escape, though this listener runs first
      if (focusInOtherModal(surface.current)) return;
      event.preventDefault();
      if (!pending) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, pending]);

  useLayoutEffect(() => { openings.current += 1; }, [open]);

  // back from Add another agent, the focus returns to the picker it was opened from
  const wasAdding = useRef(false);
  // (after a setup, once the refreshed picker is enabled again)
  useEffect(() => {
    if (adding) { wasAdding.current = true; return; }
    if (wasAdding.current && !refreshing) { wasAdding.current = false; firstFieldRef.current?.focus(); }
  }, [adding, refreshing]);

  // the read-again loop after Add another agent… installs one (addedAgent below): stopped on close,
  // reopen and unmount
  const readingAgain = useRef<() => void>(() => undefined);
  useEffect(() => () => readingAgain.current(), []);
  useEffect(() => { readingAgain.current(); }, [open]);

  // Settings > Agents changed while the dialog is open (the shared settings arriving, or Settings opened over it):
  // a field the reader left follows it
  const defaults = launchDefaults(agentKind, settings);
  useEffect(() => {
    if (!open) return;
    if (!modelEdited.current) setModel(defaults.model);
    if (!effortEdited.current) setEffort(defaults.effort);
  }, [open, agentKind, defaults.model, defaults.effort]);
  if (!open) return null;

  const selectedAgent = agents.find((agent) => agent.kind === agentKind);
  const agentLabel = selectedAgent?.label ?? agentKind;
  const pendingLabel = selectedAgent ? t("Starting {agent}… up to 60s", { agent: selectedAgent.label }) : t("Starting shell…");
  const fieldsDisabled = pending || refreshing || createdPaneId !== null;
  const can = launchCapabilities(agentKind);
  const launched = dialogLaunch({ agent: agentKind, model, effort, ultracode, prompt }, settings);
  const fault = "fault" in launched ? launched.fault : null;
  const launch = "fault" in launched ? null : launched;
  const suggestions = modelSuggestions(agentKind);
  // what the picker's rows say each launch takes: only the agents whose command line takes a model and a level
  const pickerHints = Object.fromEntries(agents.flatMap((agent) => {
    const takes = launchCapabilities(agent.kind);
    return takes.model && takes.efforts.length > 0 ? [[agent.kind, t("model, effort")]] : [];
  }));

  const pickAgent = (kind: string): void => {
    setAgentKind(kind);
    setSkills(null);
    // a choice the next agent's launch does not take goes back to the agent's own; a model names one agent's models
    const next = launchCapabilities(kind);
    let nextEffort = next.efforts.includes(effort) ? effort : "";
    if (kind !== agentKind) {
      // the next agent's model and effort from Settings > Agents; with no effort set there, a level the reader
      // picked stays where the agent names it, and the one set for the last agent does not
      const after = launchDefaults(kind, settings);
      modelEdited.current = false;
      setModel(after.model);
      if (after.effort !== "" || !effortEdited.current) { nextEffort = after.effort; effortEdited.current = false; }
    } else if (!next.model) setModel("");
    if (nextEffort === "") effortEdited.current = false;
    setEffort(nextEffort);
    if (!next.ultracode) setUltracode(false);
  };

  // the installed agent is offered once the PC lists it: picked then, else said why not
  // the installed agent is offered once the PC lists it: picked then. Its installer may still be
  // editing the shell profile the PC reads the PATH from: until then the dialog says why and reads
  // again, every READ_AGAIN_MS for about a minute (lib/latestRead.ts readAgainUntil)
  const addedAgent = (kind: string): void => {
    const opening = openings.current;
    setAdding(false);
    setRefreshing(true);
    readingAgain.current();
    // the fields stay off while it waits: nothing the user picks or starts meanwhile is overridden; each
    // read's outcome is taken once (a late answer after its deadline is ignored), and the last one,
    // a stalled read included, turns the fields back on
    readingAgain.current = readAgainUntil(() => { agentReads.current(); return fetchAgentKinds(); }, {
      every: READ_AGAIN_MS,
      times: READ_AGAIN_TIMES,
      later: (run, ms) => { const timer = window.setTimeout(run, ms); return () => window.clearTimeout(timer); },
      apply: (outcome, last) => {
        if (openings.current !== opening) return true;
        if (outcome.kind === "answer") {
          setAgents(outcome.value);
          if (outcome.value.some((agent) => agent.kind === kind)) { pickAgent(kind); setError(null); setRefreshing(false); return true; }
        }
        if (!last) { setError({ message: t("It is installed. Waiting for this PC to offer it here…"), detail: null }); return false; }
        if (outcome.kind === "failed") setError(userErrorMessage(outcome.reason));
        else setError({ message: t("It is installed, but this PC does not offer it here yet. Restart Ovis on the PC, or start it in a terminal tab."), detail: null });
        setRefreshing(false);
        return true;
      },
    });
  };

  const insertSkill = (skill: SlashCommand): void => {
    const field = promptField.current;
    const at = field !== null && document.activeElement === field ? field.selectionEnd : prompt.length;
    const next = insertToken(prompt, at, skillToken(skill));
    // committed now and the caret placed in the same task, as the composer's completions are: a
    // placement deferred to the next frame would land behind a key typed right after the tap
    flushSync(() => setPrompt(next.text));
    const box = promptField.current;
    if (box === null) return;
    box.focus();
    box.setSelectionRange(next.caret, next.caret);
  };

  const startWorkspace = async (directory: string): Promise<void> => {
    if (pending || refreshing || guard.current.busy()) return;
    if (createdPaneId !== null) { onCreated(createdPaneId, createdStarted, createdKept); return; }
    // a combination the launch does not take: Start is disabled for it, and an Enter in a field sends nothing
    if (launch === null) return;
    setPending(true);
    setError(null);
    setCwdError(null);
    // a tab keeps the workspace's folder, which the dialog shows and does not ask for. The first message of an
    // agent whose command line does not take it rides on this request: the bridge queues it for the agent's first
    // ready turn and types it through this page's connection, so this page never types it itself
    const request = createRequest({ tab, directory, name }, launch, machineSessions?.peek(machineId)?.connection ?? null);
    const started = startNewSession(guard.current, request, async (body) => {
      rememberAgent(agentKind);
      return tab ? await createTab({ ...body, workspace_id: tab.workspaceId }) : await createWorkspace(body);
    });
    if (started === null) { setPending(false); return; }
    // a plain terminal takes what is typed while it starts (lib/typeAhead.ts); an agent's first words go in its message
    const ahead = agentKind === "" ? catchTypeAhead() : null;
    try {
      const result = await started;
      // the pane is made, whatever came of its agent: it goes in the group picked, from the groups as last saved
      // (only while the field is offered: with the setting off, the folder's last group is kept for later)
      if (groupNames.length > 0) {
        const picked = groupNames.includes(group) ? group : null;
        rememberFolderAgentGroup(machineId, tab ? tab.cwd : directory, picked);
        // No group clears a group the pane's id still had from a pane gone before it (herdr reuses ids)
        const held = loadSettings().agentGroupOf;
        const kept = groupKept?.(held);
        const next = assignAgentGroup(held, sidebarPinKey(machineId, result.pane_id), picked, kept === undefined ? undefined : (key) => kept.has(key));
        if (next !== null && JSON.stringify(next) !== JSON.stringify(held)) updateSettings({ agentGroupOf: next });
      }
      if (agentKind && !result.agent_started && result.error?.message) {
        ahead?.drop();
        setPending(false);
        writeNewSessionDraft(draftKey, null);
        // the workspace exists: say so plainly, keep the PC's own words beneath, and Open it rather than make another
        setError({ message: t("The workspace opened, but {agent} did not start. Check that it is installed on the PC, then open it again.", { agent: agentLabel }), detail: result.error.message });
        setCreatedPaneId(result.pane_id);
        return;
      }
      if (!tab && (!agentKind || result.agent_started)) {
        setRecentFolders(recentDirectories.remember(machineId, [directory.trim()], true));
      }
      const outcome = firstMessageOutcome(request, result);
      if (outcome.kind === "not_queued") {
        // the agent runs without its first message: the text waits in the new tab's message box, and the dialog says so
        composerDrafts.set(`ovis:composer-draft:${paneStorageId(machineId, result.pane_id)}`, request.first_message!);
        writeNewSessionDraft(draftKey, null);
        setPending(false);
        setError({
          message: outcome.error
            ? t("{agent} started, but its first message was not queued. It is in the new tab's message box: open the tab and send it.", { agent: agentLabel })
            : t("{agent} started, but this PC's bridge does not take a first message yet. It is in the new tab's message box: open the tab and send it.", { agent: agentLabel }),
          detail: outcome.error?.message ?? null,
        });
        setCreatedPaneId(result.pane_id);
        setCreatedStarted(true);
        setCreatedKept(true);
        return;
      }
      // the new tab takes its label from the first message, however it reaches the agent (#2019)
      if (settings.autoTabNames && agentKind !== "" && result.agent_started) learnTabLabel(machineId, result.pane_id, prompt);
      const messageWaits = outcome.kind === "queued";
      // the dialog closes on this: left pending, its next opening would start a frame with the
      // fields disabled and Escape ignored, until the open effect's reset has rendered
      writeNewSessionDraft(draftKey, null);
      setPending(false);
      ahead?.handTo(machineId, result.pane_id);
      made.current = true;
      onCreated(result.pane_id, agentKind !== "" && result.agent_started !== false, messageWaits);
    } catch (reason: unknown) {
      ahead?.drop();
      setPending(false);
      // a new tab shows its folder without a field to mark: the dialog's own alert says it is gone
      if (reason instanceof ApiError && reason.code === "invalid_cwd" && tab) setError({ message: t("Directory not found"), detail: null });
      else if (reason instanceof ApiError && reason.code === "invalid_cwd") {
        setCwdError(t("Directory not found"));
        cwdField.current?.focus();
      } else setError(userErrorMessage(reason));
    }
  };

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };

  const cancelDialog = (): void => {
    writeNewSessionDraft(draftKey, null);
    onClose();
  };

  const updateCwd = (nextCwd: string): void => {
    cwdEdited.current = true;
    setCwd(nextCwd);
    setCwdError(null);
  };

  const promptHint = launch?.prompt?.via === "positional" || (prompt.trim() === "" && can.positionalPrompt)
    ? t("Sent to {agent} as it starts.", { agent: agentLabel })
    : t("Queued for {agent}'s first turn: sent once it is ready, shown as a pending message until then.", { agent: agentLabel });

  const pcTitle = machineName ?? machineId;
  const dialogTitle = adding && !watching
    ? t("Install an agent · {name}", { name: pcTitle })
    : tab
      ? `${t("New tab")} · ${tab.workspaceLabel}`
      : `${t("New workspace")} · ${pcTitle}`;
  const tabFolder = tab ? (tab.cwd ?? tab.workspaceLabel) : "";

  return (
    <div className="modal-scrim new-session-scrim" onMouseDown={closeFromScrim}>
      <form ref={surface} className="modal new-session-modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title" tabIndex={-1} onSubmit={(event) => { event.preventDefault(); void startWorkspace(cwd); }}>
        <header className="modal-header">
          <h2 className="modal-title" id="new-session-title" title={dialogTitle}>{dialogTitle}</h2>
          <button type="button" className="icon-button" aria-label={t("Close dialog")} title={t("Close dialog")} disabled={pending} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        {adding && !watching ? <div className="modal-body">
          <AddAgentPanel onReady={addedAgent} onOpenTerminal={(paneId) => { if (onOpenPane) onOpenPane(paneId); else onClose(); }} onBack={() => setAdding(false)} />
        </div> : <><div className="modal-body">
          <div className="field">
            <span className="field-label" id="new-session-agent">{t("Agent")}</span>
            <AgentPicker ref={firstFieldRef} agents={agents} value={agentKind} disabled={fieldsDisabled} labelledBy="new-session-agent" hints={pickerHints} addAgent={watching ? undefined : { label: t("Add another agent…"), onSelect: () => setAdding(true) }} onChange={pickAgent} />
          </div>
          {tab ? (
            <div className="field">
              <span className="field-label">{t("Directory")}</span>
              <div className="new-session-folder" title={tabFolder}>
                <FolderOpen aria-hidden="true" />
                <span title={tabFolder}><span dir="ltr">{tabFolder}</span></span>
              </div>
            </div>
          ) : (
            <div className="field">
              <label className="field-label" htmlFor="new-session-cwd">{t("Directory")}</label>
              <div className="new-session-cwd">
                <input
                  ref={cwdField}
                  id="new-session-cwd"
                  className="input"
                  value={cwd}
                  placeholder="~/projects/app"
                  disabled={fieldsDisabled}
                  autoComplete="off"
                  aria-invalid={cwdError !== null || undefined}
                  aria-describedby="new-session-cwd-hint"
                  onChange={(event) => updateCwd(event.target.value)}
                  onBlur={showPathEnd}
                />
                <button type="button" className="btn" aria-expanded={browsing} disabled={fieldsDisabled} onClick={() => setBrowsing((open) => !open)}>
                  <FolderOpen aria-hidden="true" />
                  {t("Browse")}
                </button>
              </div>
              {/* Browse updates Directory as you open folders, so Start uses what the path bar shows
                  even when Use this folder was never pressed (issue #1162); a folder under home
                  keeps the `~/…` form typed or picked, rather than turning absolute on opening Browse. */}
              {browsing && <DirectoryBrowser start={cwd} onPick={(picked) => { updateCwd(picked); setBrowsing(false); }} onFolder={(path, home) => updateCwd(homeRelative(path, home))} />}
              <span id="new-session-cwd-hint" className={`field-hint${cwdError !== null ? " new-session-error" : ""}`} role={cwdError !== null ? "alert" : undefined}>
                {cwdError ?? t("absolute path or ~/…")}
              </span>
            </div>
          )}
          {!tab && shownFolders.length > 0 && <div className="field new-session-recents">
            <span className="field-label" id="new-session-recents">{t("Recent folders")}</span>
            <RecentFolderChips folders={shownFolders} disabled={fieldsDisabled} labelledBy="new-session-recents" basename={directoryBasename}
              onPick={(path) => { updateCwd(path); setBrowsing(false); }} />
          </div>}
          <label className="field">
            <span className="field-label">{t(tab ? "Tab name (optional)" : "Optional workspace label")}</span>
            <input
              className="input"
              value={name}
              maxLength={MAX_LABEL_CHARS}
              disabled={fieldsDisabled}
              autoComplete="off"
              placeholder={tab ? String(tab.number) : directoryBasename(cwd)}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {groupNames.length > 0 && <div className="field">
            <label className="field-label" htmlFor="new-session-group">{t("Group")}</label>
            <select id="new-session-group" className="select" value={group} disabled={fieldsDisabled} onChange={(event) => { setGroup(event.target.value); setGroupPicked(true); }}>
              <option value="">{t("No group")}</option>
              {groupNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <span className="field-hint">{t("Where the Agents list shows it")}</span>
          </div>}
          {/* the launch's own choices, only where the agent's command line takes them (lib/agentLaunchMode.ts) */}
          {(can.model || can.efforts.length > 0) && <div className="new-session-launch">
            {can.model && <div className="field">
              <label className="field-label" htmlFor="new-session-model">{t("Model")}</label>
              <input
                id="new-session-model"
                className="input"
                value={model}
                list={suggestions.length > 0 ? "new-session-models" : undefined}
                disabled={fieldsDisabled}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={t("Agent default")}
                aria-invalid={fault === "model" || undefined}
                aria-describedby="new-session-model-hint"
                onChange={(event) => { modelEdited.current = true; setModel(event.target.value); }}
              />
              {suggestions.length > 0 && <datalist id="new-session-models">{suggestions.map((alias) => <option key={alias} value={alias} />)}</datalist>}
              <span id="new-session-model-hint" className={`field-hint${fault === "model" ? " new-session-error" : ""}`} role={fault === "model" ? "alert" : undefined}>
                {fault === "model" ? t("One model name, without spaces.") : t("Empty: the agent's own model.")}
              </span>
            </div>}
            {can.efforts.length > 0 && <div className="field">
              <label className="field-label" htmlFor="new-session-effort">{t("Effort")}</label>
              <select id="new-session-effort" className="select" value={effort} disabled={fieldsDisabled} aria-describedby="new-session-effort-hint" onChange={(event) => { effortEdited.current = true; setEffort(event.target.value); }}>
                <option value="">{t("Agent default")}</option>
                {can.efforts.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
              <span id="new-session-effort-hint" className="field-hint">{t("Levels depend on the model.")}</span>
            </div>}
          </div>}
          {/* Claude Code's own term, a setting beside the level rather than one of them, on one line under Model and
              Effort; the whole sentence is the switch's description and the line's tooltip; off adds nothing */}
          {can.ultracode && <div className="new-session-ultracode" title={t("Dynamic workflows at any effort level. Needs Claude Code 2.1.284 or later.")}>
            <Toggle id="new-session-ultracode" checked={ultracode} label={t("Ultracode")} disabled={fieldsDisabled} describedBy="new-session-ultracode-hint" onChange={setUltracode} />
            <label className="new-session-ultracode-label" htmlFor="new-session-ultracode">{t("Ultracode")}</label>
            <span className="new-session-ultracode-note" aria-hidden="true">{t("Claude Code 2.1.284 or later")}</span>
            <span id="new-session-ultracode-hint" className="visually-hidden">{t("Dynamic workflows at any effort level. Needs Claude Code 2.1.284 or later.")}</span>
          </div>}
          {agentKind !== "" && <div className="field">
            <label className="field-label" htmlFor="new-session-prompt">{t("First message")}</label>
            <textarea
              ref={promptField}
              id="new-session-prompt"
              className="input new-session-prompt"
              value={prompt}
              rows={3}
              maxLength={MAX_COMPOSER_CHARS}
              disabled={fieldsDisabled}
              placeholder={t("Optional")}
              aria-describedby="new-session-prompt-hint"
              onChange={(event) => setPrompt(event.target.value)}
            />
            <span id="new-session-prompt-hint" className="field-hint">{promptHint}</span>
            {/* the agent's skills in the folder, before it runs: a tap puts the skill's token in the message */}
            {skills !== null && (skills.rows.length > 0 || skills.note !== null) && <div className="new-session-skills-field">
              <span className="field-label" id="new-session-skills">{t("Skills")}</span>
              {skills.rows.length > 0 && <div className="new-session-skills" role="group" aria-labelledby="new-session-skills">
                {skills.rows.map((skill) => (
                  <button
                    type="button"
                    key={skillToken(skill)}
                    className="btn new-session-skill-chip"
                    disabled={fieldsDisabled}
                    title={skill.description}
                    aria-label={t("Add {skill} to the message", { skill: skillToken(skill) })}
                    onClick={() => insertSkill(skill)}
                  >
                    {skillToken(skill)}
                  </button>
                ))}
              </div>}
              {skills.note !== null && <span className="field-hint">{skills.note}</span>}
            </div>}
            {skills !== null && skills.rows.length === 0 && skills.note === null && <span className="field-hint">{t("No skills for {agent} in this folder.", { agent: agentLabel })}</span>}
          </div>}
          <p className="new-session-note" role="status" aria-live="polite">{pending ? pendingLabel : null}</p>
          {error && <p className="field-hint new-session-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={cancelDialog}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary new-session-submit" disabled={pending || refreshing || fault !== null}>{t(pending ? "Starting…" : createdPaneId !== null ? "Open" : "Start")}</button>
        </footer></>}
      </form>
    </div>
  );
}
