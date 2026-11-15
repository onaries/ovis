/**
 * The inbox mode's rail (from 769px): one narrow column of icon buttons at the far left of the mode's column, before
 * its list, holding the mode's ways out and around. It is a part of the column (App.tsx), cut out of the sidebar's
 * width (InboxMode.css), so the pane beside the column is where the classic shell has it. A window under 769px
 * draws no rail: its list keeps its own controls.
 *
 * At its top: the way out and the mode's one place. Pushed to its foot: the agents that wait, this device's alerts,
 * Settings and the PCs. Each of them is here and nowhere else in the wide layout: the column has no More and no foot.
 * It draws no magnifier: the list's search field is the screen's one, and the command palette is under its shortcut
 * and the thread's More (App.tsx). A button says what it is in its name and its tooltip; no label is drawn.
 */
import { useState } from "react";
import { Bell, BellOff, CircleHelp, Inbox, Monitor, MonitorOff, Settings } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import type { HeaderConnection } from "../lib/headerConnection.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { OvisMark } from "./OvisMark.tsx";
import { RowMenu } from "./RowMenu.tsx";
import "./InboxRail.css";

/** What the rail says of the PCs: which ones this device shows, and how the page stands with them. */
export interface InboxRailPcs {
  /** the PCs this device shows, as the list beside the rail draws their agents */
  machines: readonly Machine[];
  /** the PC the app is on: the one marked in the list of them */
  selectedId: string;
  /** what the stream that feeds the list's rows has to say (lib/useMachineRoster.ts): lost after the page had it, or just back */
  connection: HeaderConnection;
  /** the open thread's chip says that same word: the rail then draws no dot for it and announces nothing (one fact, one place) */
  saidByThread: boolean;
  /** opens another connected PC, as the classic app does: on that PC, with no thread chosen */
  onSelect(machineId: string): void;
}

export interface InboxRailProps {
  /** out of the mode, to the classic app on the pane of the open thread: the mark at the rail's top */
  onExit(): void;
  /** to the list's top, with the keyboard's focus on the list: the mode's one place, which is always the current one */
  onInbox(): void;
  /** the agents that wait other than the open thread's, and the press that opens the next of them; null while none waits */
  waiting: { count: number; open(): void } | null;
  /** this device's alerts (lib/alertsBell.ts): whether they are on, the sentence that says how, and the press that switches them */
  alerts: { on: boolean; title: string; toggle(): void };
  onSettings(): void;
  pcs: InboxRailPcs;
  /** a tooltip with its shortcut's keys after it, where one is set (App.tsx) */
  shortcutTitle(label: string, id: "settings"): string;
}

type PcState = "connected" | "reconnecting" | "offline";

/**
 * How a PC stands, as the mode says it: reconnecting while the page has lost the stream its rows come from (nothing
 * it shows of any PC is current then) or while the PC itself is being reached again; connected; and offline for every
 * other PC, as its rows in the list say.
 */
function pcState(machine: Machine, connection: HeaderConnection): PcState {
  if (connection === "reconnecting" || machine.state === "reconnecting") return "reconnecting";
  return machine.state === "connected" ? "connected" : "offline";
}

function pcWord(state: PcState, t: Translate): string {
  switch (state) {
    case "connected": return t("Connected");
    case "reconnecting": return t("Reconnecting…");
    case "offline": return t("Offline");
  }
}

/** The PC button's name and tooltip: the one PC and its state, or how many of several are connected. */
function pcsLabel({ machines, connection }: InboxRailPcs, t: Translate): string {
  const [first] = machines;
  if (first === undefined) return t("PCs");
  if (machines.length === 1) return `${t("PC {name}", { name: first.name })} · ${pcWord(pcState(first, connection), t)}`;
  if (connection === "reconnecting") return `${t("PCs")} · ${pcWord("reconnecting", t)}`;
  return t("PCs, {n} of {m} connected", { n: machines.filter((machine) => machine.state === "connected").length, m: machines.length });
}

