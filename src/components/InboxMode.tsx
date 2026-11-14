/**
 * What the inbox mode's shell draws around a thread (App.tsx decides where; the list is InboxList.tsx): a phone
 * thread's title in the app's header, and from 769px the zone that floats over the pane (the name chip and the
 * thread's round controls) and the line that stands in a pane with no thread. Each piece is one of the app's own
 * primitives with its tokens.
 */
import { useMemo, type CSSProperties, type ReactNode } from "react";
import { Inbox } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { inboxStatus } from "../lib/agentInbox.ts";
import { agentGroup, agentRoster } from "../lib/agentRoster.ts";
import type { HeaderConnection } from "../lib/headerConnection.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { inboxStateWord } from "../lib/inboxRow.ts";
import { agentName } from "../lib/runtimeMove.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";
import { paneMark } from "../lib/sidebarAgents.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { agentRowTitle } from "./AgentSidebar.tsx";
import { InboxAvatar } from "./InboxList.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import "./InboxMode.css";

export interface ThreadProps {
  /** every PC of the roster: a thread may be a pane of a PC this device hides from its lists */
  machines: readonly Machine[];
  activity: SidebarActivity;
  machineId: string;
  pane: HerdrPane;
  /** the connection's own word, which stands in the state's place while it has something to say */
  connection: HeaderConnection;
  watching: boolean;
  /** more than one PC is shown: the PC's name stands before the state's word */
  severalPcs: boolean;
}

/** What a thread says of its agent: the mark and the name its row in the list draws, and its state in words. */
function threadFacts({ machines, activity, machineId, pane, connection, watching, severalPcs }: ThreadProps, t: Translate) {
  const machine = machines.find((candidate) => candidate.id === machineId);
  const row = agentRoster(machines, { byActivity: false, seqs: activity.seqs, pinned: [] }).rest
    .find((candidate) => candidate.machine.id === machineId && candidate.entry.pane.pane_id === pane.pane_id);
  // a pane that runs no agent is named as its tab is, and is the terminal it shows
  const state = machine !== undefined && machine.state !== "connected" ? t("Offline")
    : row ? inboxStateWord(agentGroup(inboxStatus(row, activity)), t) : t("Terminal");
  const said = connection !== null ? t(connection === "connected" ? "Connected" : "Reconnecting…")
    : [watching ? t("View only") : null, severalPcs && machine ? machine.name : null, state].filter((part) => part !== null).join(" · ");
  return {
    name: row ? agentRowTitle(row, false).title : displayPaneTitle(pane),
    kind: row?.entry.canonicalAgent ?? null,
    mark: row ? paneMark(row.entry) ?? "" : null,
    said,
  };
}

/**
 * A phone thread's title, in the header between Back and the monitor button: the agent's mark, its name over one
 * line that says its state, as the classic header says the place under a pane's title.
 */
export function ThreadTitle(props: ThreadProps) {
  const t = useT();
  const { machines, activity, machineId, pane, connection, watching, severalPcs } = props;
  const { name, kind, mark, said } = useMemo(() => threadFacts({ machines, activity, machineId, pane, connection, watching, severalPcs }, t), [machines, activity, machineId, pane, connection, watching, severalPcs, t]);
  return (
    <div className="thread-title" title={name}>
      <InboxAvatar mark={mark} />
      <div className="thread-title-words">
        <span className="thread-name">{kind && <span className="visually-hidden">{agentName(kind)}: </span>}{name}</span>
        <span className={`thread-state${connection === null ? "" : ` is-${connection}`}`}>{said}</span>
      </div>
    </div>
  );
}

/**
 * The wide thread's name chip: the mark, the name and, after it, the state's word. It floats centred over the pane
 * where the classic shell has a header, and is not a control.
 */
function ThreadChip(props: ThreadProps) {
  const t = useT();
  const { machines, activity, machineId, pane, connection, watching, severalPcs } = props;
  const { name, kind, mark, said } = useMemo(() => threadFacts({ machines, activity, machineId, pane, connection, watching, severalPcs }, t), [machines, activity, machineId, pane, connection, watching, severalPcs, t]);
  return (
    <div className="thread-chip" title={name}>
      <InboxAvatar mark={mark} />
      <span className="thread-chip-name">{kind && <span className="visually-hidden">{agentName(kind)}: </span>}{name}</span>
      <span className={`thread-chip-state${connection === null ? "" : ` is-${connection}`}`}>{said}</span>
    </div>
  );
}

/**
 * The zone over the wide pane: the chip on the pane's middle and the thread's controls at its end, on one centre
 * line with the column's top controls. `thread` is null where no chip is drawn (no agent chosen, or the shell's
 * note stands in its place); the note's status line is there either way, as it is in the classic header.
 */
export function ThreadTop({ thread, note, controls }: { thread: ThreadProps | null; note: ReactNode; controls: ReactNode }) {
  return (
    <div className={`thread-top${thread === null && controls === null ? " is-empty" : ""}`}>
      <div className="thread-top-middle">
        {note}
        {thread !== null && <ThreadChip {...thread} />}
      </div>
      {controls !== null && <div className="thread-top-controls">{controls}</div>}
    </div>
  );
}

/**
 * The mode's shell before the app knows whether this device may open it (App.tsx): what a page that opens on the
 * mode's own address paints first. The list's surface with one line where its rows will be, the screen on a phone
 * and the column beside an empty pane from 769px, at the width the column will have. No control is drawn: nothing
 * answers yet. Never the classic shell's header or sidebar, which a page that opens in the mode never shows.
 */
export function InboxConnecting({ wide, sidebarWidth = null }: { wide: boolean; sidebarWidth?: number | null }) {
  const t = useT();
  const shown = useAnnouncedText(t("Connecting to Ovis…"));
  const list = (
    <section className={`mode-inbox${wide ? " is-wide" : ""}`} aria-label={t("Agent inbox")}>
      <div className="inbox-top" />
      <div className="inbox-scroll"><p className={shown === null ? "visually-hidden" : "inbox-empty"} role="status">{shown}</p></div>
      <div className="inbox-foot" />
    </section>
  );
  return (
    <div className={`app${wide ? "" : " sidebar-collapsed"} is-inbox ${wide ? "is-inbox-wide" : "is-inbox-list"}`}
      style={wide && sidebarWidth !== null ? { "--sidebar-user-w": `${sidebarWidth}px` } as CSSProperties : undefined}>
      <div className="app-body">
        {wide && <aside className="sidebar inbox-column">{list}</aside>}
        <div className="pane-column"><div className="pane-split">{!wide && list}</div></div>
      </div>
    </div>
  );
}

/** A wide pane with no agent chosen: the one line that stands where the thread would. */
export function InboxUnchosen() {
  const t = useT();
  return <p className="inbox-unchosen" role="status">{t("Choose one from the list to open its chat here.")}</p>;
}

/** The way into the mode at the sidebar's foot (a phone's drawer's): a row of the footer's own, above its gear. */
export function InboxFootEntry({ onOpen }: { onOpen(): void }) {
  const t = useT();
  return (
    <button type="button" className="btn btn-ghost sidebar-footer-action sidebar-footer-pc inbox-foot-entry" onClick={onOpen}>
      <Inbox aria-hidden="true" />
      <span className="sidebar-footer-pc-name">{t("Open agent inbox")}</span>
    </button>
  );
}
