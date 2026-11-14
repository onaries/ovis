/**
 * What the inbox mode says of an agent in words (components/InboxList.tsx, components/InboxMode.tsx): its state's
 * word, and the one muted line of its row.
 */
import type { AgentGroup } from "./agentRoster.ts";
import type { Translate } from "./i18n.ts";

/** A state's word: the Agents list's own heading for the three states its filters name, and Ready for an agent at rest. */
export function inboxStateWord(group: AgentGroup, t: Translate): string {
  switch (group) {
    case "blocked": return t("Needs you");
    case "working": return t("Working");
    case "done": return t("Done");
    case "idle": return t("Ready");
  }
}

/** The rows that ask for a look: their line is drawn one step stronger, as a messenger darkens an unread one. */
export function inboxAsks(group: AgentGroup): boolean {
  return group === "blocked" || group === "done";
}

/**
 * A row's one muted line. The agent's own words when it has some; else its state's word, and for an agent at rest
 * the place it runs in (`place`, empty when the row's name already says it); a finished turn whose last request
 * failed (`failed`) says so, never Done. With more than one PC shown the PC's name (`machine`) leads the line, and
 * a PC that is away says so in the words' place.
 */
export function inboxRowLine(input: { online: boolean; group: AgentGroup; words: string | null; place: string; machine: string | null; failed?: boolean }, t: Translate): string {
  const said = !input.online ? t("Offline")
    : input.words ?? (input.failed ? t("Turn failed") : input.group === "idle" && input.place !== "" ? input.place : inboxStateWord(input.group, t));
  return input.machine === null ? said : `${input.machine} · ${said}`;
}