export function InboxRail({ onExit, onInbox, waiting, alerts, onSettings, pcs, shortcutTitle }: InboxRailProps) {
  const t = useT();
  const AlertsGlyph = alerts.on ? Bell : BellOff;
  const [pcMenu, setPcMenu] = useState<HTMLElement | null>(null);
  const { machines, selectedId, connection, saidByThread, onSelect } = pcs;
  const pcLabel = pcsLabel(pcs, t);
  // a struck monitor only while every PC is away: one that is connected, or being reached again, is a PC to wait for
  const PcGlyph = machines.length > 0 && machines.every((machine) => pcState(machine, connection) === "offline") ? MonitorOff : Monitor;
  // The dot is drawn only while the connection has something to say, and where nothing else says it: the word the
  // wide list's own line said before the rail took it. The same word is announced from a line that is in the
  // document before it (lib/useAnnouncedText.ts): a button's name is not read out when it changes.
  const dot = saidByThread ? null : connection;
  const announced = useAnnouncedText(dot === null ? null : pcWord(dot, t));
  return (
    <nav className="inbox-rail" aria-label={t("Inbox mode")}>
      <div className="inbox-rail-group is-top">
        <button type="button" className="icon-button inbox-rail-item inbox-rail-exit" aria-label={t("Back to Ovis")} title={t("Back to Ovis")} onClick={onExit}>
          <OvisMark width="22" height="22" className="inbox-rail-mark" />
        </button>
        <button type="button" className="icon-button inbox-rail-item inbox-rail-place" aria-label={t("Agent inbox")} title={t("Agent inbox")} aria-current="page" onClick={onInbox}>
          <Inbox aria-hidden="true" />
        </button>
      </div>
      <div className="inbox-rail-group is-lower">
        {/* the first of the lower group, so nothing under it moves when it comes or goes; the pill is the app's own
            waiting pill, which says nothing to a screen reader: the button's name says the number */}
        {waiting !== null && (
          <button type="button" className="icon-button inbox-rail-item inbox-rail-waiting" aria-label={t("{count} waiting for you", { count: waiting.count })} title={t("Open the next session waiting for you")} onClick={waiting.open}>
            <CircleHelp aria-hidden="true" />
            <span className="header-more-dot is-waiting" data-count={waiting.count} aria-hidden="true" />
          </button>
        )}
        {/* off is another glyph, not a colour: the switch says its state by shape, and to a screen reader as pressed */}
        <button type="button" className="icon-button inbox-rail-item inbox-rail-alerts" aria-label={t("Alerts")} title={alerts.title} aria-pressed={alerts.on} onClick={alerts.toggle}>
          <AlertsGlyph aria-hidden="true" />
        </button>
        <button type="button" className="icon-button inbox-rail-item inbox-rail-settings" aria-label={t("Settings")} title={shortcutTitle(t("Settings"), "settings")} onClick={onSettings}>
          <Settings aria-hidden="true" />
        </button>
        {/* nothing to list before the first roster is in: the button keeps its place and takes no press */}
        <button type="button" className="icon-button inbox-rail-item inbox-rail-pcs" aria-label={pcLabel} title={pcLabel} aria-haspopup="menu" aria-expanded={pcMenu !== null}
          disabled={machines.length === 0} onClick={(event) => setPcMenu(pcMenu === null ? event.currentTarget : null)}>
          <PcGlyph aria-hidden="true" />
          {dot !== null && <span className={`inbox-rail-dot is-${dot}`} aria-hidden="true" />}
        </button>
      </div>
      <p className="visually-hidden" role="status">{announced}</p>
      {/* One row per PC: its name, its state in words, the one the app is on marked. A press opens another connected
          PC; the one the app is on is already open, and a PC that is away opens nothing, as its rows in the list:
          by the PC's own state, so a lost stream, which every row says, takes no row away. */}
      {pcMenu !== null && <RowMenu anchor={pcMenu} title={t("PCs")} align="start" onClose={() => setPcMenu(null)}
        items={machines.map((machine) => {
          const state = pcState(machine, connection);
          return {
            id: machine.id, label: machine.name, hint: pcWord(state, t), icon: state === "offline" ? MonitorOff : Monitor,
            current: machine.id === selectedId, disabled: machine.state !== "connected",
            run: () => { if (machine.id !== selectedId) onSelect(machine.id); },
          };
        })} />}
    </nav>
  );
}

/** The rail's surface at its width, with no control: what the mode's shell draws before anything answers. */
export function InboxRailBlank() {
  return <div className="inbox-rail" />;
}
